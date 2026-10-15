/**
 * 13.4.0: Kubernetes injects "service link" variables for every Service in the namespace — a Service named
 * `mcp-gateway` yields MCP_GATEWAY_PORT=tcp://10.96.0.10:80, which the gateway read as its port (NaN) and refused to
 * start (CrashLoopBackOff). Found by the kind job of the deployment-examples workflow.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../src/config/loader.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const saved = process.env.MCP_GATEWAY_PORT;
afterEach(() => {
  if (saved === undefined) delete process.env.MCP_GATEWAY_PORT;
  else process.env.MCP_GATEWAY_PORT = saved;
});
const cfgFile = () => {
  const d = mkdtempSync(join(tmpdir(), 'svc-links-'));
  const f = join(d, 'mcp-gateway.yml');
  writeFileSync(f, 'version: 13\nport: 4000\nhost: 127.0.0.1\nservers: []\n');
  return f;
};

describe('MCP_GATEWAY_PORT and Kubernetes service links', () => {
  it('a service-link value (tcp://ip:port) is not taken as the listen port', async () => {
    process.env.MCP_GATEWAY_PORT = 'tcp://10.96.0.10:80';
    expect((await loadConfig(cfgFile())).port).toBe(4000);
  });

  it('a numeric MCP_GATEWAY_PORT still overrides the config', async () => {
    process.env.MCP_GATEWAY_PORT = '8080';
    expect((await loadConfig(cfgFile())).port).toBe(8080);
  });

  it('any other non-numeric value is a clear error', async () => {
    process.env.MCP_GATEWAY_PORT = 'eighty';
    await expect(loadConfig(cfgFile())).rejects.toThrow(/MCP_GATEWAY_PORT/);
  });

  it('the Helm chart and the plain manifests turn service links off', () => {
    expect(readFileSync(join(root, 'deploy/helm/mcp-gateway/templates/deployment.yaml'), 'utf8')).toMatch(/enableServiceLinks: false/);
    expect(readFileSync(join(root, 'examples/deploy/kubernetes/mcp-gateway.yaml'), 'utf8')).toMatch(/enableServiceLinks: false/);
  });
});
