/**
 * LTS backport of two 13.4.0 deployment fixes (found by the 13.4 deployment-example CI jobs):
 *  - the image HEALTHCHECK probed http://localhost:4000; busybox wget resolves localhost to ::1 while the gateway
 *    listens on IPv4 0.0.0.0, so containers were always "unhealthy";
 *  - Kubernetes injects service-link variables for every Service in the namespace; a Service named `mcp-gateway`
 *    (Helm release names containing "mcp-gateway") yields MCP_GATEWAY_PORT=tcp://<ip>:<port>, which the gateway read
 *    as its port (NaN) and refused to start (CrashLoopBackOff).
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
  writeFileSync(f, 'version: 11\nport: 4000\nhost: 127.0.0.1\nservers: []\n');
  return f;
};

describe('deployment fixes (13.4.0 backport)', () => {
  it('container healthchecks probe 127.0.0.1, not localhost', () => {
    for (const f of ['Dockerfile', 'examples/docker/docker-compose.yml']) {
      const t = readFileSync(join(root, f), 'utf8');
      expect(t, f).toMatch(/127\.0\.0\.1:4000\/api\/v1\/health\/live/);
      expect(t, f).not.toMatch(/localhost:4000\/api\/v1\/health/);
    }
  });

  it('a Kubernetes service-link MCP_GATEWAY_PORT (tcp://ip:port) is not taken as the listen port', async () => {
    process.env.MCP_GATEWAY_PORT = 'tcp://10.96.0.10:80';
    expect((await loadConfig(cfgFile())).port).toBe(4000);
  });

  it('a numeric MCP_GATEWAY_PORT still overrides the config', async () => {
    process.env.MCP_GATEWAY_PORT = '8080';
    expect((await loadConfig(cfgFile())).port).toBe(8080);
  });

  it('any other non-numeric MCP_GATEWAY_PORT is a clear error', async () => {
    process.env.MCP_GATEWAY_PORT = 'eighty';
    await expect(loadConfig(cfgFile())).rejects.toThrow(/MCP_GATEWAY_PORT/);
  });

  it('the Helm chart turns service links off', () => {
    expect(readFileSync(join(root, 'deploy/helm/mcp-gateway/templates/deployment.yaml'), 'utf8')).toMatch(/enableServiceLinks: false/);
  });
});
