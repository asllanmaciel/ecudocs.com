import * as fs from 'node:fs';
import * as path from 'node:path';
import brandsData from '../src/data/brands.json' with { type: 'json' };
import { slugifyBrand, validateBrandContent } from '../src/lib/brand-content.js';

function parseBoolean(value) {
  if (value == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readOption(args, name) {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);

  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) {
    return args[index + 1];
  }

  return process.env[`npm_config_${name.replace(/-/g, '_')}`] || null;
}

function hasFlag(args, name) {
  return args.includes(`--${name}`)
    || parseBoolean(process.env[`npm_config_${name.replace(/-/g, '_')}`]);
}

const args = process.argv.slice(2);
const brandSlug = readOption(args, 'brand');
const apply = hasFlag(args, 'apply');

if (!brandSlug) {
  console.error('Usage: npm run promote:brand -- --brand=bmw [--apply]');
  process.exit(1);
}

const knownSlugs = new Set(brandsData.map((row) => slugifyBrand(row[3])));
if (!knownSlugs.has(brandSlug)) {
  console.error(`Unknown brand slug: ${brandSlug}`);
  process.exit(1);
}

const candidateFile = path.join(process.cwd(), 'tmp', 'brand-candidates', `${brandSlug}.json`);
if (!fs.existsSync(candidateFile)) {
  console.error(`Candidate not found: ${path.relative(process.cwd(), candidateFile)}`);
  process.exit(1);
}

let candidate;
try {
  candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf-8'));
} catch (error) {
  console.error(`Candidate is not valid JSON: ${error.message}`);
  process.exit(1);
}

const validation = validateBrandContent(candidate, {
  expectedSlug: brandSlug,
  knownSlugs,
  requireExplicitSlug: true,
});

if (!validation.ok) {
  console.error('Candidate failed validation and cannot be promoted:');
  for (const message of validation.errors) console.error(`  - ${message}`);
  process.exit(1);
}

const targetFile = path.join(process.cwd(), 'src', 'data', brandSlug, 'brand.json');
let current = {};
if (fs.existsSync(targetFile)) {
  try {
    current = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
  } catch (error) {
    console.error(`Existing brand.json is invalid JSON: ${error.message}`);
    process.exit(1);
  }
}

const changedKeys = [...new Set([...Object.keys(current), ...Object.keys(validation.value)])]
  .filter((key) => JSON.stringify(current[key]) !== JSON.stringify(validation.value[key]))
  .sort();

console.log(`Brand: ${brandSlug}`);
console.log(`Target: ${path.relative(process.cwd(), targetFile)}`);
console.log(`Changed fields: ${changedKeys.join(', ') || '(none)'}`);
if (validation.warnings.length > 0) {
  console.warn('Review warnings:');
  for (const message of validation.warnings) console.warn(`  - ${message}`);
}

if (!apply) {
  console.log('\nPreview only. No production files changed.');
  console.log('After reviewing the candidate and sources, run again with --apply.');
  process.exit(0);
}

fs.mkdirSync(path.dirname(targetFile), { recursive: true });
fs.writeFileSync(targetFile, `${JSON.stringify(validation.value, null, 2)}\n`, 'utf-8');

const persisted = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
const persistedValidation = validateBrandContent(persisted, {
  expectedSlug: brandSlug,
  knownSlugs,
  requireExplicitSlug: true,
});
if (!persistedValidation.ok) {
  console.error('Post-write validation failed unexpectedly. Revert the file before committing.');
  process.exit(1);
}

console.log(`Promoted reviewed candidate to ${path.relative(process.cwd(), targetFile)}`);
console.log('Run npm run validate:brands and npm run build before committing.');
