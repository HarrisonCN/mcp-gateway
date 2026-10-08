/** 5.7: the Python SDK (clients/python) against a real gateway — MCP session + streaming. Skipped without python3. */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { startFeatureGw, type FeatureGw } from './helpers/feature-gw.js';

const py = spawnSync('python3', ['--version']).status === 0;
const src = fileURLToPath(new URL('../clients/python/src', import.meta.url));
let h: FeatureGw | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const SCRIPT = `
import json, sys
from mcp_gateway_client import GatewayClient, McpSession, stream_tool
c = GatewayClient(sys.argv[1], api_key="op")
out = {}
with McpSession(c) as s:
    out["version"] = s.protocol_version
    out["tools"] = sorted(t["name"] for t in s.list_tools())
    out["call"] = s.call_tool("echo", {"hello": "py"})["content"][0]["text"]
out["events"] = [e["event"] for e in stream_tool(c, "echo", {"hello": "stream"}, server="fake")]
print(json.dumps(out))
`;

describe.skipIf(!py)('Python SDK against a live gateway (5.7)', () => {
  it('MCP session and streaming tool call', async () => {
    h = await startFeatureGw();
    const r = spawnSync('python3', ['-c', SCRIPT, h.base], { env: { ...process.env, PYTHONPATH: src, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }, encoding: 'utf8', timeout: 30_000 });
    expect(r.stderr + r.stdout).not.toMatch(/Traceback/);
    if (!r.stdout) throw new Error(JSON.stringify({ status: r.status, signal: r.signal, err: String(r.error) }));
    const out = JSON.parse(r.stdout);
    expect(out.version).toBe('2025-11-25');
    expect(out.tools).toContain('echo');
    expect(out.call).toContain('py');
    expect(out.events).toContain('result');
    expect(out.events[out.events.length - 1]).toBe('end');
  });
});
