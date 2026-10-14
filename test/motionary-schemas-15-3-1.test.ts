/**
 * 15.3.0-canary.1: Motionary interop with tool schema governance (gateway half of cross-repo phase VI, see
 * docs/ROADMAP.md). Motionary's MCP server (motionary-mcp 2.x, Motionary ≥ 13.7) declares an `outputSchema` on its
 * structured tools and answers with `structuredContent`. Through the gateway with `policy.toolSchemas.validateOutput:
 * enforce` and every tool pinned:
 *  M1 every listed Motionary tool gets a digest; tools with an outputSchema are reported as such;
 *  M2 real calls of the structured tools pass `enforce` (0 violations) and reach the client unchanged;
 *  M3 a pin that does not match (a schema change on Motionary's side) refuses the call before it reaches Motionary.
 *
 * Runs only when MGW_MOTIONARY_BIN points at an installed `motionary-mcp.mjs` (CI job "MCP compat matrix" installs it
 * from npm into a scratch dir; Motionary is never a dependency of the gateway). MCP 3.0 (Motionary 16) is not
 * published yet — this checks the MCP 2.x tool schemas only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const BIN = process.env.MGW_MOTIONARY_BIN;
const K = 'k-op-motionary';
const hdr = { authorization: `Bearer ${K}`, 'content-type': 'application/json' };
let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const start = (toolSchemas: Record<string, unknown>) =>
  startFeatureGw({
    servers: [{ id: 'motionary', name: 'Motionary MCP', transport: 'stdio', command: process.execPath, args: [BIN!], timeout: 20_000 }],
    auth: { strategy: 'api-key', apiKeys: [{ key: K, name: 'ops' }] },
    policy: { toolSchemas },
  } as never);
const call = async (tool: string, args: Record<string, unknown>) => {
  const r = await fetch(`${h!.base}/api/v1/tools/call`, { method: 'POST', headers: hdr, body: JSON.stringify({ server: 'motionary', tool, arguments: args }) });
  return { status: r.status, body: (await r.json()) as any };
};
const report = async () => (await (await fetch(`${h!.base}/api/v1/admin/ops/tool-schemas`, { headers: hdr })).json()) as any;

// structured Motionary tools with small, deterministic arguments (motionary 13.7+ / 14.8 shapes)
const CALLS: Array<[string, Record<string, unknown>]> = [
  ['check_compatibility', { tags: ['usa-counter'], framework: 'react' }],
  ['suggest_fix', { code: '<usa-countr></usa-countr>' }],
  ['list_templates', {}],
];

describe.skipIf(!BIN || !existsSync(BIN))('Motionary MCP tools under policy.toolSchemas (15.3.0-canary.1)', { timeout: 90_000 }, () => {
  it('M1–M2 every tool is digested; structured calls pass validateOutput: enforce with every tool pinned', async () => {
    h = await start({ validateOutput: 'audit' });
    const first = await report();
    expect(first.tools.length).toBeGreaterThan(3);
    const structured = first.tools.filter((t: any) => t.outputSchema).map((t: any) => t.tool);
    expect(structured.length).toBeGreaterThan(0);
    const pins = Object.fromEntries(first.tools.map((t: any) => [`${t.server}/${t.tool}`, t.sha256]));
    await h.stop();

    h = await start({ validateOutput: 'enforce', pins, onDrift: 'block' });
    const ran: string[] = [];
    for (const [tool, args] of CALLS) {
      if (!structured.includes(tool)) continue; // an older Motionary without this tool's outputSchema
      const r = await call(tool, args);
      expect(r.status, `${tool}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(200);
      expect(r.body.result.structuredContent, tool).toBeTruthy();
      ran.push(tool);
    }
    expect(ran.length).toBeGreaterThan(0);
    const after = await report();
    expect(after.validateOutput).toBe('enforce');
    expect(after.missing).toEqual([]);
    for (const t of after.tools) {
      expect(t.drift, t.tool).toBe(false);
      expect(t.violations, t.tool).toBe(0);
    }
  });

  it('M3 a stale pin refuses the call before it reaches Motionary (schema-drift)', async () => {
    h = await start({ pins: { 'motionary/list_templates': '0'.repeat(64) } });
    const r = await call('list_templates', {});
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: -32003, policy: { decision: 'schema-drift' } });
    const other = await call('list_components', {});
    expect(other.status).toBe(200);
  });
});
