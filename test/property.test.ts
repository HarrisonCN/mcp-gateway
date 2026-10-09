/**
 * 10.2: property / fuzz tests (fast-check) for the input parsers that sit on a trust boundary:
 * config parsing (zod + YAML), JSON-RPC framing (stdio + /mcp), tool-argument size limits and JWT / bearer parsing.
 * The invariant everywhere: hostile input is rejected with a controlled error, never a crash, a 5xx or a widened scope.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { parse as parseYaml } from 'yaml';
import { validateConfig } from '../src/config/loader.js';
import { toMessages } from '../src/transport/channel.js';
import { StdioChannel } from '../src/transport/stdio.js';
import { argumentsTooLarge } from '../src/gateway/api.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { scopeFromJwt, isServerInScope } from '../src/auth/scopes.js';
import { tokenScopes, peekClaims } from '../src/auth/oauth.js';
import { parseHostHeader, hostAllowed } from '../src/security/network.js';
import { splitSan, spiffeIdsOf } from '../src/security/mtls.js';
import { Gateway } from '../src/gateway/index.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('error');
const RUNS = Number(process.env.FC_RUNS ?? 200);

/** Config-shaped values: known top-level keys with arbitrary JSON beneath them. */
const configish = fc.dictionary(
  fc.constantFrom('version', 'port', 'host', 'logLevel', 'servers', 'auth', 'security', 'policy', 'tenants', 'cors', 'features', 'mtls', 'rateLimit', 'mcp', 'store', 'controlPlane', 'x'),
  fc.jsonValue({ maxDepth: 4 }),
);

