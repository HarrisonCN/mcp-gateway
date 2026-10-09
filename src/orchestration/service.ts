/**
 * Chain service: exposes configured chains on REST (`/api/v1/chains`) and as MCP tools (4.2).
 *
 * @module orchestration/service
 */

import express, { type Request, type RequestHandler } from 'express';
import { isToolInScope, type AccessScope } from '../auth/scopes.js';
import type { AuthedRequest } from '../auth/middleware.js';
import type { ProxyResponse } from '../utils/types.js';
import { chainTargets, chainToolResult, parseTarget, runChain, type ChainConfig, type ChainRunResult, type ChainsConfig } from './chains.js';

export interface ChainServiceDeps {
  config: () => ChainsConfig | undefined;
  invoke: (serverId: string, tool: string, args: Record<string, unknown>, clientId: string | undefined, via: 'rest' | 'mcp', scope: AccessScope | undefined) => Promise<ProxyResponse>;
}

export class ChainService {
  private readonly recent: ChainRunResult[] = [];

  constructor(private readonly deps: ChainServiceDeps) {}

  get prefix(): string {
    return this.deps.config()?.toolPrefix ?? 'chain_';
  }

  list(): ChainConfig[] {
    return this.deps.config()?.chains ?? [];
  }

  /** Chains whose every step is in the caller's scope. */
  allowed(scope: AccessScope | undefined): ChainConfig[] {
    return this.list().filter((c) => this.missing(c, scope).length === 0);
  }

  private missing(c: ChainConfig, scope: AccessScope | undefined): string[] {
    return chainTargets(c.steps).filter((t) => {
      const p = parseTarget(t);
      return !p || !isToolInScope(scope, p.serverId, p.tool);
    });
  }

  /** MCP `Tool` objects. */
  tools(scope: AccessScope | undefined): Record<string, unknown>[] {
    return this.allowed(scope).map((c) => ({
      name: this.prefix + c.name,
      title: c.name,
      description: c.description ?? `Chain: ${chainTargets(c.steps).join(' → ')}`,
      inputSchema: c.inputSchema ?? { type: 'object' },
    }));
  }

  async run(name: string, input: Record<string, unknown>, clientId: string | undefined, scope: AccessScope | undefined, via: 'rest' | 'mcp'): Promise<ChainRunResult | { forbidden: string[] } | undefined> {
    const chain = this.list().find((c) => c.name === name);
    if (!chain) return undefined;
    const missing = this.missing(chain, scope);
    if (missing.length) return { forbidden: missing };
    const r = await runChain(chain, input, (s, t, a) => this.deps.invoke(s, t, a, clientId, via, scope));
    this.recent.unshift(r);
    this.recent.length = Math.min(this.recent.length, 50);
    return r;
  }

  /** MCP `tools/call` for a chain tool; undefined when `name` is not a chain. */
  async callTool(name: string, args: Record<string, unknown>, clientId: string | undefined, scope: AccessScope | undefined): Promise<Record<string, unknown> | { forbidden: string[] } | undefined> {
    if (!name.startsWith(this.prefix)) return undefined;
    const r = await this.run(name.slice(this.prefix.length), args, clientId, scope, 'mcp');
    if (!r || 'forbidden' in r) return r;
    return chainToolResult(r);
  }

  runs(): ChainRunResult[] {
    return this.recent;
  }

  router(authenticate: RequestHandler): express.Router {
    const r = express.Router();
    const scopeOf = (req: Request) => (req as AuthedRequest).scope;
    r.get('/chains', authenticate, (req, res) => {
      const scope = scopeOf(req);
      res.json({
        toolPrefix: this.prefix,
        chains: this.list().map((c) => ({
          name: c.name,
          tool: this.prefix + c.name,
          description: c.description,
          inputSchema: c.inputSchema ?? { type: 'object' },
          steps: c.steps.length,
          targets: chainTargets(c.steps),
          allowed: this.missing(c, scope).length === 0,
        })),
        recent: this.recent.slice(0, 20).map(({ output: _o, ...x }) => x),
      });
    });
    r.post('/chains/:name/run', authenticate, async (req, res) => {
      const body = (req.body ?? {}) as { input?: unknown };
      const input = body.input ?? {};
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        res.status(400).json({ error: 'Bad Request', message: '"input" must be an object' });
        return;
      }
      const out = await this.run(String(req.params.name), input as Record<string, unknown>, (req as AuthedRequest).clientId, scopeOf(req), 'rest');
      if (!out) return void res.status(404).json({ error: 'Not Found', message: `Unknown chain "${req.params.name}"` });
      if ('forbidden' in out) return void res.status(403).json({ error: 'Forbidden', message: `Chain calls tools outside your scope: ${out.forbidden.join(', ')}` });
      res.status(out.success ? 200 : 502).json(out);
    });
    return r;
  }
}
