/*
 * mcp-gateway dashboard — static demo backend.
 *
 * Loaded only by the GitHub Pages build (see .github/workflows/pages.yml), before
 * the dashboard script. It replaces window.fetch for the gateway's own API
 * (`/`, `/api/v1/*`) with an in-browser simulation: five MCP servers (one of them
 * flapping), a dozen tools, several clients and a steady stream of tool calls,
 * served through the same JSON shapes and SSE events as the real gateway.
 * Nothing leaves the browser.
 */
(() => {
  'use strict';
  const VERSION = '3.2.0';
  const realFetch = window.fetch.bind(window);
  const started = Date.now();
  // Two workspaces so the tenants card can be tried out.
  const demoTenants = [
    { id: 'platform', name: 'Platform team', role: 'operator', servers: ['github', 'filesystem'], serverIds: ['github', 'filesystem'], members: [{ client: 'key:alice', role: 'owner' }, { client: 'key:ci', role: 'viewer' }] },
    { id: 'research', name: 'Research', role: 'operator', servers: ['search*'], serverIds: [], members: [{ client: 'jwt:bob', role: 'admin' }] },
  ];
  // One held tool call so the approvals card can be tried out.
  let demoApprovals = [{ id: 'demo-approval-1', status: 'pending', serverId: 'github', tool: 'create_issue', clientId: 'key:aura', via: 'mcp', rule: 'review-github-writes', arguments: { repo: 'HarrisonCN/aura', title: 'Crash on launch' }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString() }];
  const demoCache = { entries: 42, maxEntries: 1000, hits: 318, misses: 127, deduped: 9, evictions: 0 };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
  const iso = (ms) => new Date(ms).toISOString();

  // ─── Catalog ────────────────────────────────────────────────────────────────
  const str = (description) => ({ type: 'string', description });
  const SERVERS = [
    { id: 'filesystem', name: 'Filesystem', description: 'Read and write files under /srv/projects', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/projects'], tags: ['files', 'local'], base: 18, spread: 30, fail: 0.01,
      tools: [
        { name: 'read_file', description: 'Read the complete contents of a file', inputSchema: { type: 'object', properties: { path: str('Path to the file') }, required: ['path'] } },
        { name: 'write_file', description: 'Create or overwrite a file', inputSchema: { type: 'object', properties: { path: str('Path to the file'), content: str('File contents') }, required: ['path', 'content'] } },
        { name: 'list_directory', description: 'List files and folders in a directory', inputSchema: { type: 'object', properties: { path: str('Directory path') }, required: ['path'] } },
        { name: 'search_files', description: 'Recursively search for files matching a pattern', inputSchema: { type: 'object', properties: { path: str('Start directory'), pattern: str('Glob or substring') }, required: ['path', 'pattern'] } },
      ] },
    { id: 'github', name: 'GitHub', description: 'Repositories, issues and pull requests', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '***' }, tags: ['github', 'vcs'], base: 180, spread: 420, fail: 0.04,
      tools: [
        { name: 'search_repositories', description: 'Search GitHub repositories', inputSchema: { type: 'object', properties: { query: str('Search query'), perPage: { type: 'number', description: 'Results per page', default: 10 } }, required: ['query'] } },
        { name: 'get_issue', description: 'Get an issue by number', inputSchema: { type: 'object', properties: { owner: str('Repository owner'), repo: str('Repository name'), issue_number: { type: 'number', description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'] } },
        { name: 'create_issue', description: 'Open a new issue', inputSchema: { type: 'object', properties: { owner: str('Repository owner'), repo: str('Repository name'), title: str('Issue title'), body: str('Issue body') }, required: ['owner', 'repo', 'title'] } },
        { name: 'list_pull_requests', description: 'List pull requests in a repository', inputSchema: { type: 'object', properties: { owner: str('Repository owner'), repo: str('Repository name'), state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' } }, required: ['owner', 'repo'] } },
      ] },
    { id: 'postgres', name: 'Postgres', description: 'Read-only SQL against the analytics replica', transport: 'streamable-http', url: 'https://mcp.internal.example.com/postgres', tags: ['db'], base: 45, spread: 160, fail: 0.02,
      tools: [
        { name: 'query', description: 'Run a read-only SQL query', inputSchema: { type: 'object', properties: { sql: str('SQL statement') }, required: ['sql'] } },
        { name: 'list_tables', description: 'List tables in the public schema', inputSchema: { type: 'object', properties: {} } },
      ] },
    { id: 'search', name: 'Brave Search', description: 'Web search', transport: 'sse', url: 'https://mcp.example.com/brave/sse', tags: ['web'], base: 320, spread: 700, fail: 0.06,
      tools: [
        { name: 'brave_web_search', description: 'Search the web', inputSchema: { type: 'object', properties: { query: str('Search query'), count: { type: 'number', description: 'Number of results', default: 5 } }, required: ['query'] } },
        { name: 'brave_local_search', description: 'Search for local businesses and places', inputSchema: { type: 'object', properties: { query: str('What and where') }, required: ['query'] } },
      ] },
    { id: 'slack', name: 'Slack', description: 'Post and read team messages', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], env: { SLACK_BOT_TOKEN: '***' }, tags: ['chat'], base: 140, spread: 260, fail: 0.05, flapping: true,
      tools: [
        { name: 'slack_post_message', description: 'Post a message to a channel', inputSchema: { type: 'object', properties: { channel_id: str('Channel ID'), text: str('Message text') }, required: ['channel_id', 'text'] } },
        { name: 'slack_get_channel_history', description: 'Recent messages in a channel', inputSchema: { type: 'object', properties: { channel_id: str('Channel ID'), limit: { type: 'number', default: 10 } }, required: ['channel_id'] } },
      ] },
  ];
  const CLIENTS = [['claude-desktop', 5], ['cursor', 4], ['claude-code', 3], ['ci-bot', 1], ['anonymous', 1]];
  const ERRORS = ['Upstream timed out after 30000ms', 'Tool returned an error: rate limit exceeded', 'ECONNRESET', 'Invalid arguments: missing required property'];

  // ─── Server health ──────────────────────────────────────────────────────────
  const health = new Map();
  for (const s of SERVERS) {
    health.set(s.id, { serverId: s.id, status: 'online', lastChecked: iso(started), toolCount: s.tools.length, connectedSince: iso(started - rnd(2, 30) * 3_600_000), reconnect: { state: 'idle', attempt: 0, reconnects: s.flapping ? 2 : 0 } });
  }
  const setOffline = (id) => {
    const h = health.get(id);
    const err = `Server "${id}" closed the connection (exit code 1)`;
    Object.assign(h, { status: 'reconnecting', errorMessage: err, toolCount: 0, connectedSince: undefined, reconnect: { state: 'scheduled', attempt: 1, reconnects: h.reconnect.reconnects, nextAttemptAt: iso(Date.now() + 4000), lastError: err } });
  };
  const setOnline = (id) => {
    const h = health.get(id), s = SERVERS.find((x) => x.id === id);
    Object.assign(h, { status: 'online', errorMessage: undefined, toolCount: s.tools.length, connectedSince: iso(Date.now()), reconnect: { state: 'idle', attempt: 0, reconnects: h.reconnect.reconnects + 1 } });
  };
  const isUp = (id) => health.get(id).status === 'online';
  // The Slack server drops every ~75s and comes back after a few retries.
  const flap = () => { if (isUp('slack')) { setOffline('slack'); setTimeout(() => isUp('slack') || setOnline('slack'), rnd(8000, 16000)); } };
  setTimeout(flap, 20_000);
  setInterval(flap, 75_000);
  const pingBase = { filesystem: 2, github: 6, postgres: 14, search: 38, slack: 9 };
  const tickHealth = () => { const now = iso(Date.now()); for (const h of health.values()) { h.lastChecked = now; if (h.status === 'online') h.latencyMs = Math.round(pingBase[h.serverId] * rnd(0.7, 1.6)); else delete h.latencyMs; } };
  tickHealth();
  setInterval(tickHealth, 5000);

  // ─── Request log ────────────────────────────────────────────────────────────
  const records = [];
  const listeners = new Set();
  const weighted = (pairs) => { let n = Math.random() * pairs.reduce((a, [, w]) => a + w, 0); for (const [v, w] of pairs) if ((n -= w) < 0) return v; return pairs[0][0]; };
  const serverWeights = [['filesystem', 6], ['github', 4], ['postgres', 3], ['search', 2], ['slack', 1.5]];
  function makeRecord(ts, live) {
    const sid = weighted(serverWeights);
    let s = SERVERS.find((x) => x.id === sid);
    if (live && !isUp(s.id) && Math.random() < 0.7) s = SERVERS[0];
    const tool = pick(s.tools);
    const down = live && !isUp(s.id);
    const ok = !down && Math.random() > s.fail;
    const dur = Math.round(down ? rnd(1, 4) : ok ? s.base * (0.5 + Math.random()) + Math.random() ** 3 * s.spread : rnd(s.base, s.base + s.spread * 2));
    const r = { id: uuid(), timestamp: ts, serverId: s.id, toolName: tool.name, durationMs: Math.max(1, dur), success: ok, clientId: weighted(CLIENTS), via: Math.random() < 0.7 ? 'mcp' : 'rest', kind: 'tool' };
    if (r.clientId === 'anonymous') delete r.clientId;
    if (!ok) r.errorMessage = down ? `Server "${s.id}" is not connected` : pick(ERRORS);
    return r;
  }
  // Six hours of history with a gentle daily curve, so every window has data.
  for (let t = started - 6 * 3_600_000; t < started; t += rnd(2500, 9000) / (1 + 0.6 * Math.sin(t / 3_600_000))) records.push(makeRecord(Math.round(t), false));
  function add(r) {
    records.push(r);
    const cutoff = Date.now() - 24 * 3_600_000;
    while (records.length && records[0].timestamp < cutoff) records.shift();
    for (const fn of listeners) fn(r);
  }
  (function loop() {
    const burst = Math.random() < 0.08 ? 4 : 1;
    for (let i = 0; i < burst; i++) add(makeRecord(Date.now(), true));
    setTimeout(loop, rnd(400, 2200));
  })();

  // ─── Stats (same algorithm as src/gateway/live.ts) ─────────────────────────
  const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))] : 0);
  const asc = (a, b) => a - b;
  function stats(windowMs, bucketMs, now = Date.now()) {
    const n = Math.max(1, Math.ceil(windowMs / bucketMs));
    const end = Math.floor(now / bucketMs) * bucketMs + bucketMs, start = end - n * bucketMs;
    const bl = Array.from({ length: n }, () => []), be = new Array(n).fill(0), all = [];
    let errors = 0;
    const tools = new Map(), servers = new Map(), clients = new Map();
    for (const m of records) {
      const ts = m.timestamp;
      if (ts < now - windowMs || ts > now) continue;
      const i = Math.min(n - 1, Math.max(0, Math.floor((ts - start) / bucketMs)));
      bl[i].push(m.durationMs); all.push(m.durationMs);
      if (!m.success) { be[i]++; errors++; }
      const tk = m.serverId + '\0' + m.toolName;
      const t = tools.get(tk) || { name: m.toolName, serverId: m.serverId, count: 0, errors: 0, lat: [] };
      t.count++; if (!m.success) t.errors++; t.lat.push(m.durationMs); tools.set(tk, t);
      const s = servers.get(m.serverId) || { count: 0, errors: 0, lat: [] };
      s.count++; if (!m.success) s.errors++; s.lat.push(m.durationMs); servers.set(m.serverId, s);
      const cid = m.clientId || 'anonymous';
      const c = clients.get(cid) || { count: 0, errors: 0, lastSeen: 0 };
      c.count++; if (!m.success) c.errors++; c.lastSeen = Math.max(c.lastSeen, ts); clients.set(cid, c);
    }
    all.sort(asc);
    const byCount = (a, b) => b.count - a.count;
    return {
      windowMs, bucketMs, now,
      summary: { total: all.length, errors, errorRate: all.length ? errors / all.length : 0, requestsPerMinute: all.length / (windowMs / 60000), p50: pct(all, 0.5), p95: pct(all, 0.95), p99: pct(all, 0.99) },
      series: bl.map((lat, i) => { lat.sort(asc); return { t: start + i * bucketMs, count: lat.length, errors: be[i], p50: pct(lat, 0.5), p95: pct(lat, 0.95) }; }),
      tools: [...tools.values()].map((t) => ({ name: t.name, serverId: t.serverId, count: t.count, errors: t.errors, p95: pct(t.lat.sort(asc), 0.95) })).sort(byCount),
      servers: [...servers.entries()].map(([id, s]) => ({ id, count: s.count, errors: s.errors, p95: pct(s.lat.sort(asc), 0.95) })).sort(byCount),
      clients: [...clients.entries()].map(([id, c]) => ({ id, ...c })).sort(byCount),
    };
  }
  function windowOf(q) {
    const w = Math.min(24 * 3_600_000, Math.max(10_000, Number(q.get('window')) || 900_000));
    const minB = Math.max(1000, Math.ceil(w / 360));
    const b = Math.min(w, Math.max(minB, Number(q.get('bucket')) || Math.max(minB, Math.round(w / 60))));
    return [w, b];
  }

  // ─── API ────────────────────────────────────────────────────────────────────
  const wire = (r) => ({ ...r, timestamp: iso(r.timestamp) });
  const strip = (o) => JSON.parse(JSON.stringify(o));
  const serverView = (s) => {
    const { base, spread, fail, flapping, tools, ...cfg } = s;
    const h = health.get(s.id);
    const out = { ...cfg, enabled: true, timeout: 30000, maxConcurrency: 10, health: strip(h), toolCount: h.toolCount };
    if (h.status === 'online') out.session = { transport: s.transport, protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: s.id + '-mcp', version: '1.' + (s.id.length % 4) + '.0' }, connectedAt: h.connectedSince };
    return out;
  };
  const healthSummary = () => {
    const hs = [...health.values()], c = (st) => hs.filter((h) => h.status === st).length;
    const online = c('online');
    return { status: online === hs.length ? 'healthy' : online ? 'degraded' : 'unhealthy', version: VERSION, uptime: (Date.now() - started) / 1000 + 9 * 86400, servers: { total: hs.length, online, offline: c('offline'), degraded: c('degraded'), reconnecting: c('reconnecting'), unknown: 0, totalTools: hs.reduce((a, h) => a + h.toolCount, 0) } };
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sampleResult(serverId, tool, args) {
    switch (tool) {
      case 'read_file': return `# ${args.path || 'README.md'}\n\nmcp-gateway — one endpoint for all your MCP servers.\n`;
      case 'list_directory': return '[DIR] src\n[DIR] test\n[FILE] package.json\n[FILE] README.md\n[FILE] tsconfig.json';
      case 'search_files': return '/srv/projects/mcp-gateway/src/gateway/index.ts\n/srv/projects/mcp-gateway/src/gateway/live.ts';
      case 'write_file': return `Successfully wrote to ${args.path || 'file'}`;
      case 'search_repositories': return JSON.stringify({ total_count: 2, items: [{ full_name: 'HarrisonCN/mcp-gateway', stargazers_count: 128 }, { full_name: 'modelcontextprotocol/servers', stargazers_count: 52000 }] }, null, 2);
      case 'query': return JSON.stringify([{ day: '2026-10-06', signups: 412 }, { day: '2026-10-07', signups: 389 }], null, 2);
      case 'list_tables': return 'events\nsignups\nsubscriptions\nusers';
      case 'brave_web_search': return `1. Model Context Protocol — https://modelcontextprotocol.io\n2. MCP specification — https://spec.modelcontextprotocol.io`;
      default: return JSON.stringify({ ok: true, server: serverId, tool, arguments: args }, null, 2);
    }
  }

  function events(q, signal) {
    const [w, b] = windowOf(q);
    const enc = new TextEncoder();
    let snapTimer, onReq;
    const body = new ReadableStream({
      start(ctrl) {
        const send = (ev, data) => { try { ctrl.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {} };
        const snap = () => { const s = stats(w, b); send('snapshot', { now: s.now, health: [...health.values()].map(strip), summary: s.summary, last: s.series[s.series.length - 1] }); };
        ctrl.enqueue(enc.encode('retry: 3000\n\n'));
        snap();
        snapTimer = setInterval(snap, 5000);
        onReq = (r) => send('request', wire(r));
        listeners.add(onReq);
        signal?.addEventListener('abort', () => { clearInterval(snapTimer); listeners.delete(onReq); try { ctrl.error(new DOMException('Aborted', 'AbortError')); } catch {} });
      },
      cancel() { clearInterval(snapTimer); listeners.delete(onReq); },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
  }

  async function handle(url, init) {
    const path = url.pathname.replace(/^.*?(\/api\/v1)/, '$1');
    const q = url.searchParams, method = (init?.method || 'GET').toUpperCase();
    let m;
    if (!path.startsWith('/api/v1')) return json({ name: 'mcp-gateway', version: VERSION, docs: '/api/v1/health', mcp: '/mcp', dashboard: '/dashboard' });
    const p = path.slice(7);
    await sleep(rnd(40, 160));
    if (p === '/health') return json(healthSummary());
    if (p === '/stats') { const [w, b] = windowOf(q); return json(stats(w, b)); }
    if (p === '/events') return events(q, init?.signal);
    if (p === '/servers') return json({ servers: SERVERS.map(serverView), total: SERVERS.length });
    if ((m = p.match(/^\/servers\/([^/]+)$/)) && method === 'GET') { const sv = SERVERS.find((x) => x.id === decodeURIComponent(m[1])); return sv ? json(serverView(sv)) : json({ error: 'Not Found', message: `Server "${decodeURIComponent(m[1])}" not found` }, 404); }
    if (p === '/security') return json({
      authStrategy: 'api-key',
      warnings: [
        { id: 'plaintext-api-keys', level: 'info', message: '1 API key(s) are stored in plain text. Store "sha256:<hex>" digests instead (mcp-gateway hash-key).' },
        { id: 'api-keys-expiring', level: 'warn', message: '1 API key(s) expire within 7 days: ci.' },
      ],
      apiKeys: { total: 4, hashed: 3, disabled: 0, expired: 0, expiring: [{ name: 'ci', expiresAt: iso(started + 3 * 86400000) }] },
      jwt: null,
      settings: { headers: true, hsts: true, dnsRebindingProtection: false, allowedHosts: ['gateway.example.com'], ipAllowlist: 2, trustProxy: 1, maxBodyBytes: 10485760, maxToolArgumentsBytes: 262144, redactPatterns: 0, authLockout: { maxFailures: 10, windowSeconds: 300, lockoutSeconds: 900 } },
      lockout: { lockedClients: 1, trackedClients: 3, lockoutsTotal: 2 },
    });
    if (p === '/tools') return json({ tools: SERVERS.filter((s) => isUp(s.id)).flatMap((s) => s.tools.map((t) => ({ ...t, serverId: s.id, serverName: s.name }))), total: SERVERS.reduce((a, s) => a + (isUp(s.id) ? s.tools.length : 0), 0) });
    if (p === '/approvals') return json({ pending: demoApprovals, recent: [] });
    if (p === '/catalog') return json({ install: false, installedServers: [], entries: [
      { id: 'filesystem', name: 'Filesystem', description: 'Read, write and search files in allowed directories', template: { transport: 'stdio' }, installed: ['filesystem'] },
      { id: 'memory', name: 'Memory', description: 'Knowledge-graph based persistent memory', template: { transport: 'stdio' }, installed: [] },
      { id: 'github', name: 'GitHub', description: 'GitHub repositories, issues and pull requests (remote server)', template: { transport: 'streamable-http' }, installed: ['github'] },
    ] });
    // Usage metering + quotas (1.8), result cache (2.2), load balancing (2.1), policy (2.0 / 2.8).
    if (p === '/quotas') {
      const day = new Date(); day.setUTCHours(24, 0, 0, 0);
      const since = Date.now() - 3600000;
      const count = (fn) => records.filter((r) => r.timestamp >= since && fn(r)).length;
      return json({
        rules: [{ id: 'per-tenant-daily', subject: 'tenant', period: 'day', limit: 500 }, { id: 'ci-hourly', subject: 'client', match: 'ci-bot', period: 'hour', limit: 60 }],
        usage: [
          { rule: 'per-tenant-daily', period: 'day', limit: 500, subject: 'tenant:platform', used: Math.min(468, 212 + Math.round(count((r) => r.serverId === 'github' || r.serverId === 'filesystem') / 3)), resetsAt: day.toISOString() },
          { rule: 'per-tenant-daily', period: 'day', limit: 500, subject: 'tenant:research', used: Math.min(400, 37 + Math.round(count((r) => r.serverId === 'search') / 3)), resetsAt: day.toISOString() },
          { rule: 'ci-hourly', period: 'hour', limit: 60, subject: 'client:ci-bot', used: Math.min(58, 41 + Math.round(count((r) => r.clientId === 'ci-bot') / 4)), resetsAt: iso(Math.ceil(Date.now() / 3600000) * 3600000) },
        ],
      });
    }
    if (p === '/usage') {
      const by = new Map();
      for (const r of records) { const k = r.clientId || 'anonymous'; const u = by.get(k) || { client: k, calls: 0, errors: 0, durationMs: 0 }; u.calls++; if (!r.success) u.errors++; u.durationMs += r.durationMs; by.set(k, u); }
      return json({ group: ['client'], rows: [...by.values()].sort((a, b) => b.calls - a.calls), generatedAt: iso(Date.now()) });
    }
    if (p === '/cache' && method === 'DELETE') { const n = demoCache.entries; demoCache.entries = 0; return json({ purged: n }); }
    if (p === '/cache') { demoCache.hits += Math.round(rnd(0, 4)); demoCache.misses += Math.round(rnd(0, 2)); demoCache.entries = Math.min(demoCache.maxEntries, demoCache.entries + Math.round(rnd(0, 2))); return json({ enabled: true, ...demoCache }); }
    if (p === '/load-balancing') {
      const up = isUp('search');
      return json({ groups: [{ server: 'search', strategy: 'least-latency', failoverOn: ['timeout', 'connection'], members: [
        { id: 'search', weight: 1, connected: up, healthy: up, latencyMs: health.get('search').latencyMs || 40, calls: records.filter((r) => r.serverId === 'search').length, errors: records.filter((r) => r.serverId === 'search' && !r.success).length },
        { id: 'search@2', weight: 2, connected: true, healthy: true, latencyMs: 31, calls: 58, errors: 1 },
        { id: 'search@3', weight: 1, connected: true, healthy: false, ejectedUntil: iso(Date.now() + 25000), latencyMs: 912, calls: 12, errors: 5 },
      ] }] });
    }
    if (p === '/policy') return json({ rules: 3, default: 'allow', approval: { pending: demoApprovals.length, timeoutSeconds: 300 }, outputFilter: { enabled: true, action: 'redact', findings: { email: 4, 'aws-key': 1 } } });
    if (p === '/admin/deprecations') return json({ version: VERSION, deprecations: [] });
    if (p === '/tenants') return json({ clientId: 'key:demo', operator: true, tenants: demoTenants });
    if ((m = p.match(/^\/tenants\/([^/]+)\/members$/)) && method === 'PUT') {
      const tn = demoTenants.find((x) => x.id === decodeURIComponent(m[1]));
      if (!tn) return json({ error: 'Tenant not found' }, 404);
      const b = JSON.parse(init?.body || '{}');
      const mem = tn.members.find((x) => x.client === b.client);
      if (mem) mem.role = b.role; else tn.members.push({ client: b.client, role: b.role });
      return json(tn);
    }
    if ((m = p.match(/^\/approvals\/([^/]+)\/(approve|deny)$/)) && method === 'POST') {
      const a = demoApprovals.find((x) => x.id === decodeURIComponent(m[1]));
      if (!a) return json({ error: 'Approval request not found' }, 404);
      demoApprovals = demoApprovals.filter((x) => x !== a);
      if (!demoApprovals.length) setTimeout(() => { demoApprovals.push({ ...a, id: uuid(), status: 'pending', createdAt: iso(Date.now()), expiresAt: iso(Date.now() + 300000) }); }, 20000);
      return json({ ...a, status: m[2] === 'approve' ? 'approved' : 'denied', decidedAt: new Date().toISOString() });
    }
    if ((m = p.match(/^\/servers\/([^/]+)\/reconnect$/)) && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      if (!health.has(id)) return json({ error: 'Not Found', message: `Server "${id}" not found` }, 404);
      await sleep(rnd(500, 1200));
      setOnline(id);
      return json({ ok: true, server: serverView(SERVERS.find((s) => s.id === id)) });
    }
    // Request details + replay (3.2): demo arguments are derived from the tool's input schema.
    if ((m = p.match(/^\/requests\/([^/]+)(\/replay)?$/))) {
      const r = records.find((x) => x.id === decodeURIComponent(m[1]));
      if (!r) return json({ error: 'Not Found', message: 'No captured call with that id (it may have been evicted)' }, 404);
      const s = SERVERS.find((x) => x.id === r.serverId);
      const tool = s.tools.find((x) => x.name === r.toolName);
      const demoArgs = r.args || (r.args = Object.fromEntries(Object.keys(tool?.inputSchema?.properties || {}).slice(0, 2).map((k) => [k, k === 'path' ? '/srv/projects/README.md' : k === 'query' || k === 'q' ? 'mcp gateway' : 'demo'])));
      const resultOf = (a) => ({ content: [{ type: 'text', text: sampleResult(r.serverId, r.toolName, a) }] });
      const captured = { id: r.id, timestamp: iso(r.timestamp), serverId: r.serverId, tool: r.toolName, kind: 'tool', clientId: r.clientId, via: r.via, durationMs: r.durationMs, success: r.success, arguments: demoArgs, ...(r.success ? { result: resultOf(demoArgs) } : { error: { code: -32603, message: r.errorMessage } }), ...(r.replayOf ? { replayOf: r.replayOf } : {}) };
      if (!m[2]) return json(captured);
      if (method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
      let b = {};
      try { b = JSON.parse(init?.body || '{}'); } catch {}
      const a = b.arguments || demoArgs;
      await sleep(rnd(60, 180));
      const up = isUp(s.id);
      const res = resultOf(a);
      const nr = { id: uuid(), timestamp: Date.now(), serverId: s.id, toolName: r.toolName, durationMs: Math.round(s.base * (0.5 + Math.random())), success: up, clientId: 'key:demo', via: 'rest', kind: 'tool', args: a, replayOf: r.id };
      if (!up) nr.errorMessage = `Server "${s.id}" is not connected`;
      add(nr);
      const before = captured.result ? captured.result.content[0].text : undefined;
      const diff = up && before !== undefined ? (before === res.content[0].text ? [] : [{ path: 'content[0].text', change: 'changed', before, after: res.content[0].text }]) : null;
      return json({
        original: { id: r.id, serverId: r.serverId, arguments: demoArgs, success: r.success, durationMs: r.durationMs, result: captured.result, error: captured.error },
        replay: up ? { status: 200, requestId: nr.id, server: s.id, arguments: a, durationMs: nr.durationMs, body: { result: res, server: s.id, tool: r.toolName, durationMs: nr.durationMs, requestId: nr.id } } : { status: 503, server: s.id, arguments: a, body: { error: 'Service Unavailable', message: nr.errorMessage } },
        diff, identical: diff ? diff.length === 0 : null,
      });
    }
    if (p === '/requests') {
      const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 50));
      const f = { server: q.get('server'), tool: q.get('tool'), clientId: q.get('clientId') || q.get('client'), success: q.get('success'), via: q.get('via') };
      const until = q.get('cursor') ? Number(q.get('cursor')) : Infinity;
      const out = [];
      for (let i = records.length - 1; i >= 0 && out.length <= limit; i--) {
        const r = records[i];
        if (r.timestamp >= until) continue;
        if (f.server && r.serverId !== f.server) continue;
        if (f.tool && r.toolName !== f.tool) continue;
        if (f.clientId && (r.clientId || 'anonymous') !== f.clientId) continue;
        if (f.success && String(r.success) !== f.success) continue;
        if (f.via && r.via !== f.via) continue;
        out.push(r);
      }
      const more = out.length > limit;
      const page = out.slice(0, limit);
      return json({ requests: page.map(wire), source: 'audit', ...(more ? { nextCursor: String(page[page.length - 1].timestamp) } : {}) });
    }
    if (p === '/tools/call' && method === 'POST') {
      let body = {};
      try { body = JSON.parse(init.body || '{}'); } catch {}
      const s = SERVERS.find((x) => x.id === body.server) || SERVERS.find((x) => x.tools.some((t) => t.name === body.tool));
      const t0 = Date.now();
      if (!s || !s.tools.some((t) => t.name === body.tool)) return json({ error: 'Not Found', message: `Tool "${body.tool}" not found` }, 404);
      if (!isUp(s.id)) { add({ id: uuid(), timestamp: Date.now(), serverId: s.id, toolName: body.tool, durationMs: 2, success: false, errorMessage: `Server "${s.id}" is not connected`, via: 'rest', kind: 'tool' }); return json({ error: 'Service Unavailable', message: `Server "${s.id}" is not connected` }, 503); }
      await sleep(s.base * (0.5 + Math.random()));
      const durationMs = Date.now() - t0;
      add({ id: uuid(), timestamp: Date.now(), serverId: s.id, toolName: body.tool, durationMs, success: true, via: 'rest', kind: 'tool' });
      return json({ result: { content: [{ type: 'text', text: sampleResult(s.id, body.tool, body.arguments || {}) }] }, server: s.id, tool: body.tool, durationMs });
    }
    return json({ error: 'Not Found', message: `${method} ${path} is not part of the demo` }, 404);
  }

  window.fetch = function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin === location.origin && (/\/api\/v1(\/|$)/.test(url.pathname) || url.pathname === '/')) return handle(url, init);
    return realFetch(input, init);
  };
  window.__MCP_GATEWAY_DEMO__ = true;
  // Land visitors on the live overview; the guide stays one tap away (? button, or ?guide).
  try { if (!localStorage.getItem('mcp-gateway.onboarded.v2')) localStorage.setItem('mcp-gateway.onboarded.v2', '1'); } catch {}

  // A small, dismissible ribbon so nobody mistakes the demo for a real gateway.
  document.addEventListener('DOMContentLoaded', () => {
    const zh = (localStorage.getItem('mcp-gateway.lang') || navigator.language || '').startsWith('zh');
    const bar = document.createElement('div');
    bar.setAttribute('role', 'note');
    bar.style.cssText = 'position:fixed;left:50%;bottom:' + (innerWidth < 760 ? 'calc(78px + env(safe-area-inset-bottom))' : '14px') + ';white-space:nowrap;transform:translateX(-50%);z-index:9999;display:flex;gap:10px;align-items:center;padding:8px 10px 8px 14px;border-radius:999px;font:500 12.5px/1.3 system-ui,-apple-system,sans-serif;color:#fff;background:rgba(17,17,27,.88);box-shadow:0 6px 24px rgba(0,0,0,.25);backdrop-filter:blur(8px);max-width:calc(100vw - 24px)';
    bar.innerHTML = (zh ? '在线演示 · 模拟数据' : 'Live demo · simulated data') +
      ' <a href="https://github.com/HarrisonCN/mcp-gateway" style="color:#9ecbff;text-decoration:none;white-space:nowrap">' + (zh ? '自己部署 →' : 'Run your own →') + '</a>' +
      '<button type="button" aria-label="Close" style="all:unset;cursor:pointer;padding:0 6px;opacity:.7">✕</button>';
    bar.querySelector('button').onclick = () => bar.remove();
    document.body.appendChild(bar);
  });
})();
