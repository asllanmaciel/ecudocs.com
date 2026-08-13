# Brand Content Pipeline

ECU Docs keeps `src/data/brands.json` as the legacy manufacturer index and supports optional structured enrichment per manufacturer in:

`src/data/<brand-slug>/brand.json`

## Quick verification

Use Node.js 20 or newer, install the locked dependencies, then run the two repository quality gates:

```bash
npm ci
npm run validate:brands
npm run build
```

The AI variables below are required only for a non-dry-run generation. They are not required to build the site or to validate brand data.

The implementation is deliberately incremental: existing URLs and legacy data remain valid while richer manufacturer content can be added without creating new Astro pages.

## Design goals

- preserve existing manufacturer URLs and the current JSON-driven architecture;
- remain compatible with legacy `brand.json` files that do not yet contain an explicit `slug`;
- render enrichment only when data exists;
- avoid empty UI sections and guessed internal links;
- keep static generation and avoid unnecessary client-side JavaScript;
- separate AI-generated candidates from reviewed production data;
- require provenance for technical claims whenever possible;
- omit uncertain ECU details instead of guessing;
- keep generation provider-neutral by targeting an OpenAI-compatible `chat/completions` API.

## Enriched brand shape

A `brand.json` can contain:

- `name`
- `slug`
- `description`
- `history`
- `country`
- `founded`
- `parent_company`
- `current_status`
- `vehicle_types`
- `popular_models`
- `ecu_information`
- `common_ecu_manufacturers`
- `related_brands`
- `seo_title`
- `seo_description`
- `faq`
- `sources`

Legacy fields such as `logo`, `productionModels` and `discontinuedModels` are preserved. The loader derives a missing `slug` from the existing route/directory so older files do not need a bulk rewrite.

Only facts that can be supported should be added. Optional fields should be omitted when reliable data is unavailable.

## Validation

Run:

```bash
npm run validate:brands
```

The validator checks:

- duplicate manufacturer names and derived slugs in `brands.json`;
- JSON shape and route/directory slug consistency;
- plausible founded years;
- array field types, empty values and duplicates;
- malformed/duplicate model records and route keys;
- related-brand references against real manufacturers;
- FAQ structure and duplicate questions;
- source URL shape and duplicate sources;
- placeholder content;
- SEO title/description lengths;
- exact and near-duplicate brand descriptions;
- missing provenance warnings for technical ECU content.

Hard errors return exit code `1`. Warnings are review signals and do not fail the command.

## AI-assisted workflow

AI never writes directly to production brand files.

```text
legacy brand + existing model data
        ↓
AI generates only requested/missing fields
        ↓
tmp/brand-candidates/<slug>.json
        ↓
manual source/fact review
        ↓
promotion preview + validation
        ↓
explicit --apply
        ↓
src/data/<slug>/brand.json
        ↓
full validator + Astro build
```

### Environment

Copy/configure local environment variables without committing `.env`:

```bash
AI_API_BASE_URL=https://provider.example/v1
AI_API_KEY=...
AI_MODEL=...
```

The generator uses the provider's OpenAI-compatible `/chat/completions` endpoint. Provider selection is infrastructure configuration; validation and production data do not depend on a vendor SDK.

### Preview generation without an API call

```bash
npm run generate:brand -- --brand=bmw --dry-run
```

The dry run prints the prompt/context and requested fields. It does not require provider credentials and writes nothing.

### Generate a candidate

```bash
npm run generate:brand -- --brand=bmw
```

By default only missing enrichment fields are requested. Use `--force` only when a deliberate regeneration is required.

Generated content is written to:

```text
tmp/brand-candidates/bmw.json
```

That directory is ignored by Git.

### Review and promote

First preview the production change:

```bash
npm run promote:brand -- --brand=bmw
```

After manually reviewing facts, technical claims and source URLs:

```bash
npm run promote:brand -- --brand=bmw --apply
```

The commands accept both `--brand=bmw` and `--brand bmw` forms, including when npm forwards options through `npm_config_*` on Windows.

The promotion command validates both before and after writing. It does not bypass the full repository quality gates.

## Generation rules

The generation layer instructs the model to:

1. use manufacturer-specific facts;
2. omit facts it cannot support;
3. never invent ECU part numbers, protocols, pinouts or compatibility;
4. use existing ECU Docs model data as context when available;
5. return structured JSON only;
6. provide source URLs actually used to ground factual or technical claims;
7. avoid repetitive SEO copy and marketing superlatives;
8. return only requested fields so AI output cannot silently overwrite unrelated data.

## Rendering and internal links

The generic manufacturer page:

- falls back cleanly when no enrichment exists;
- uses per-brand SEO title/description when present;
- emits a canonical manufacturer URL;
- renders FAQ structured data only when the same FAQ is visibly rendered;
- links `popular_models` only when an exact model in the project's `models.json` resolves to an existing route;
- links related brands only when the target exists in `brands.json`;
- renders source URLs when provided;
- does not create routes from guessed manual/pinout substrings.

## Adding or updating manufacturer enrichment

1. Confirm the manufacturer already exists in `src/data/brands.json`.
2. Use the same normalized slug used by the existing manufacturer route.
3. Add/update `src/data/<slug>/brand.json` manually, or generate a staged candidate.
4. Review factual claims and source provenance.
5. Run `npm run validate:brands`.
6. Run `npm run build`.
7. Review the rendered manufacturer page and internal links before committing.

Adding enrichment never requires creating another Astro page. The generic manufacturer template consumes the optional JSON data.

## Quality gate before a pull request

```bash
npm run validate:brands
npm run build
```

Also verify that no `.env`, `tmp/brand-candidates`, generated `.astro/` files, logs or unrelated local artifacts are included in the diff.
