import * as fs from 'node:fs';
import * as path from 'node:path';

export const BRAND_ENRICHMENT_FIELDS = [
  'description',
  'history',
  'country',
  'founded',
  'parent_company',
  'current_status',
  'vehicle_types',
  'popular_models',
  'ecu_information',
  'common_ecu_manufacturers',
  'related_brands',
  'seo_title',
  'seo_description',
  'faq',
  'sources',
];

const LEGACY_FIELDS = new Set(['logo', 'productionModels', 'discontinuedModels']);
const ALLOWED_FIELDS = new Set(['name', 'slug', ...BRAND_ENRICHMENT_FIELDS, ...LEGACY_FIELDS]);
const STRING_ARRAY_FIELDS = ['vehicle_types', 'popular_models', 'common_ecu_manufacturers', 'related_brands'];
const PLACEHOLDER_PATTERN = /\b(lorem ipsum|placeholder|tbd|to be determined|coming soon|insert (?:text|content)|fill in|changeme)\b/i;
const URL_PATTERN = /^https?:\/\//i;

export function slugifyBrand(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
}

export function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isEnrichedBrandContent(brand) {
  if (!brand || typeof brand !== 'object' || Array.isArray(brand)) return false;
  if (hasText(brand.slug)) return true;

  return BRAND_ENRICHMENT_FIELDS
    .filter((field) => field !== 'description')
    .some((field) => {
      const value = brand[field];
      return Array.isArray(value) ? value.length > 0 : value != null && value !== '';
    });
}

export function normalizeBrandContent(brand, { expectedSlug = null } = {}) {
  if (!brand || typeof brand !== 'object' || Array.isArray(brand)) return null;

  const normalized = { ...brand };
  if (hasText(normalized.name)) normalized.name = normalized.name.trim();

  if (!hasText(normalized.slug)) {
    normalized.slug = expectedSlug || (hasText(normalized.name) ? slugifyBrand(normalized.name) : '');
  } else {
    normalized.slug = normalized.slug.trim();
  }

  return normalized;
}

export function readBrandRecord(slug, rootDir = process.cwd()) {
  const file = path.join(rootDir, 'src', 'data', slug, 'brand.json');
  if (!fs.existsSync(file)) return null;

  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return normalizeBrandContent(parsed, { expectedSlug: slug });
}

export function readBrandContent(slug, rootDir = process.cwd()) {
  const file = path.join(rootDir, 'src', 'data', slug, 'brand.json');
  if (!fs.existsSync(file)) return null;

  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!isEnrichedBrandContent(parsed)) return null;
  return normalizeBrandContent(parsed, { expectedSlug: slug });
}

function validateStringArray(brand, key, errors) {
  if (brand[key] == null) return;
  if (!Array.isArray(brand[key])) {
    errors.push(`${key} must be an array`);
    return;
  }

  const seen = new Set();
  for (const [index, raw] of brand[key].entries()) {
    if (!hasText(raw)) {
      errors.push(`${key}[${index}] must be a non-empty string`);
      continue;
    }

    const value = raw.trim();
    const duplicateKey = value.toLowerCase();
    if (seen.has(duplicateKey)) errors.push(`${key} contains duplicate value "${value}"`);
    seen.add(duplicateKey);

    if (key === 'popular_models' && (/^\d+$/.test(value) || value.length < 2)) {
      errors.push(`popular_models contains malformed model name "${value}"`);
    }
  }
}

