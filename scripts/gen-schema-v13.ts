/**
 * Writes the config schema v13 JSON Schema (16.0.0-alpha.2) from the code:
 *   schema/v13/config.schema.json   (buildV13ConfigSchema, src/config/v13-schema.ts)
 * The feature-module declaration schema is unchanged in 16.0 (schema/v12/module.schema.json).
 *
 *   npx tsx scripts/gen-schema-v13.ts [--check]
 *
 * `--check` exits 1 when the committed file differs (test/v13-tooling-16-0-2.test.ts checks the same).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import '../src/config/loader.js';
import { buildV13ConfigSchema } from '../src/config/v13-schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = join(root, 'schema/v13/config.schema.json');
const text = JSON.stringify(buildV13ConfigSchema(), null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (!existsSync(p) || readFileSync(p, 'utf8') !== text) {
    console.error('schema/v13/config.schema.json is out of date — run npx tsx scripts/gen-schema-v13.ts');
    process.exit(1);
  }
} else {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  console.log('wrote schema/v13/config.schema.json');
}
