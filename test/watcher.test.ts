import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigWatcher } from '../src/config/watcher.js';
import { Logger } from '../src/utils/logger.js';
import type { GatewayConfig } from '../src/utils/types.js';

const SERVER = (id: string) => `servers:\n  - {id: ${id}, name: ${id}, transport: stdio, command: node}\n`;

function quietLogger() {
  const l = new Logger();
  l.setLevel('error');
  vi.spyOn(l, 'error').mockImplementation(() => {});
  vi.spyOn(l, 'warn').mockImplementation(() => {});
  return l;
}

function next<T>(w: ConfigWatcher, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${event} within ${timeoutMs}ms`)), timeoutMs);
    w.once(event, (v: T) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

const watchers: ConfigWatcher[] = [];
const dirs: string[] = [];

function setup(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpgw-watch-'));
  dirs.push(dir);
  const path = join(dir, 'mcp-gateway.yml');
  writeFileSync(path, content);
  const logger = quietLogger();
  const w = new ConfigWatcher(path, logger, 50);
  watchers.push(w);
  return { dir, path, logger, w };
}

afterEach(() => {
  watchers.splice(0).forEach((w) => w.stop());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('ConfigWatcher', () => {
  it('emits reload with the parsed config when the file changes', async () => {
    const { path, w } = setup(SERVER('a'));
    w.start();
    const reloaded = next<GatewayConfig>(w, 'reload');
    writeFileSync(path, SERVER('b'));
    const cfg = await reloaded;
    expect(cfg.servers.map((s) => s.id)).toEqual(['b']);
  });

  it('debounces bursts of writes into a single reload', async () => {
    const { path, w } = setup(SERVER('a'));
    const onReload = vi.fn();
    w.on('reload', onReload);
    w.start();
    const done = next<GatewayConfig>(w, 'reload');
    for (const id of ['b', 'c', 'd']) writeFileSync(path, SERVER(id));
    const cfg = await done;
    await new Promise((r) => setTimeout(r, 200));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(cfg.servers[0]!.id).toBe('d');
  });

  it('keeps watching after an atomic save (write temp + rename)', async () => {
    const { dir, path, w } = setup(SERVER('a'));
    w.start();
    let reloaded = next<GatewayConfig>(w, 'reload');
    const tmp = join(dir, 'tmp.yml');
    writeFileSync(tmp, SERVER('b'));
    renameSync(tmp, path);
    expect((await reloaded).servers[0]!.id).toBe('b');

    // The handle must have been re-attached to the new inode.
    reloaded = next<GatewayConfig>(w, 'reload');
    writeFileSync(path, SERVER('c'));
    expect((await reloaded).servers[0]!.id).toBe('c');
  });

  it('emits reload-error and keeps going when the new file is invalid', async () => {
    const { path, logger, w } = setup(SERVER('a'));
    w.start();
    const failed = next<Error>(w, 'reload-error');
    writeFileSync(path, 'port: not-a-number\n');
    expect((await failed).message).toMatch(/Invalid configuration/);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/keeping current config/));

    const reloaded = next<GatewayConfig>(w, 'reload');
    writeFileSync(path, SERVER('ok'));
    expect((await reloaded).servers[0]!.id).toBe('ok');
  });

  it('does not throw on an invalid file when nobody listens for reload-error', async () => {
    const { path, logger, w } = setup(SERVER('a'));
    w.start();
    writeFileSync(path, 'servers: 42\n');
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled(), { timeout: 3000 });
  });

  it('emits nothing after stop()', async () => {
    const { path, w } = setup(SERVER('a'));
    const onReload = vi.fn();
    w.on('reload', onReload);
    w.start();
    writeFileSync(path, SERVER('b'));
    w.stop();
    await new Promise((r) => setTimeout(r, 250));
    expect(onReload).not.toHaveBeenCalled();
  });

  it('start() is idempotent', () => {
    const { w } = setup(SERVER('a'));
    w.start();
    w.start();
    w.stop();
    w.stop();
  });

  it('warns instead of throwing when the file cannot be watched', () => {
    const logger = quietLogger();
    const w = new ConfigWatcher(join(tmpdir(), 'definitely-missing-mcpgw', 'x.yml'), logger, 50);
    watchers.push(w);
    expect(() => w.start()).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Cannot watch/));
  });
});