export function normalizedTextFingerprint(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function textSimilarity(a, b) {
  const left = new Set(normalizedTextFingerprint(a).split(' ').filter(Boolean));
  const right = new Set(normalizedTextFingerprint(b).split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / Math.max(left.size + right.size - intersection, 1);
}

export function validateBrandContent(
  input,
  { expectedSlug = null, knownSlugs = new Set(), requireExplicitSlug = false } = {},
) {
  const errors = [];
  const warnings = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['brand content must be a JSON object'], warnings, value: null };
  }

  if (requireExplicitSlug && !hasText(input.slug)) errors.push('slug is required in generated/promoted content');

  const brand = normalizeBrandContent(input, { expectedSlug });
  if (!brand) return { ok: false, errors: ['brand content could not be normalized'], warnings, value: null };

  if (!hasText(brand.name)) errors.push('name is required');
  if (!hasText(brand.slug)) errors.push('slug could not be derived');

  if (brand.name && brand.slug) {
    const derived = slugifyBrand(brand.name);
    if (brand.slug !== derived) errors.push(`slug "${brand.slug}" must match name-derived slug "${derived}"`);
  }

  if (expectedSlug && brand.slug !== expectedSlug) {
    errors.push(`slug "${brand.slug}" does not match directory "${expectedSlug}"`);
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) warnings.push(`unknown field "${key}" is not part of the documented brand schema`);
  }

  if (brand.founded != null) {
    const year = Number(brand.founded);
    if (!Number.isInteger(year) || year < 1800 || year > new Date().getFullYear()) {
      errors.push('founded must be a plausible year');
    }
  }

  for (const key of STRING_ARRAY_FIELDS) validateStringArray(brand, key, errors);

  if (hasText(brand.parent_company) && hasText(brand.name)
    && normalizedTextFingerprint(brand.parent_company) === normalizedTextFingerprint(brand.name)) {
    errors.push('parent_company cannot be the manufacturer itself; omit it when the brand is independent');
  }

  if (Array.isArray(brand.common_ecu_manufacturers) && hasText(brand.name)) {
    const brandFingerprint = normalizedTextFingerprint(brand.name);
    for (const supplier of brand.common_ecu_manufacturers) {
      if (normalizedTextFingerprint(supplier) === brandFingerprint) {
        errors.push(`common_ecu_manufacturers cannot list the vehicle manufacturer itself ("${supplier}")`);
      }
    }
  }

  if (Array.isArray(brand.related_brands)) {
    for (const slug of brand.related_brands) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug))) {
        errors.push(`related brand "${slug}" is not a valid slug`);
      } else if (knownSlugs.size > 0 && !knownSlugs.has(slug)) {
        errors.push(`related brand "${slug}" does not exist in brands.json`);
      } else if (slug === brand.slug) {
        errors.push('related_brands cannot reference the current brand itself');
      }
    }
  }

  if (brand.sources != null) {
    if (!Array.isArray(brand.sources)) {
      errors.push('sources must be an array');
    } else {
      const seen = new Set();
      for (const [index, raw] of brand.sources.entries()) {
        if (!hasText(raw) || !URL_PATTERN.test(raw.trim())) {
          errors.push(`sources[${index}] must be an http(s) URL`);
          continue;
        }
        const value = raw.trim();
        if (seen.has(value)) errors.push(`sources contains duplicate URL "${value}"`);
        seen.add(value);
      }
    }
  }

  if (brand.faq != null) {
    if (!Array.isArray(brand.faq)) {
      errors.push('faq must be an array');
    } else {
      const seenQuestions = new Set();
      for (const [index, item] of brand.faq.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(`faq[${index}] must be an object`);
          continue;
        }
        if (!hasText(item.question) || !hasText(item.answer)) {
          errors.push(`faq[${index}] must contain non-empty question and answer`);
          continue;
        }
        const question = item.question.trim();
        const key = question.toLowerCase();
        if (seenQuestions.has(key)) errors.push(`faq contains duplicate question "${question}"`);
        seenQuestions.add(key);
        if (item.answer.trim().length < 30) warnings.push(`faq[${index}] answer is very short`);
      }
    }
  }

  for (const key of ['description', 'history', 'ecu_information', 'seo_title', 'seo_description']) {
    if (brand[key] == null) continue;
    if (!hasText(brand[key])) {
      errors.push(`${key} cannot be empty when present`);
      continue;
    }
    if (PLACEHOLDER_PATTERN.test(brand[key])) errors.push(`${key} contains placeholder text`);
  }

  if (hasText(brand.seo_title)) {
    if (brand.seo_title.length > 70) warnings.push('seo_title is longer than 70 characters');
    if (brand.seo_title.length < 25) warnings.push('seo_title is unusually short');
  }

  if (hasText(brand.seo_description)) {
    if (brand.seo_description.length > 160) warnings.push('seo_description is longer than 160 characters');
    if (brand.seo_description.length < 70) warnings.push('seo_description is unusually short');
  }

  if (Array.isArray(brand.sources) && brand.sources.length === 0) warnings.push('sources is present but empty');
  if ((hasText(brand.ecu_information) || (Array.isArray(brand.common_ecu_manufacturers) && brand.common_ecu_manufacturers.length > 0))
    && (!Array.isArray(brand.sources) || brand.sources.length === 0)) {
    warnings.push('technical ECU content has no source provenance');
  }

  for (const legacyKey of ['productionModels', 'discontinuedModels']) {
    if (brand[legacyKey] != null && !Number.isFinite(Number(brand[legacyKey]))) {
      warnings.push(`${legacyKey} is a legacy field and should remain numeric when present`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, value: brand };
}
