import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import pkg from '../package.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const TSX = join(require.resolve('tsx/package.json'), '..', 'dist', 'cli.mjs');
const CLI = resolve(__dirname, '..', 'src', 'cli.ts');
const dirs: string[] = [];

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'mcpgw-cli-'));
  dirs.push(d);
  return d;
}

function run(args: string[], cwd = tmp()) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('MCP_GATEWAY_')) delete env[k];
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, env, encoding: 'utf-8', timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('cli', () => {
  it('--version prints the package version', () => {
    const r = run(['--version']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(pkg.version);
  });

  it('init writes a valid default config and refuses to overwrite without --force', () => {
    const d = tmp();
    const r = run(['init'], d);
    expect(r.code).toBe(0);
    const file = join(d, 'mcp-gateway.yml');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toMatch(/^# mcp-gateway configuration/);

    writeFileSync(file, 'port: 1\n');
    const again = run(['init'], d);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already exists/);
    expect(readFileSync(file, 'utf-8')).toBe('port: 1\n');

    expect(run(['init', '--force'], d).code).toBe(0);
    expect(readFileSync(file, 'utf-8')).toMatch(/^# mcp-gateway configuration/);

    const validated = run(['validate'], d);
    expect(validated.code).toBe(0);
    expect(validated.out).toMatch(/Configuration is valid/);
    expect(validated.out).toMatch(/Servers: 2/);
  });

  it('validate discovers default config file names in priority order', () => {
    const d = tmp();
    const none = run(['validate'], d);
    expect(none.code).toBe(0);
    expect(none.out).toMatch(/Port: 4000/);
    writeFileSync(join(d, '.mcp-gateway.yaml'), 'port: 4003\n');
    expect(run(['validate'], d).out).toMatch(/Port: 4003/);
    writeFileSync(join(d, 'mcp-gateway.json'), '{"port": 4002}');
    expect(run(['validate'], d).out).toMatch(/Port: 4002/);
    writeFileSync(join(d, 'mcp-gateway.yml'), 'port: 4001\n');
    expect(run(['validate'], d).out).toMatch(/Port: 4001/);
  });

  it('validate exits 1 with the list of problems for an invalid file', () => {
    const d = tmp();
    writeFileSync(join(d, 'bad.yml'), 'servers:\n  - {id: a, name: A, transport: stdio}\n');
    const r = run(['validate', '-c', 'bad.yml'], d);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/servers\.0\.command: required for stdio transport/);
  });

  it('start rejects an invalid --port before binding anything', () => {
    const d = tmp();
    writeFileSync(join(d, 'gw.yml'), '{}\n');
    const r = run(['start', '-c', 'gw.yml', '--port', 'abc', '--no-watch'], d);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Invalid --port "abc"/);
    const l = run(['start', '-c', 'gw.yml', '--log-level', 'loud', '--no-watch'], d);
    expect(l.code).toBe(1);
    expect(l.err).toMatch(/Invalid --log-level "loud"/);
  });
});
