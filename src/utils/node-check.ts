/**
 * Runtime check (6.0): the gateway needs Node.js 22 or newer (`engines.node: ">=22"`). The CLI exits with a clear
 * message on older runtimes instead of failing later on a missing API.
 *
 * @module utils/node-check
 */

export const MIN_NODE_MAJOR = 22;

/** `undefined` when `version` (e.g. `process.versions.node`) is supported, otherwise the message to print. */
export function nodeVersionError(version: string = process.versions.node): string | undefined {
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) return undefined;
  return `mcp-gateway 6.x requires Node.js ${MIN_NODE_MAJOR} or newer (running ${version.startsWith('v') ? version : `v${version}`}). Upgrade Node.js, or stay on mcp-gateway 5.x.`;
}
