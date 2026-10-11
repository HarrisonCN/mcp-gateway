/**
 * Writes the config schema v12 JSON Schemas (14.0.0) from the code:
 *   schema/v12/config.schema.json   (buildV12ConfigSchema)
 *   schema/v12/module.schema.json   (buildV12ModuleSchema)
 * and the same files to schema/v12-draft/ — the 13.9 path, kept as a deprecated alias copy until 15.0.0.
 *
 *   npx tsx scripts/gen-schema-v12.ts [--check]
 *
 * `--check` exits 1 when a committed file differs (test/v14-prep-13-9-0.test.ts checks the same).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import '../src/config/loader.js';
import { buildV12ConfigSchema, buildV12ModuleSchema } from '../src/config/v12.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['schema/v12', 'schema/v12-draft'];
const files: Record<string, unknown> = { 'config.schema.json': buildV12ConfigSchema(), 'module.schema.json': buildV12ModuleSchema() };
let drift = 0;
for (const d of DIRS) for (const [name, schema] of Object.entries(files)) {
  const dir = join(root, d);
  const p = join(dir, name);
  const text = JSON.stringify(schema, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (!existsSync(p) || readFileSync(p, 'utf8') !== text) {
      console.error(`${d}/${name} is out of date — run npx tsx scripts/gen-schema-v12.ts`);
      drift++;
    }
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, text);
    console.log(`wrote ${d}/${name}`);
  }
}
process.exit(drift ? 1 : 0);
