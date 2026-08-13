import * as fs from 'node:fs';
import * as path from 'node:path';
import brandsData from '../src/data/brands.json' with { type: 'json' };
import {
  BRAND_ENRICHMENT_FIELDS,
  isEnrichedBrandContent,
  readBrandRecord,
  slugifyBrand,
  validateBrandContent,
} from '../src/lib/brand-content.js';

const AI_API_URL = process.env.AI_API_URL || 'https://ai.izdrail.com';
const AI_MODEL = process.env.AI_MODEL || 'hf.co/laravelcompany/laravelseo:latest';

function parseBoolean(value) {
  if (value == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readOption(args, name) {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  return process.env[`npm_config_${name.replace(/-/g, '_')}`] || null;
}

function hasFlag(args, name) {
  return args.includes(`--${name}`)
    || parseBoolean(process.env[`npm_config_${name.replace(/-/g, '_')}`]);
}

function cleanJson(text) {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateWithAI(prompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${AI_API_URL.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: AI_MODEL,
          prompt,
          stream: false,
          format: 'json',
          options: { temperature: 0.2, num_predict: 3000 },
        }),
      });
      if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(`AI API error ${response.status}: ${responseBody.slice(0, 300)}`);
      }
      const payload = await response.json();
      return JSON.parse(cleanJson(payload.response));
    } catch (error) {
      if (attempt === retries) throw error;
      await sleep(1000);
    }
  }
}

const args = process.argv.slice(2);
const requestedSlug = readOption(args, 'brand');
const dryRun = hasFlag(args, 'dry-run');
const force = hasFlag(args, 'force');

if (!requestedSlug) {
  console.error('Usage: npm run generate:brand -- --brand=bmw [--dry-run] [--force]');
  process.exit(1);
}

const row = brandsData.find((brand) => slugifyBrand(brand[3]) === requestedSlug);
if (!row) {
  console.error(`Unknown brand slug: ${requestedSlug}`);
  process.exit(1);
}

const [, , referenceUrl, brandName] = row;
const existing = readBrandRecord(requestedSlug) || { name: brandName, slug: requestedSlug };
const modelsFile = path.join(process.cwd(), 'src', 'data', requestedSlug, 'models.json');
const models = fs.existsSync(modelsFile) ? JSON.parse(fs.readFileSync(modelsFile, 'utf-8')) : [];
const knownModels = Array.isArray(models) ? models.map((model) => model?.name).filter(Boolean).slice(0, 60) : [];
const reviewed = isEnrichedBrandContent(existing);
const requestedFields = force || !reviewed
  ? BRAND_ENRICHMENT_FIELDS
  : BRAND_ENRICHMENT_FIELDS.filter((field) => {
      const value = existing[field];
      return Array.isArray(value) ? value.length === 0 : value == null || value === '';
    });

if (requestedFields.length === 0 && !force) {
  console.log(`${requestedSlug}: no missing enrichment fields. Use --force to regenerate intentionally.`);
  process.exit(0);
}

const prompt = `Expand the existing ECU Docs manufacturer record and return ONLY valid JSON.

Manufacturer: ${brandName}
Slug: ${requestedSlug}
Existing AutoEvolution reference: ${referenceUrl}
Existing reviewed/legacy record: ${JSON.stringify(existing)}
Known models already present in ECU Docs: ${JSON.stringify(knownModels)}
Return only these fields: ${JSON.stringify(requestedFields)}

Rules:
- Keep content manufacturer-specific, concise and useful for automotive electronics research.
- Never invent ECU part numbers, pinouts, protocols, compatibility or technical specifications.
- Omit facts that cannot be established confidently.
- parent_company must be a distinct legal/corporate parent; omit it when the manufacturer is independent.
- common_ecu_manufacturers means third-party ECU suppliers, never the vehicle brand itself; omit the field without reliable evidence.
- related_brands must contain only existing ECU Docs brand slugs.
- faq must be an array of {"question":"...","answer":"..."} items grounded in visible page content.
- sources must be real http(s) URLs used to support factual or technical claims.
- Do not repeat existing fields that were not requested and do not include markdown.`;

if (dryRun) {
  console.log(JSON.stringify({ endpoint: `${AI_API_URL}/api/generate`, model: AI_MODEL, prompt }, null, 2));
  console.log('\nDry run only: no API request and no files written.');
  process.exit(0);
}

let generated;
try {
  generated = await generateWithAI(prompt);
} catch (error) {
  console.error(`AI generation failed: ${error.message}`);
  process.exit(1);
}

if (!generated || typeof generated !== 'object' || Array.isArray(generated)) {
  console.error('AI response must be a JSON object.');
  process.exit(1);
}

for (const field of Object.keys(generated)) {
  const value = generated[field];
  if (!requestedFields.includes(field)
    || value == null
    || (typeof value === 'string' && !value.trim())
    || (Array.isArray(value) && value.length === 0)) {
    delete generated[field];
  }
}

if (Object.keys(generated).length === 0) {
  const staleCandidate = path.join(process.cwd(), 'tmp', 'brand-candidates', `${requestedSlug}.json`);
  if (fs.existsSync(staleCandidate)) fs.unlinkSync(staleCandidate);
  console.log(`${requestedSlug}: the model returned no supported enrichment. No candidate was written.`);
  process.exit(0);
}

const candidate = { ...existing, ...generated, name: brandName, slug: requestedSlug };
const knownSlugs = new Set(brandsData.map((brand) => slugifyBrand(brand[3])));
const validation = validateBrandContent(candidate, {
  expectedSlug: requestedSlug,
  knownSlugs,
  requireExplicitSlug: true,
});

if (!validation.ok) {
  console.error('Generated candidate failed validation:');
  for (const message of validation.errors) console.error(`  - ${message}`);
  process.exit(1);
}

const outputDir = path.join(process.cwd(), 'tmp', 'brand-candidates');
fs.mkdirSync(outputDir, { recursive: true });
const outputFile = path.join(outputDir, `${requestedSlug}.json`);
fs.writeFileSync(outputFile, `${JSON.stringify(validation.value, null, 2)}\n`, 'utf-8');
console.log(`Candidate written to ${path.relative(process.cwd(), outputFile)}`);
console.log('No production JSON was modified. Review the candidate, then run promote:brand.');
