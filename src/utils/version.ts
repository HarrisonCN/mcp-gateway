/**
 * Package version, read once from package.json at runtime so the CLI,
 * health endpoint and MCP handshake never drift from the published version.
 */

import { createRequire } from 'module';

function readVersion(): string {
  try {
    // Works from both src/utils (tsx) and dist/utils (compiled): ../../package.json
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