describe('config parsing', () => {
  it('validateConfig either returns a config or throws a readable "Invalid configuration" Error', () => {
    fc.assert(
      fc.property(fc.oneof(configish, fc.jsonValue({ maxDepth: 3 })), (raw) => {
        try {
          const c = validateConfig(raw);
          expect(typeof c).toBe('object');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect(err).not.toBeInstanceOf(TypeError);
          expect(err).not.toBeInstanceOf(RangeError);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('nested sections (servers, auth, security, tenants, policy) with arbitrary values never crash validation', () => {
    const anyv = fc.jsonValue({ maxDepth: 2 });
    const server = fc.dictionary(fc.constantFrom('id', 'name', 'transport', 'command', 'args', 'env', 'url', 'headers', 'timeoutMs', 'tools', 'replicas', 'tls', 'loadBalancing', 'inject'), anyv);
    const section = fc.record(
      {
        version: fc.constantFrom(10, undefined),
        servers: fc.array(server, { maxLength: 3 }),
        auth: fc.dictionary(fc.constantFrom('strategy', 'apiKeys', 'jwt', 'jwtSecret', 'oauth', 'protect'), fc.oneof(anyv, fc.constantFrom('api-key', 'jwt', 'oauth2', 'none'))),
        security: fc.dictionary(fc.constantFrom('allowedHosts', 'dnsRebindingProtection', 'maxBodyBytes', 'maxToolArgumentsBytes', 'ipAllowlist', 'redactPatterns', 'authLockout', 'trustProxy'), anyv),
        tenants: fc.array(fc.dictionary(fc.constantFrom('id', 'servers', 'members'), anyv), { maxLength: 2 }),
        policy: fc.dictionary(fc.constantFrom('rules', 'default', 'files', 'approval'), anyv),
        features: fc.dictionary(fc.constantFrom('dlp', 'chaos', 'sessions', 'confidential', 'postQuantumTls'), anyv),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(section, (raw) => {
        try {
          validateConfig(raw);
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect(err).not.toBeInstanceOf(TypeError);
          expect(err).not.toBeInstanceOf(RangeError);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('auth with a strategy never validates without its credentials', () => {
    fc.assert(
      fc.property(fc.constantFrom('api-key', 'jwt'), fc.dictionary(fc.constantFrom('apiKeys', 'jwt', 'header'), fc.constantFrom(undefined, [], {}, '', null)), (strategy, rest) => {
        expect(() => validateConfig({ auth: { strategy, ...rest } })).toThrow();
      }),
      { numRuns: RUNS },
    );
  });

  it('arbitrary YAML text never crashes the parse + validate pipeline', () => {
    const yamlish = fc.oneof(
      fc.string({ maxLength: 200 }),
      configish.map((o) => JSON.stringify(o)),
      fc.constantFrom('a: &a [*a]', '!!binary AAAA', 'servers: !!map {}', '? [a, b]\n: c', '<<: {port: 1}', 'port: 0x10', "version: '10'"),
    );
    fc.assert(
      fc.property(yamlish, (text) => {
        let raw: unknown;
        try {
          raw = parseYaml(text, { maxAliasCount: 100 });
        } catch {
          return; // a YAML syntax error is a controlled rejection
        }
        try {
          validateConfig(raw ?? {});
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect(err).not.toBeInstanceOf(TypeError);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('YAML alias bombs are bounded', () => {
    const bomb = ['a: &a ["x","x","x","x","x","x","x","x","x"]', ...Array.from({ length: 9 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(9).fill('*' + String.fromCharCode(97 + i)).join(',')}]`)].join('\n');
    expect(() => parseYaml(bomb, { maxAliasCount: 100 })).toThrow(/alias/i);
  });
});

describe('JSON-RPC framing', () => {
  it('toMessages keeps exactly the jsonrpc 2.0 objects', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 3 }), (v) => {
        const out = toMessages(v);
        const list = Array.isArray(v) ? v : [v];
        expect(out.length).toBe(list.filter((m) => !!m && typeof m === 'object' && (m as { jsonrpc?: unknown }).jsonrpc === '2.0').length);
        for (const m of out) expect(m.jsonrpc).toBe('2.0');
      }),
      { numRuns: RUNS },
    );
  });

  it('stdio line framing: any split of the byte stream yields the same messages', () => {
    const msgs = fc.array(fc.record({ jsonrpc: fc.constant('2.0' as const), id: fc.nat(), method: fc.string({ maxLength: 20 }), params: fc.jsonValue({ maxDepth: 2 }) }), { maxLength: 8 });
    fc.assert(
      fc.property(msgs, fc.array(fc.string({ maxLength: 30 }).filter((s) => !s.includes('\n')), { maxLength: 4 }), fc.array(fc.nat(), { maxLength: 10 }), (list, noise, cuts) => {
        const ch = new StdioChannel({ id: 'p', name: 'p', transport: 'stdio', command: 'x' } as never, { killGraceMs: 1 } as never);
        const got: unknown[] = [];
        ch.onmessage = (m) => got.push(m);
        const text = [...noise.map((n) => `not json ${n}`), ...list.map((m) => JSON.stringify(m))].join('\n') + '\n';
        const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b);
        let prev = 0;
        const feed = (s: string) => {
          (ch as unknown as { buffer: string }).buffer += s;
          (ch as unknown as { drain(): void }).drain();
        };
        for (const p of points) {
          feed(text.slice(prev, p));
          prev = p;
        }
        feed(text.slice(prev));
        expect(got).toEqual(list.map((m) => JSON.parse(JSON.stringify(m))));
      }),
      { numRuns: RUNS },
    );
  });
});

describe('tool-argument size limit', () => {
  it('argumentsTooLarge is exactly "UTF-8 JSON byte length > limit" (0 = unlimited)', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 3 }), fc.nat({ max: 4096 }), (args, limit) => {
        const size = Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8');
        expect(argumentsTooLarge(args, limit)).toBe(limit > 0 && size > limit);
      }),
      { numRuns: RUNS },
    );
  });

  it('counts bytes, not UTF-16 code units (multi-byte characters cannot slip past)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', minLength: 1, maxLength: 50 }), (s) => {
        const bytes = Buffer.byteLength(JSON.stringify({ s }), 'utf8');
        expect(argumentsTooLarge({ s }, bytes)).toBe(false);
        expect(argumentsTooLarge({ s }, bytes - 1)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('JWT / bearer parsing', () => {
  const mockRes = () => {
    const res: { statusCode: number; body?: unknown; status(c: number): typeof res; json(b: unknown): typeof res; set(): typeof res; setHeader(): void } = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(b) {
        this.body = b;
        return this;
      },
      set() {
        return this;
      },
      setHeader() {},
    };
    return res;
  };
  const run = (mw: ReturnType<typeof createAuthMiddleware>, authorization: string) =>
    new Promise<{ next: boolean; status: number }>((resolve) => {
      const res = mockRes();
      const json = res.json.bind(res);
      res.json = (b: unknown) => {
        json(b);
        resolve({ next: false, status: res.statusCode });
        return res;
      };
      mw({ headers: { authorization }, ip: '127.0.0.1' } as never, res as never, () => resolve({ next: true, status: 200 }));
    });

  const b64 = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const tokenish = fc.oneof(
    fc.string({ maxLength: 300 }),
    fc.tuple(fc.jsonValue({ maxDepth: 2 }), fc.jsonValue({ maxDepth: 2 }), fc.string({ maxLength: 40 })).map(([h, p, s]) => `${b64(h)}.${b64(p)}.${s}`),
    fc.tuple(fc.constantFrom('none', 'HS256', 'RS256', 'ES256', 'EdDSA', ''), fc.jsonValue({ maxDepth: 2 })).map(([alg, p]) => `${b64({ alg, typ: 'JWT' })}.${b64(p)}.`),
  );

  it('the jwt strategy rejects every forged / malformed token with 401 and never calls next', async () => {
    const mw = createAuthMiddleware({ strategy: 'jwt', jwtSecret: 'a-strong-test-secret-of-32-bytes!!' } as never);
    await fc.assert(
      fc.asyncProperty(tokenish, async (t) => {
        const r = await run(mw, `Bearer ${t}`);
        expect(r.next).toBe(false);
        expect(r.status).toBe(401);
      }),
      { numRuns: RUNS },
    );
  });

  it('claim parsers never widen access on malformed claims', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 2 }), fc.jsonValue({ maxDepth: 2 }), (servers, tools) => {
        const scope = scopeFromJwt({ mcp_servers: servers, mcp_tools: tools });
        // A present claim always yields a list (possibly empty), never "unrestricted".
        if (servers !== null) expect(Array.isArray(scope?.servers)).toBe(true);
        if (servers !== null && !(Array.isArray(servers) || typeof servers === 'string')) expect(isServerInScope(scope, 'anything')).toBe(false);
        for (const s of tokenScopes({ scope: servers })) expect(typeof s).toBe('string');
      }),
      { numRuns: RUNS },
    );
    fc.assert(fc.property(fc.string({ maxLength: 200 }), (t) => void peekClaims(t)), { numRuns: RUNS });
  });
});

describe('Host header / SAN parsing', () => {
  it('a Host that is not literally allowed is never accepted', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (host) => {
        const ok = hostAllowed(['gateway.example.com', 'localhost'], host);
        const { hostname } = parseHostHeader(host);
        expect(ok).toBe(hostname === 'gateway.example.com' || hostname === 'localhost');
      }),
      { numRuns: RUNS },
    );
  });

  it('wildcard host patterns only match real subdomains', () => {
    fc.assert(
      fc.property(fc.domain(), (d) => {
        const ok = hostAllowed(['*.example.com'], d);
        expect(ok).toBe(d.toLowerCase().endsWith('.example.com') && d.length > '.example.com'.length);
      }),
      { numRuns: RUNS },
    );
  });

  it('SAN splitting never yields an ID from inside a quoted value', () => {
    fc.assert(
      fc.property(fc.array(fc.webUrl(), { maxLength: 3 }), fc.webUrl(), (urls, inner) => {
        const quoted = `URI:"${inner}, URI:spiffe://evil.org/x"`;
        const san = [...urls.map((u) => `URI:${u.replace(/,/g, '')}`), quoted].join(', ');
        expect(splitSan(san)).toHaveLength(urls.length + 1);
        expect(spiffeIdsOf({ subjectaltname: san })).not.toContain('spiffe://evil.org/x"');
        expect(spiffeIdsOf({ subjectaltname: san })).not.toContain('spiffe://evil.org/x');
      }),
      { numRuns: RUNS },
    );
  });
});

describe('/mcp endpoint fuzzing', () => {
  let gw: Gateway;
  let url: string;
  beforeAll(async () => {
    gw = new Gateway({ port: 0, host: '127.0.0.1', logLevel: 'error', monitor: { requestLog: false }, auth: { strategy: 'api-key', apiKeys: [{ key: 'k-fuzz', name: 'fuzz' }] }, servers: [] } as never);
    await gw.start();
    url = `http://127.0.0.1:${gw.address()!.port}`;
  });
  afterAll(() => gw.stop());

  it('arbitrary bodies get a JSON-RPC answer, never a 5xx', async () => {
    const body = fc.oneof(
      fc.string({ maxLength: 200 }),
      fc.jsonValue({ maxDepth: 3 }).map((v) => JSON.stringify(v)),
      fc.record({ jsonrpc: fc.constantFrom('2.0', '1.0', 2), id: fc.oneof(fc.nat(), fc.string(), fc.constant(null)), method: fc.oneof(fc.constantFrom('initialize', 'tools/list', 'tools/call', 'ping', 'resources/read', ''), fc.string()), params: fc.jsonValue({ maxDepth: 2 }) }, { requiredKeys: [] }).map((v) => JSON.stringify(v)),
    );
    await fc.assert(
      fc.asyncProperty(body, async (b) => {
        const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer k-fuzz', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: b });
        expect(r.status).toBeLessThan(500);
        await r.arrayBuffer();
      }),
      { numRuns: Math.min(RUNS, 100) },
    );
  });
});
