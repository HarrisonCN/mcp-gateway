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
  const VERSION = '11.1.0';
  const realFetch = window.fetch.bind(window);
  const started = Date.now();
  // Two workspaces so the tenants card can be tried out.
  const demoTenants = [
    { id: 'platform', name: 'Platform team', role: 'operator', servers: ['github', 'filesystem'], serverIds: ['github', 'filesystem'], members: [{ client: 'key:alice', role: 'owner' }, { client: 'key:ci', role: 'viewer' }] },
    { id: 'research', name: 'Research', role: 'operator', servers: ['search*'], serverIds: [], members: [{ client: 'jwt:bob', role: 'admin' }] },
  ];
  // One held tool call so the approvals card can be tried out.
  let demoConfig = {
    version: 10, port: 4000, logLevel: 'info',
    auth: { strategy: 'api-key', apiKeys: ['<redacted>', { key: '<redacted>', name: 'aura', scope: { servers: ['github', 'fs-*'] } }] },
    rateLimit: { limit: 120, windowSeconds: 60 },
    mcp: { toolNaming: 'auto' },
    controlPlane: { role: 'control', configApi: true },
    servers: [
      { id: 'github', name: 'GitHub', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/', timeoutMs: 30000 },
      { id: 'filesystem', name: 'Filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'] },
      { id: 'search', name: 'Search', transport: 'streamable-http', url: 'https://search.internal:8443/mcp', tls: { spiffeId: 'spiffe://example.org/ns/tools/*' } },
    ],
    // 10.0: schema v10 — feature-module sections live under `features`.
    features: { sla: { targets: [{ id: 'gold', availability: 99.9 }] } },
  };
  let demoApprovals = [{ id: 'demo-approval-1', status: 'pending', serverId: 'github', tool: 'create_issue', clientId: 'key:aura', via: 'mcp', rule: 'review-github-writes', arguments: { repo: 'HarrisonCN/aura', title: 'Crash on launch' }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString() }];
  const demoCache = { entries: 42, maxEntries: 1000, hits: 318, misses: 127, deduped: 9, evictions: 0 };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
  const iso = (ms) => new Date(ms).toISOString();
  // 5.1+: feature modules mounted under /api/v1/admin/<id> (one entry per release that adds one).
  const DEMO_FEATURES = [
    { id: 'conformance', since: '5.1.0', summary: "MCP conformance self-test of this gateway's /mcp endpoint" },
    { id: "regions", since: "5.2.0", summary: "Multi-region active-active: replicated state, peer health, cross-region failover routing" },
    { id: "edge-fleet", since: "5.3.0", summary: "Managed edge nodes: fleet view with config drift, push config to edges" },
    { id: "marketplace", since: "5.4.0", summary: "Signed plugin marketplace: browse indexes, verified install" },
    { id: "sessions", since: "5.5.0", summary: "Agent session recording, replay and regression evals" },
    { id: "dlp", since: "5.6.0", summary: "Data loss prevention: sensitivity levels, per-tenant clearance and masking" },
    { id: "adaptive", since: "5.8.0", summary: "Adaptive routing 2.0: pick upstream / model by quality, cost and latency (Thompson sampling)" },
    { id: "api-upstreams", since: "6.1.0", summary: "GraphQL and gRPC (Connect / JSON transcoding) upstreams exposed as tools" },
    { id: "genai-otel", since: "6.3.0", summary: "OpenTelemetry GenAI semantic conventions: execute_tool spans, operation duration and token usage metrics, OTLP export" },
    { id: "identity", since: "6.4.0", summary: "Enterprise SSO (OIDC ID tokens) and SCIM 2.0 user / group provisioning mapped to tenant roles" },
    { id: "policy-sim", since: "6.5.0", summary: "Policy simulation and dry-run: replay history against a candidate policy, shadow policies on live traffic" },
    { id: "anomaly", since: "6.6.0", summary: "Anomaly detection: traffic bursts, error spikes, tool enumeration and prompt-injection scoring with alert / quarantine" },
    { id: "billing", since: "6.7.0", summary: "Usage billing: per-tenant metering against a price book, monthly invoices (JSON / CSV)" },
    { id: "k8s", since: "6.8.0", summary: "Kubernetes: render manifests for this gateway; McpGateway operator (server-side apply) and Helm chart" },
    { id: "terraform", since: "7.1.0", summary: "Terraform: REST resources for servers, tenants and API keys (restapi provider) and HCL export with import blocks" },
    { id: "console", since: "7.2.0", summary: "SaaS console: organisations with plans (servers, daily call limits), onboarding, suspension" },
    { id: "sanitize", since: "7.3.0", summary: "Prompt-injection defence: tool-output sanitisation (hidden Unicode, ANSI, HTML, exfil images), spotlighting, inbound / outbound blocking" },
    { id: "semantic-cache", since: "7.4.0", summary: "Semantic cache: answer paraphrased tool calls from earlier results by embedding similarity (tenant-isolated)" },
    { id: "rollouts", since: "7.5.0", summary: "Tool versioning and gradual rollout: sticky percentage canaries per server with automatic rollback" },
    { id: "offline", since: "7.6.0", summary: "Offline desktop gateway: connectivity probe, fail-fast for remote upstreams when offline, desktop-client config import" },
    { id: "approval-flows", since: "7.7.0", summary: "Approvals 2.0: multi-step, conditional approval flows with named approvers and escalation" },
    { id: "compliance-reports", since: "7.8.0", summary: "Automated compliance reports: scheduled SOC 2 / ISO 27001 / GDPR evidence bundles with SHA-256 manifests" },
    { id: "agent-identity", since: "8.1.0", summary: "Agent identity & delegated auth: agent registry, on-behalf-of delegation tokens (RFC 8693 act chains), scoped agent calls" },
    { id: "a2a-federation", since: "8.2.0", summary: "Cross-gateway A2A federation: remote agent discovery (agent cards), skill catalog, task forwarding with shared audit" },
    { id: "debug-sessions", since: "8.3.0", summary: "Live collaborative debugging: shared sessions, live call stream (SSE), breakpoints, edit/resume/abort, notes, replay" },
    { id: "cost-advisor", since: "8.4.0", summary: "Cost optimization advisor: quantified caching, failure, cheaper-upstream and budget recommendations from live traffic" },
    { id: "blue-green", since: "8.5.0", summary: "Zero-downtime blue/green upgrades: probed atomic switch, in-flight drain, verification window with auto-rollback" },
    { id: "data-lineage", since: "8.6.0", summary: "Data lineage: value fingerprints link tool outputs to later tool inputs (graph, trace by value, OpenLineage export)" },
    { id: "config-assistant", since: "8.7.0", summary: "Natural-language config assistant: plain-words changes \u2192 validated config patch, diff (dry run), apply" },
    { id: "chaos", since: "8.8.0", summary: "Chaos testing: scheduled or on-demand latency / error / timeout / corruption injection with a steady-state guard" },
    { id: "multimodal", since: "9.1.0", summary: "Multimodal tools: content-type policy and size limits for image / audio / blob results, offloaded and streamed in chunks" },
    { id: "edge-runtime", since: "9.2.0", summary: "Edge WASM runtime 2.0: WebAssembly tools with a warm instance pool, SHA-256 pins and per-tool time / memory / concurrency quotas" },
    { id: "confidential", since: "9.3.0", summary: "Confidential computing: sensitive servers get calls only from inside a remotely attested TEE (SEV-SNP, TDX, Nitro, SGX)" },
    { id: "tool-registry", since: "9.4.0", summary: "Global tool registry: signed tool manifests, search, cross-gateway mirrors, immutable versions and version pins" },
    { id: "sla", since: "9.5.0", summary: "SLA monitoring: availability / p95 latency objectives per server and tenant, error budgets, breaches and service-credit reports" },
    { id: "self-healing", since: "9.6.0", summary: "Self-healing: eject / fail over, roll back or throttle unhealthy upstreams automatically, lifted after a cool-down" },
    { id: "pq-tls", since: "9.7.0", summary: "Post-quantum TLS: hybrid X25519MLKEM768 key exchange for upstream HTTPS, PQ handshake probes and a certificate policy" },
    { id: "ecosystem", since: "9.8.0", summary: "Ecosystem marketplace GA: moderated catalogue of plugins and tools, ratings and reviews, verified publishers" },
    { id: "kernel", since: "10.0.0", summary: "Unified gateway kernel: config schema v10, feature modules, call-hook pipeline and LTS status in one view" },
  ];

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
      return json({ groups: [{ server: 'search', strategy: 'smart', failoverOn: ['timeout', 'connection'], members: [
        { id: 'search', weight: 1, connected: up, healthy: up, latencyMs: health.get('search').latencyMs || 40, calls: records.filter((r) => r.serverId === 'search').length, errors: records.filter((r) => r.serverId === 'search' && !r.success).length },
        { id: 'search@2', weight: 2, connected: true, healthy: true, latencyMs: 31, calls: 58, errors: 1 },
        { id: 'search@3', weight: 1, connected: true, healthy: false, ejectedUntil: iso(Date.now() + 25000), latencyMs: 912, calls: 12, errors: 5 },
      ] }] });
    }
    // 3.3: plugins, one of them a WASM sandbox per tenant.
    if (p === '/plugins') return json({ plugins: [
      { name: 'audit-tags', apiVersion: 2, kind: 'module', hooks: ['onToolCall', 'onResponse'] },
      { name: 'pii-guard', apiVersion: 4, kind: 'wasm', hooks: ['onToolCall', 'onResponse'], isolation: 'tenant', sandboxes: demoTenants.map((t, i) => ({ key: 'tenant:' + t.id, calls: 120 + i * 37 + Math.round((Date.now() - started) / 4000), alive: true })) },
    ] });
    // 3.4: smart routing — a canary split and a smart-scored replica group.
    if (p === '/routing') {
      const t = Math.round((Date.now() - started) / 1000);
      return json({
        splits: [{ name: 'search-canary', server: 'search', tools: ['brave_*'], sticky: 'client', variants: [
          { server: 'search', label: 'stable', weight: 90, effectiveWeight: 90, calls: 900 + t * 3, errors: 31 + Math.floor(t / 20), errorRate: 0.034, latencyMs: 412 },
          { server: 'search-v2', label: 'canary', weight: 10, effectiveWeight: 10, calls: 100 + Math.floor(t / 3), errors: 2, errorRate: 0.02, latencyMs: 288 },
        ] }],
        groups: [{ server: 'postgres', strategy: 'smart', failoverOn: ['not-connected', 'timeout'], members: [
          { id: 'postgres', weight: 1, connected: true, healthy: true, latencyMs: 61, calls: 1200 + t, errors: 4, score: 0.71 },
          { id: 'postgres~1', weight: 1, connected: true, healthy: true, latencyMs: 44, calls: 1630 + t * 2, errors: 2, score: 0.52 },
        ] }],
      });
    }
    if ((m = p.match(/^\/routing\/splits\/([^/]+)\/reset$/)) && method === 'POST') {
      if (decodeURIComponent(m[1]) !== 'search-canary') return json({ error: 'Not Found', message: `No traffic split "${m[1]}"` }, 404);
      return json({ ok: true, split: { name: 'search-canary', server: 'search', sticky: 'client', variants: [{ server: 'search', label: 'stable', weight: 90, effectiveWeight: 90, calls: 0, errors: 0, errorRate: 0 }, { server: 'search-v2', label: 'canary', weight: 10, effectiveWeight: 10, calls: 0, errors: 0, errorRate: 0 }] } });
    }
    // 3.5: secrets — references and rotation status only, never values.
    if (p === '/secrets') {
      const ago = (s) => iso(Date.now() - s * 1000);
      return json({
        providers: [{ id: 'vault', type: 'vault' }, { id: 'kms', type: 'aws-kms' }, { id: 'env', type: 'env' }],
        rotation: { intervalSeconds: 900 },
        secrets: [
          { ref: 'secret://vault/mcp/github#token', provider: 'vault', type: 'vault', version: 3, fetchedAt: ago(120), rotatedAt: ago(3600 * 20), usedBy: ['server:github'] },
          { ref: 'secret://vault/mcp/slack#bot_token', provider: 'vault', type: 'vault', version: 1, fetchedAt: ago(120), usedBy: ['server:slack'] },
          { ref: 'secret://vault/tenants/{tenant}/search#key', provider: 'vault', type: 'vault', version: 1, fetchedAt: ago(40), usedBy: ['server:search'] },
          { ref: 'secret://kms/AQICAHh…', provider: 'kms', type: 'aws-kms', version: 1, fetchedAt: ago(600), usedBy: ['server:postgres'] },
        ],
      });
    }
    if (p === '/secrets/rotate' && method === 'POST') { await sleep(rnd(80, 180)); return json({ rotated: ['github'] }); }
    // 3.6: federation — this demo gateway peers with two other regions.
    if (p === '/federation' || (p === '/federation/sync' && method === 'POST')) {
      const exported = SERVERS.map((s) => s.id);
      const peerServers = (down) => SERVERS.filter((s) => s.id !== down).map((s) => ({ id: s.id, name: s.name, status: 'online', tools: s.tools.map((t) => t.name) }));
      return json({ enabled: true, gatewayId: 'demo-us', region: 'us-east-1', exported, peers: [
        { id: 'eu-west', url: 'https://eu.gateway.example', region: 'eu-west-1', priority: 1, healthy: true, lastSync: iso(Date.now() - rnd(1000, 25000)), latencyMs: 84, servers: peerServers('postgres'), forwarded: 12 + Math.round((Date.now() - started) / 30000) },
        { id: 'ap-south', url: 'https://ap.gateway.example', region: 'ap-south-1', priority: 2, healthy: !isUp('slack') ? true : Math.random() > 0.1, lastSync: iso(Date.now() - rnd(1000, 25000)), latencyMs: 211, servers: peerServers('slack'), forwarded: 3 },
      ] });
    }
    // 3.7: compliance — PII redaction counters, residency, SOC 2 / GDPR reports.
    if (p === '/compliance') {
      const k = Math.round((Date.now() - started) / 15000);
      return json({
        pii: { action: 'redact', scope: 'both', categories: ['email', 'phone', 'credit-card', 'ssn', 'iban', 'ipv4', 'cn-id'], servers: ['*'] },
        residency: { rules: [{ tenants: ['research'], regions: ['eu-*'] }], allowUnknown: false, servers: [{ id: 'postgres', region: 'eu-west-1' }, { id: 'search', region: 'us-east-1' }] },
        findings: { 'arguments:email': 14 + k, 'results:email': 31 + 2 * k, 'results:phone': 6 + k, 'results:ipv4': 3 },
        blocked: { pii: 0, residency: 2 + Math.floor(k / 4) },
      });
    }
    if (p === '/compliance/report') {
      const fw = q.get('framework') || 'soc2';
      if (fw !== 'soc2' && fw !== 'gdpr') return json({ error: 'Bad Request', message: '"framework" must be soc2 or gdpr' }, 400);
      const controls = fw === 'soc2' ? [
        { id: 'CC6.1', title: 'Logical access is authenticated', status: 'pass', evidence: 'auth.strategy = api-key' },
        { id: 'CC6.1-b', title: 'Access is scoped per tenant / role', status: 'pass', evidence: '2 tenant(s) configured' },
        { id: 'CC6.7', title: 'Data in transit to upstreams is encrypted', status: 'pass', evidence: '2 TLS / 0 plain-HTTP upstream(s)' },
        { id: 'CC7.2', title: 'Activity is logged and retained', status: 'pass', evidence: 'audit log on, 30 day retention' },
        { id: 'CC8.1', title: 'Credentials are managed and rotated', status: 'pass', evidence: '2 secret provider(s), rotation every 900s' },
      ] : [
        { id: 'Art.5(1)(c)', title: 'Data minimisation: personal data is redacted', status: 'pass', evidence: 'PII redact on both' },
        { id: 'Art.30', title: 'Records of processing activities', status: 'pass', evidence: 'audit log on' },
        { id: 'Art.44', title: 'International transfers are restricted (data residency)', status: 'pass', evidence: '1 residency rule(s)' },
      ];
      const rep = { framework: fw, generatedAt: iso(Date.now()), gatewayVersion: VERSION, period: { since: iso(Date.now() - 30 * 86400e3), until: iso(Date.now()) }, summary: { pass: controls.length, warn: 0, fail: 0 }, controls, activity: { calls: records.length, errors: records.filter((r) => !r.success).length, denied: 2, clients: CLIENTS.map(([c, w]) => ({ client: c, calls: w * 40 })), piiFindings: { email: 31 }, blocked: { pii: 0, residency: 2 } }, warnings: [] };
      if (q.get('format') === 'md') return new Response(`# ${fw === 'soc2' ? 'SOC 2' : 'GDPR'} compliance report\n\n` + controls.map((c) => `- ${c.id} — ${c.title}: ${c.status}`).join('\n') + '\n', { status: 200, headers: { 'content-type': 'text/markdown' } });
      return json(rep);
    }
    // 3.8: developer portal (also served as portal.html on GitHub Pages).
    if (p.startsWith('/portal/')) {
      const demoKey = { id: 'demo1234', name: 'Demo app', email: 'you@example.com', prefix: 'mgw_demo00', status: 'active', createdAt: iso(started - 86400e3 * 3), servers: ['filesystem', 'search'], rateLimit: { limit: 60, windowSeconds: 60 }, expiresAt: iso(started + 86400e3 * 87), clientId: 'key:portal-demo1234' };
      if (p === '/portal/info') return json({ title: 'MCP Gateway developer portal (demo)', signup: 'open', allowedEmailDomains: [], version: VERSION, defaults: { servers: ['filesystem', 'search'], rateLimit: { limit: 60, windowSeconds: 60 }, keyTtlDays: 90 } });
      if (p === '/portal/signup' && method === 'POST') {
        let b = {};
        try { b = JSON.parse(init?.body || '{}'); } catch {}
        if (!b.name || !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(b.email || '')) return json({ error: 'Bad Request', message: '"name" and a valid "email" are required' }, 400);
        return json({ ...demoKey, id: uuid().slice(0, 8), name: b.name, email: b.email, key: 'mgw_demo_' + uuid().replace(/-/g, '').slice(0, 24), message: 'Your key is active. It is shown only once — store it now. (Demo: any key works here.)' }, 201);
      }
      if (p === '/portal/me' && method === 'GET') {
        const mine = records.filter((r) => r.serverId === 'filesystem' || r.serverId === 'search');
        const byDay = Array.from({ length: 7 }, (_, i) => ({ day: iso(Date.now() - (6 - i) * 86400e3).slice(0, 10), calls: Math.round(20 + 15 * Math.sin(i) + i * 4) + (i === 6 ? Math.min(mine.length, 25) : 0) }));
        const byTool = {};
        for (const r of mine) byTool[r.serverId + '/' + r.toolName] = (byTool[r.serverId + '/' + r.toolName] || 0) + 1;
        return json({ key: demoKey, usage: { since: iso(Date.now() - 7 * 86400e3), calls: byDay.reduce((n, d) => n + d.calls, 0), errors: mine.filter((r) => !r.success).length + 3, avgLatencyMs: 186, byDay, byTool: Object.entries(byTool).map(([tool, calls]) => ({ tool, calls })) } });
      }
      if (p === '/portal/me/rotate' && method === 'POST') return json({ ...demoKey, key: 'mgw_demo_' + uuid().replace(/-/g, '').slice(0, 24), message: 'New key issued; the previous one no longer works.' });
      if (p === '/portal/me' && method === 'DELETE') return json({ ...demoKey, status: 'revoked' });
      if (p === '/portal/tools') {
        const ex = (schema) => Object.fromEntries((schema.required || []).map((k) => [k, schema.properties[k].default ?? (schema.properties[k].type === 'number' ? 1 : k === 'path' ? '/srv/projects/README.md' : 'mcp gateway')]));
        const base = new URL('.', location.href).href.replace(/\/$/, '');
        const tools = SERVERS.filter((s) => s.id === 'filesystem' || s.id === 'search').flatMap((s) => s.tools.map((t) => {
          const example = ex(t.inputSchema);
          const body = JSON.stringify({ server: s.id, tool: t.name, arguments: example });
          return { server: s.id, name: t.name, description: t.description, inputSchema: t.inputSchema, example, snippets: {
            curl: `curl -s ${base}/api/v1/tools/call \\\n  -H "Authorization: Bearer $MCP_GATEWAY_KEY" -H "Content-Type: application/json" \\\n  -d '${body}'`,
            javascript: `const res = await fetch('${base}/api/v1/tools/call', {\n  method: 'POST',\n  headers: { Authorization: \`Bearer \${process.env.MCP_GATEWAY_KEY}\`, 'Content-Type': 'application/json' },\n  body: JSON.stringify(${body}),\n});\nconsole.log((await res.json()).result);`,
            python: `import os, requests\nr = requests.post("${base}/api/v1/tools/call",\n    headers={"Authorization": f"Bearer {os.environ['MCP_GATEWAY_KEY']}"},\n    json=${body})\nprint(r.json()["result"])`,
          } };
        }));
        return json({ tools, total: tools.length, tryIt: base + '/api/v1/tools/call' });
      }
      if (p === '/portal/keys') return json({ keys: [demoKey, { ...demoKey, id: 'pend0001', name: 'Data team notebook', email: 'data@example.com', status: 'pending', prefix: 'mgw_pend00', clientId: 'key:portal-pend0001' }] });
      if ((m = p.match(/^\/portal\/keys\/([^/]+)\/(approve|deny|revoke)$/)) && method === 'POST') return json({ ...demoKey, id: decodeURIComponent(m[1]), status: m[2] === 'approve' ? 'active' : m[2] === 'deny' ? 'denied' : 'revoked' });
    }

    if (p === '/mcp/protocol') {
      const vs = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      const intro = { annotations: '2025-03-26', structuredContent: '2025-06-18', outputSchema: '2025-06-18', resourceLink: '2025-06-18', toolTitle: '2025-06-18', elicitation: '2025-06-18' };
      return json({ latest: vs[0], supported: vs, features: Object.fromEntries(vs.map((v) => [v, Object.fromEntries(Object.entries(intro).map(([f, d]) => [f, v >= d]))])),
        upstream: [{ server: 'github', protocolVersion: '2025-11-25' }, { server: 'filesystem', protocolVersion: '2025-06-18' }, { server: 'search', protocolVersion: '2025-03-26' }] });
    }
    if (p === '/chains') return json({ toolPrefix: 'chain_', chains: [
      { name: 'triage', tool: 'chain_triage', description: 'Search issues, summarise each with the agent, file a report', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, steps: 3, targets: ['github/search_issues', 'agent/summarise', 'github/create_issue'], allowed: true },
      { name: 'research', tool: 'chain_research', description: 'Web + docs search in parallel, merged', inputSchema: { type: 'object' }, steps: 2, targets: ['search/web', 'docs/search', 'agent/merge'], allowed: true },
    ], recent: [{ chain: 'triage', success: true, durationMs: 1840, steps: [{ id: 'hits', tool: 'github/search_issues', status: 'ok', durationMs: 310, calls: 1 }, { id: 'summaries', tool: 'agent/summarise', status: 'ok', durationMs: 1420, calls: 6 }, { id: 'report', tool: 'github/create_issue', status: 'skipped', durationMs: 0, calls: 0 }] }] });
    if ((m = p.match(/^\/chains\/([^/]+)\/run$/)) && method === 'POST') {
      await sleep(150);
      return json({ chain: decodeURIComponent(m[1]), success: true, output: { text: 'Demo chain output' }, durationMs: 150, steps: [{ id: 'step0', status: 'ok', durationMs: 150, calls: 1 }] });
    }
    if (p === '/costs') {
      const by = q.get('by') || 'client';
      const rows = { client: [['key:aura', 18.42, 1240, 812000, 204000], ['key:ci', 3.1, 410, 120000, 31000], ['key:demo', 0.84, 96, 30000, 9000]], model: [['gpt-4o', 14.9, 610, 702000, 190000], ['claude-sonnet', 6.6, 520, 230000, 48000], ['(none)', 0.86, 616, 0, 0]], server: [['llm', 21.5, 1130, 932000, 238000], ['search', 0.86, 616, 0, 0]] }[by] || [];
      return json({ currency: 'USD', period: q.get('period') || 'month', by, totals: rows.map(([key, cost, calls, inputTokens, outputTokens]) => ({ key, cost, calls, inputTokens, outputTokens })),
        budgets: [{ name: 'team-monthly', subject: '*', period: 'month', limit: 50, spent: 22.36, used: 0.447, action: 'alert' }, { name: 'per-key-daily', subject: 'key:aura', period: 'day', limit: 2, spent: 1.71, used: 0.855, action: 'block' }],
        alerts: [{ budget: 'per-key-daily', subject: 'key:aura', threshold: 0.8, spent: 1.62, limit: 2, at: iso(Date.now() - 3600000), period: iso(Date.now()).slice(0, 10) }] });
    }
    if (p === '/tools/stream' && method === 'POST') {
      const steps = ['Searching…', 'Found 3 matches', 'Summarising'];
      const ev = (e, d) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
      let body = '';
      steps.forEach((m, i) => { body += ev('progress', { progress: i + 1, total: 3, message: m }) + ev('partial', { text: m }); });
      await sleep(120);
      body += ev('result', { status: 200, success: true, result: { content: [{ type: 'text', text: 'Demo streamed result' }] } }) + ev('end', { coalesced: 0 });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (p === '/mtls') return json({ enabled: true,
      identity: { spiffeId: 'spiffe://example.org/ns/gateway/sa/mcp-gateway', subject: 'O=SPIRE', notAfter: iso(Date.now() + 40 * 60000), fingerprint: '4B:1F:…:9C', expiresInHours: 1, loadedAt: iso(Date.now() - 20 * 60000), rotations: 17 },
      peers: [{ server: 'search', spiffeIds: ['spiffe://example.org/ns/tools/sa/search'], at: iso(Date.now() - 30000) }],
      servers: [{ id: 'github', mtls: false, spiffeId: null }, { id: 'search', mtls: true, spiffeId: 'spiffe://example.org/ns/tools/*' }] });
    if (p === '/admin/config' && method === 'GET') return json({ version: VERSION, config: demoConfig });
    if (p === '/admin/config' || p.startsWith('/admin/config/')) {
      let body = {};
      try { body = JSON.parse(init?.body || '{}'); } catch { return json({ error: 'Bad Request', message: 'Invalid JSON' }, 400); }
      const errors = [];
      if (!Array.isArray(body.servers)) errors.push('servers: Expected array');
      for (const [i, s] of (body.servers || []).entries()) {
        if (!s.id || !/^[A-Za-z0-9._-]+$/.test(s.id)) errors.push(`servers.${i}.id: letters, digits, ".", "_" or "-"`);
        if (s.transport !== 'stdio' && !/^https?:\/\/[^/]+/.test(s.url || '')) errors.push(`servers.${i}.url: Invalid url`);
      }
      if (p === '/admin/config/validate') return json({ valid: !errors.length, errors });
      if (errors.length) return json({ error: 'Bad Request', message: 'Invalid configuration', errors }, 400);
      const changes = [];
      const keys = new Set([...Object.keys(demoConfig), ...Object.keys(body)]);
      for (const k of keys) {
        const a = JSON.stringify(demoConfig[k]), b = JSON.stringify(body[k]);
        if (a !== b) changes.push({ path: k, change: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed' });
      }
      if (p === '/admin/config/diff') return json({ changes });
      if (method === 'PUT') {
        await sleep(120);
        if (q.get('dryRun') === 'true' || !changes.length) return json({ applied: false, changes });
        demoConfig = JSON.parse(JSON.stringify(body));
        return json({ applied: true, changes });
      }
    }
    // 4.8: edge control plane (snapshot + node list) for edge gateways with `sync`.
    if (p === '/admin/edge/snapshot') return json({ version: VERSION, generatedAt: iso(Date.now()), etag: 'demo-edge-1',
      config: { servers: [{ id: 'github', url: 'https://api.githubcopilot.com/mcp/', catalog: [{ name: 'search_issues' }, { name: 'create_issue' }] }], apiKeys: ['sha256:' + '0'.repeat(64)], toolNaming: 'auto' } });
    if (p === '/admin/edge/nodes') return json({ nodes: [
      { edgeId: 'cf-hkg', firstSeen: iso(Date.now() - 86400000), lastSeen: iso(Date.now() - 20000), lastSync: iso(Date.now() - 20000), snapshotEtag: 'demo-edge-1', events: 1840, errors: 12, queuedCalls: 0, replayed: 7 },
      { edgeId: 'deno-fra', firstSeen: iso(Date.now() - 3600000), lastSeen: iso(Date.now() - 900000), lastSync: iso(Date.now() - 900000), snapshotEtag: 'demo-edge-1', events: 96, errors: 3, queuedCalls: 4, replayed: 0 },
    ] });
    if (p === '/admin/edge/sync' && method === 'POST') {
      await sleep(80);
      let body = {};
      try { body = JSON.parse(init?.body || '{}'); } catch { return json({ error: 'Bad Request', message: 'Invalid JSON' }, 400); }
      if (!body.edgeId) return json({ error: 'Bad Request', message: '"edgeId" is required' }, 400);
      return json({ accepted: (body.events || []).length, dropped: 0 });
    }
    // 5.1: feature modules + MCP conformance self-test.
    if (p === '/admin/features') return json({ version: VERSION, features: DEMO_FEATURES.map((f) => ({ ...f, path: '/api/v1/admin/' + f.id })) });
    if (p === '/admin/conformance/checks') return json({ checks: ['initialize', 'version-negotiation', 'parse-error', 'invalid-request', 'ping', 'method-not-found', 'notification-202', 'tools-list', 'unknown-tool', 'bad-protocol-header', 'unknown-session'].map((id) => ({ id, title: id })) });
    if (p === '/admin/conformance/run' && method === 'POST') {
      await sleep(150);
      const ids = ['initialize', 'version-negotiation', 'parse-error', 'invalid-request', 'ping', 'method-not-found', 'notification-202', 'tools-list', 'unknown-tool', 'bad-protocol-header', 'unknown-session'];
      return json({ url: location.origin + '/mcp', startedAt: iso(Date.now()), durationMs: 148, passed: ids.length, failed: 0, skipped: 0, checks: ids.map((id) => ({ id, title: id, status: 'pass' })) });
    }
    // 5.2: multi-region active-active.
    if (p === '/admin/regions') return json({ self: 'eu-west', syncIntervalMs: 5000, keys: 3, peers: [
      { id: 'us-east', url: 'https://us.gw.example.com', priority: 1, status: 'up', failures: 0, lastSync: iso(Date.now() - 3000), cursor: Date.now() - 3000, servers: ['github', 'filesystem'] },
      { id: 'ap-south', url: 'https://ap.gw.example.com', priority: 2, status: 'down', failures: 4, lastSync: iso(Date.now() - 600000), lastError: 'HTTP 503', cursor: Date.now() - 600000, servers: [] },
    ] });
    if (p.startsWith('/admin/regions/route/')) {
      const id = decodeURIComponent(p.slice('/admin/regions/route/'.length));
      return json(id === 'slack' ? { serverId: id, target: 'peer', peer: 'us-east', url: 'https://us.gw.example.com' } : { serverId: id, target: 'local' });
    }
    // 5.3: managed edge fleet (drift view + push).
    if (p === '/admin/edge-fleet') return json({ etag: 'demo-edge-2', counts: { 'in-sync': 1, stale: 1, unmanaged: 1 }, nodes: [
      { id: 'cf-hkg', url: 'https://edge-hkg.example.workers.dev', labels: { ring: 'canary' }, managed: true, drift: 'in-sync', appliedEtag: 'demo-edge-2', lastSeen: iso(Date.now() - 20000), lastSync: iso(Date.now() - 20000), queuedCalls: 0, errors: 12 },
      { id: 'deno-fra', url: 'https://fra.example.deno.dev', labels: { ring: 'stable' }, managed: true, drift: 'stale', appliedEtag: 'demo-edge-1', lastSeen: iso(Date.now() - 900000), lastSync: iso(Date.now() - 900000), queuedCalls: 4, errors: 3 },
      { id: 'laptop-dev', labels: {}, managed: false, drift: 'unmanaged', appliedEtag: 'demo-edge-2', lastSeen: iso(Date.now() - 60000), queuedCalls: 0, errors: 0 },
    ] });
    if (p === '/admin/edge-fleet/push' && method === 'POST') {
      await sleep(120);
      return json({ pushed: 1, failed: 0, results: [{ id: 'deno-fra', ok: true, status: 200, config: 'updated', durationMs: 118 }] });
    }
    // 5.4: signed plugin marketplace.
    if (p === '/admin/marketplace') return json({ dir: 'plugins', errors: {}, plugins: [
      { name: 'pii-guard', version: '1.2.0', description: 'Block tool calls that carry national ID numbers', url: 'https://plugins.example.com/pii-guard-1.2.0.mjs', sha256: 'a'.repeat(64), signature: 'ZGVtbw==', keyId: 'acme-2026', kind: 'module', index: 'https://plugins.example.com/index.json', trusted: true },
      { name: 'rate-shaper', version: '0.4.1', description: 'Token-bucket shaping per tenant (WASM)', url: 'https://plugins.example.com/rate-shaper-0.4.1.wasm', sha256: 'b'.repeat(64), signature: 'ZGVtbw==', keyId: 'acme-2026', kind: 'wasm', index: 'https://plugins.example.com/index.json', trusted: true },
      { name: 'unknown-vendor', version: '2.0.0', url: 'https://other.example/x.mjs', sha256: 'c'.repeat(64), signature: 'ZGVtbw==', keyId: 'someone', index: 'https://plugins.example.com/index.json', trusted: false },
    ] });
    if (p === '/admin/marketplace/install' && method === 'POST') {
      await sleep(150);
      let body = {};
      try { body = JSON.parse(init?.body || '{}'); } catch { return json({ error: 'Bad Request', message: 'Invalid JSON' }, 400); }
      if (!body.name) return json({ error: 'Bad Request', message: '"name" is required' }, 400);
      if (body.name === 'unknown-vendor') return json({ error: 'Unprocessable Entity', message: 'signature check failed: untrusted key "someone"' }, 422);
      return json({ name: body.name, version: '1.2.0', file: '/srv/gw/plugins/' + body.name + '-1.2.0.mjs', keyId: 'acme-2026', plugin: { module: './plugins/' + body.name + '-1.2.0.mjs', name: body.name } });
    }
    // 5.5: agent session recordings + regression evals.
    if (p === '/admin/sessions' && method === 'GET') return json({ replayEnabled: true, recordings: [
      { name: 'triage-flow', createdAt: iso(Date.now() - 86400000), clientId: 'ci-bot', steps: 4, tools: ['search_issues', 'create_issue'] },
      { name: 'release-notes', createdAt: iso(Date.now() - 3600000), steps: 2, tools: ['list_commits'] },
    ] });
    if (/^\/admin\/sessions\/[^/]+\/replay$/.test(p) && method === 'POST') {
      await sleep(180);
      const name = decodeURIComponent(p.split('/')[3]);
      return json({ recording: name, mode: 'structure', steps: 4, passed: 3, failed: 1, skipped: 0, passRate: 0.75, latency: { recordedMs: 820, replayMs: 655 }, outcomes: [
        { index: 0, serverId: 'github', tool: 'search_issues', passed: true, durationMs: 210, recordedMs: 240 },
        { index: 1, serverId: 'github', tool: 'search_issues', passed: true, durationMs: 190, recordedMs: 230 },
        { index: 2, serverId: 'github', tool: 'create_issue', passed: false, reason: 'result shape changed', durationMs: 160, recordedMs: 200, diff: [{ path: 'structuredContent.number', change: 'changed', before: 'number', after: 'string' }] },
        { index: 3, serverId: 'slack', tool: 'post_message', passed: true, durationMs: 95, recordedMs: 150 },
      ] });
    }
    // 5.6: DLP.
    if (p === '/admin/dlp') return json({ enabled: true, scope: 'results',
      levels: { email: 'internal', phone: 'internal', ipv4: 'internal', iban: 'confidential', 'credit-card': 'restricted', ssn: 'restricted', 'cn-id': 'restricted', 'employee-id': 'confidential' },
      default: { clearance: 'internal', strategy: 'mask' }, tenants: { finance: { clearance: 'restricted', strategy: 'mask' }, trial: { clearance: 'public', strategy: 'block' } },
      stats: { calls: 412, byCategory: { email: 230, 'credit-card': 9, 'employee-id': 41 }, byLevel: { internal: 230, confidential: 41, restricted: 9 }, byAction: { allow: 230, mask: 47, block: 3 } } });
    if (p === '/admin/dlp/classify' && method === 'POST') {
      let body = {};
      try { body = JSON.parse(init?.body || '{}'); } catch { return json({ error: 'Bad Request', message: 'Invalid JSON' }, 400); }
      const v = String(body.value ?? '');
      const findings = [];
      const out = v.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => { findings.push({ category: 'credit-card', level: 'restricted', path: '', action: body.tenant === 'finance' ? 'allow' : 'mask' }); return body.tenant === 'finance' ? m : '•'.repeat(m.length - 4) + m.slice(-4); });
      return json({ policy: body.tenant === 'finance' ? { clearance: 'restricted', strategy: 'mask' } : { clearance: 'internal', strategy: 'mask' }, blocked: false, findings, value: out });
    }
    // 5.8: adaptive routing 2.0.
    if (p === '/admin/adaptive') return json({ pools: [{ id: 'summarize', objective: { quality: 0.6, cost: 0.3, latency: 0.1 }, maxCostPerCall: 0.02, candidates: [
      { id: 'small', server: 'llm', tool: 'complete', costPerCall: 0.001, calls: 1840, errorRate: 0.004, latencyMs: 420, quality: 0.71, feedback: 212, picks: 1302 },
      { id: 'large', server: 'llm', tool: 'complete', costPerCall: 0.015, calls: 610, errorRate: 0.002, latencyMs: 1350, quality: 0.93, feedback: 188, picks: 538 },
    ] }] });
    if (p === '/admin/adaptive/pick' && method === 'POST') return json({ pool: 'summarize', candidate: 'small', server: 'llm', tool: 'complete', args: { model: 'gpt-mini' }, scores: [
      { id: 'small', quality: 0.74, normCost: 0.07, normLatency: 0.31, errorRate: 0.004, score: 0.39 },
      { id: 'large', quality: 0.9, normCost: 1, normLatency: 1, errorRate: 0.002, score: 0.14 },
    ] });
    if (p === '/admin/adaptive/feedback' && method === 'POST') return json({ pool: 'summarize', candidate: 'small', quality: 0.71 });

    // 6.1: GraphQL / gRPC upstreams.
    if (p === '/admin/api-upstreams') return json({ upstreams: [{ id: 'shop', kind: 'graphql', url: 'https://shop.example/graphql' }, { id: 'billing', kind: 'grpc', url: 'https://billing.example' }], tools: [
      { name: 'shop.product', upstream: 'shop', kind: 'graphql', description: 'Look up a product', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
      { name: 'billing.getInvoice', upstream: 'billing', kind: 'grpc', description: 'billing.v1.Invoices/Get', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    ] });
    if (p === '/admin/api-upstreams/call' && method === 'POST') { await sleep(60); return json({ tool: 'shop.product', success: true, result: { product: { id: 'p-1', title: 'Demo mug', price: 12 } }, durationMs: 58 }); }
    // 6.3: OpenTelemetry GenAI semantic conventions.
    if (p === '/admin/genai-otel') return json({ enabled: true, systems: { llm: 'openai' }, captureContent: false, otlpEndpoint: 'http://otel-collector:4318', spans: 412,
      'gen_ai.client.operation.duration': [{ attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'gpt-mini', 'gen_ai.tool.name': 'complete' }, count: 128, sum: 61.4, min: 0.21, max: 2.9 }, { attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search_issues' }, count: 284, sum: 34.1, min: 0.03, max: 0.8 }],
      'gen_ai.client.token.usage': [{ attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-mini', 'gen_ai.token.type': 'input' }, count: 128, sum: 96500, min: 40, max: 3100 }, { attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-mini', 'gen_ai.token.type': 'output' }, count: 128, sum: 21400, min: 5, max: 900 }] });
    if (p === '/admin/genai-otel/spans') return json({ spans: [{ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'chat gpt-mini', startMs: Date.now() - 480, endMs: Date.now(), attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'gpt-mini', 'gen_ai.usage.input_tokens': 812, 'gen_ai.usage.output_tokens': 140, 'gen_ai.tool.name': 'complete' } }] });
    // 6.4: enterprise SSO and SCIM.
    if (p === '/admin/identity') return json({ oidc: { issuer: 'https://acme.okta.com', clientId: '0oa1example', groupsClaim: 'groups' }, groupRoles: [{ group: 'Platform', tenant: 'acme', role: 'owner' }, { group: 'Engineering', tenant: 'acme', role: 'admin' }, { group: 'Support', tenant: 'globex', role: 'viewer' }], users: 148, activeUsers: 141, groups: 9, scimBase: '/api/v1/admin/identity/scim/v2' });
    if (p === '/admin/identity/scim/v2/Users') return json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [
      { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], id: 'u-1', userName: 'ada@acme.example', displayName: 'Ada Lovelace', active: true, meta: { resourceType: 'User', created: iso(Date.now() - 864e5 * 30), lastModified: iso(Date.now() - 864e5), version: 'W/"3"' } },
      { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], id: 'u-2', userName: 'grace@acme.example', displayName: 'Grace Hopper', active: false, meta: { resourceType: 'User', created: iso(Date.now() - 864e5 * 60), lastModified: iso(Date.now() - 864e5 * 2), version: 'W/"5"' } },
    ] }, 200);
    if (p === '/admin/identity/memberships') return json({ user: 'ada@acme.example', active: true, groups: ['Engineering'], memberships: [{ tenant: 'acme', role: 'admin', via: 'Engineering' }] });
    // 6.5: policy simulation and dry-run.
    if (p === '/admin/policy-sim/simulate' && method === 'POST') { await sleep(80); return json({ source: 'replay', calls: 1840, withArguments: 1840, unchanged: 1771, changed: 69, transitions: { 'allow→deny': 52, 'allow→approve': 17 }, byRule: { 'read-only': 1610, '(default)': 230 },
      byClient: { 'key:ci-bot': { changed: 41, newlyDenied: 41 }, 'key:aura': { changed: 28, newlyDenied: 11 } }, byTool: { 'github/create_issue': { changed: 39, newlyDenied: 22 }, 'fs/write_file': { changed: 30, newlyDenied: 30 } }, examples: [] }); }
    if (p === '/admin/policy-sim/shadow') return json({ enabled: true, evaluated: 5120, agree: 5004, diverged: 116, transitions: { 'allow→deny': 104, 'allow→approve': 12 }, divergences: [{ timestamp: iso(Date.now() - 4e3), clientId: 'key:ci-bot', serverId: 'github', tool: 'create_issue', enforced: { effect: 'allow' }, shadow: { effect: 'deny' } }] });
    if (p === '/admin/policy-sim/dry-run' && method === 'POST') return json({ call: { serverId: 'fs', tool: 'write_file', args: { path: '/etc/hosts' } }, enforced: { effect: 'approve', rule: 'etc-writes' }, shadow: { effect: 'deny' } });
    // 6.6: anomaly detection.
    if (p === '/admin/anomaly') return json({ enabled: true, action: 'quarantine', alerts: [
      { timestamp: iso(Date.now() - 9e3), client: 'key:trial-42', kind: 'enumeration', detail: '31 distinct tools in 5 min' },
      { timestamp: iso(Date.now() - 64e3), client: 'key:aura', kind: 'prompt-injection', detail: 'results: ignore-instructions, exfil-url', serverId: 'web', tool: 'fetch', score: 1 },
      { timestamp: iso(Date.now() - 300e3), client: 'key:ci-bot', kind: 'burst', detail: '412 calls this minute (baseline 38.2/min)' },
    ], quarantined: [{ client: 'key:trial-42', until: iso(Date.now() + 240e3) }], clients: [{ client: 'key:aura', baselinePerMinute: 12.4, windowCalls: 61, windowErrors: 1 }, { client: 'key:ci-bot', baselinePerMinute: 38.2, windowCalls: 190, windowErrors: 4 }] });
    if (p === '/admin/anomaly/score' && method === 'POST') return json({ score: 1, signals: ['ignore-instructions', 'prompt-exfiltration'], threshold: 0.6 });
    // 6.7: usage billing and invoices.
    if (p === '/admin/billing/invoices') return json({ period: iso(Date.now()).slice(0, 7), currency: 'USD', total: 1342.18, invoices: [
      { number: 'INV-DEMO-ACME', account: 'acme', name: 'ACME Corp', period: iso(Date.now()).slice(0, 7), currency: 'USD', subtotal: 1180.4, discount: 118.04, minimumTopUp: 0, tax: 87.65, total: 1150.01 },
      { number: 'INV-DEMO-GLOBEX', account: 'globex', name: 'Globex', period: iso(Date.now()).slice(0, 7), currency: 'USD', subtotal: 142.17, discount: 0, minimumTopUp: 0, tax: 0, total: 142.17 },
      { number: 'INV-DEMO-TRIAL', account: 'trial-42', period: iso(Date.now()).slice(0, 7), currency: 'USD', subtotal: 3.1, discount: 0, minimumTopUp: 46.9, tax: 0, total: 50 },
    ] });
    if ((m = p.match(/^\/admin\/billing\/invoices\/([^/]+)$/))) return json({ number: 'INV-DEMO-ACME', account: decodeURIComponent(m[1]), name: 'ACME Corp', period: iso(Date.now()).slice(0, 7), currency: 'USD', lines: [
      { target: 'llm/complete', calls: 4120, inputTokens: 3.1e6, outputTokens: 0.7e6, seconds: 5120.4, rate: '0.000002/in-token + 0.00001/out-token', amount: 13.2 },
      { target: 'search/web', calls: 29120, inputTokens: 0, outputTokens: 0, seconds: 8220.1, rate: '0.004/call', amount: 116.48 },
    ], subtotal: 1180.4, discount: 118.04, minimumTopUp: 0, tax: 87.65, total: 1150.01 });
    // 6.8: Kubernetes manifests.
    if (p === '/admin/k8s/manifests') return json({ items: [
      { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'mcp-gateway', namespace: 'default' } },
      { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'mcp-gateway', namespace: 'default' }, spec: { replicas: 2 } },
      { apiVersion: 'v1', kind: 'Service', metadata: { name: 'mcp-gateway', namespace: 'default' } },
      { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: 'mcp-gateway', namespace: 'default' } },
    ], notes: ['auth.apiKeys are not rendered: put them in a Secret (MCP_GATEWAY_API_KEYS) and pass ?secret=<name>'] });
    // 7.1: Terraform resources and export.
    if (p === '/admin/terraform/servers') return json({ kind: 'servers', items: demoConfig.servers });
    if (p === '/admin/terraform/export') return new Response('# Generated by mcp-gateway (GET /api/v1/admin/terraform/export).\nterraform {\n  required_providers {\n    restapi = { source = "Mastercard/restapi", version = "~> 1.19" }\n  }\n}\n' + demoConfig.servers.map((s) => `\nresource "restapi_object" "server_${s.id.replace(/[^A-Za-z0-9_-]/g, '_')}" {\n  path         = "/api/v1/admin/terraform/servers"\n  id_attribute = "id"\n  data         = jsonencode(${JSON.stringify(s)})\n}\n\nimport {\n  to = restapi_object.server_${s.id.replace(/[^A-Za-z0-9_-]/g, '_')}\n  id = "/api/v1/admin/terraform/servers/${s.id}"\n}\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/plain' } });
    // 7.2: SaaS console.
    if (p === '/admin/console') return json({
      defaultPlan: 'free',
      plans: [
        { id: 'free', name: 'Free', servers: ['search'], callsPerDay: 1000, orgs: 1 },
        { id: 'pro', name: 'Pro', servers: ['*'], callsPerDay: null, orgs: 1 },
      ],
      orgs: [
        { id: 'acme', name: 'ACME Corp', plan: 'pro', suspended: false, tenant: 'ok', servers: ['*'], members: [{ client: 'key:acme-*', role: 'owner' }], usage: { today: 4210, limit: null, remaining: null } },
        { id: 'globex', name: 'Globex', plan: 'free', suspended: false, tenant: 'ok', servers: ['search'], members: [{ client: 'key:globex-*', role: 'owner' }], usage: { today: 812, limit: 1000, remaining: 188 } },
      ],
      totals: { orgs: 2, suspended: 0, callsToday: 5022 },
    });
    // 7.3: output sanitisation / injection defence.
    if (p === '/admin/sanitize') return json({ enabled: true, settings: { servers: ['*'], exempt: [], invisible: true, ansi: true, html: true, images: 'strip', allowedImageHosts: ['*.githubusercontent.com'], injection: { action: 'mark', threshold: 0.6 }, inbound: 'off', spotlight: true }, stats: { results: 1840, cleaned: 37, invisible: 112, ansi: 9, html: 4, images: 6, truncated: 0, flagged: 3, blocked: 0, inboundBlocked: 0 } });
    // 7.4: semantic cache.
    if (p === '/admin/semantic-cache' && method === 'GET') return json({ enabled: true, settings: { tools: ['search/*'], threshold: 0.9, ttlSeconds: 3600, maxEntries: 5000, scope: 'tenant', embedding: { provider: 'local', model: 'text-embedding-3-small', dimensions: 512 } }, entries: 214, stats: { hits: 388, misses: 902, stores: 902, evictions: 0, errors: 0 } });
    // 7.5: gradual rollouts.
    if (p === '/admin/rollouts') return json({ rollouts: [
      { id: 'search-v2', stable: 'search', canary: 'search-v2', tools: ['*'], configuredPercent: 10, percent: 25, clients: ['key:beta-*'], exclude: [], state: 'active', reason: 'set over the admin API', versions: { stable: { calls: 2210, errors: 11, errorRate: 0.005, windowErrorRate: 0.01 }, canary: { calls: 731, errors: 4, errorRate: 0.005, windowErrorRate: 0.005 } } },
    ] });
    // 7.6: offline desktop mode.
    if (p === '/admin/offline' && method === 'GET') return json({ enabled: true, mode: 'auto', configuredMode: 'auto', offline: false, lastProbeAt: new Date(Date.now() - 6000).toISOString(), reachable: true, refused: 0, servers: { local: ['filesystem'], remote: ['github', 'search'], allowRemote: [] } });
    // 7.7: approval flows.
    if (p === '/admin/approval-flows') return json({ enabled: true, flows: [{ id: 'payments', tools: ['payments/transfer'], when: [{ path: 'amount', op: 'gte', value: 1000 }], timeoutSeconds: 900, steps: [{ name: 'lead', approvers: ['key:lead-*'], required: 1, when: [], escalateTo: [] }, { name: 'finance', approvers: ['key:fin-*'], required: 2, when: [{ path: 'amount', op: 'gte', value: 10000 }], escalateAfterSeconds: 300, escalateTo: ['key:cfo'] }] }], pending: [
      { id: 'f1c0ffee-0000-4000-8000-000000000001', flow: 'payments', status: 'pending', clientId: 'key:agent-billing', serverId: 'payments', tool: 'transfer', arguments: { amount: 25000, currency: 'EUR', to: '***' }, current: 1, steps: [{ name: 'lead', approvers: ['key:lead-*'], required: 1, escalateTo: [], escalated: false, status: 'approved', approvals: [{ by: 'key:lead-ana', at: new Date(Date.now() - 120000).toISOString() }] }, { name: 'finance', approvers: ['key:fin-*'], required: 2, escalateTo: ['key:cfo'], escalated: false, status: 'pending', approvals: [{ by: 'key:fin-li', at: new Date(Date.now() - 30000).toISOString() }] }], createdAt: new Date(Date.now() - 180000).toISOString(), expiresAt: new Date(Date.now() + 720000).toISOString() },
    ], recent: [] });
    // 7.8: automated compliance reports.
    if (p === '/admin/compliance-reports') return json({ outputDir: '/var/lib/mcp-gateway/compliance', keep: 12, schedules: [{ id: 'monthly', frameworks: ['soc2', 'iso27001', 'gdpr'], every: 'monthly', periodDays: 30, lastRunAt: '2026-10-01T00:00:00.000Z', nextRunAt: '2026-10-31T00:00:00.000Z' }], bundles: [
      { name: 'monthly-2026-10-01T00-00-00-000Z', schedule: 'monthly', generatedAt: '2026-10-01T00:00:00.000Z', frameworks: [{ framework: 'soc2', pass: 8, warn: 1, fail: 0 }, { framework: 'iso27001', pass: 11, warn: 1, fail: 0 }, { framework: 'gdpr', pass: 5, warn: 1, fail: 0 }], verified: true },
    ] });
    // 8.1: agent identity & delegated auth.
    if (p === '/admin/agent-identity') return json({ enabled: true, issuer: 'mcp-gateway', tokenTtlSeconds: 900, maxDelegationDepth: 2, requireAgentFor: ['payments/*'], agents: [
      { id: 'travel-bot', name: 'Travel bot', tools: ['flights/*', 'hotels/search'], delegators: ['jwt:*'], enabled: true, activeTokens: 2 },
      { id: 'booker', name: 'Booking sub-agent', tools: ['flights/book', 'payments/*'], delegators: ['*'], enabled: true, activeTokens: 1 },
    ], tokens: { issued: 14, active: 3, revoked: 1 }, recent: [
      { jti: '7c1e9a40-demo', agent: 'booker', sub: 'jwt:alice@example.com', chain: ['agent:booker', 'agent:travel-bot'], scope: ['flights/book'], issuedAt: '2026-10-08T16:40:00.000Z', expiresAt: '2026-10-08T16:55:00.000Z', calls: 1, revoked: false },
      { jti: '52b0d3f1-demo', agent: 'travel-bot', sub: 'jwt:alice@example.com', chain: ['agent:travel-bot'], scope: ['flights/*', 'hotels/search'], issuedAt: '2026-10-08T16:38:00.000Z', expiresAt: '2026-10-08T16:53:00.000Z', calls: 6, revoked: false },
    ] });
    // 8.2: cross-gateway A2A federation.
    if (p === '/admin/a2a-federation') return json({ enabled: true, refreshSeconds: 60, remotes: [
      { id: 'eu', url: 'https://gw-eu.example.com', enabled: true, skillsFilter: ['*'], clients: ['*'], status: 'online', card: { name: 'eu-gateway', url: 'https://gw-eu.example.com/a2a', version: VERSION, protocolVersion: '0.3.0' }, skills: [{ id: 'search', name: 'search' }, { id: 'translate', name: 'translate' }], fetchedAt: new Date().toISOString() },
      { id: 'partner', url: 'https://agents.partner.example', enabled: true, skillsFilter: ['quote*'], clients: ['key:ops-*'], status: 'error', skills: [], error: 'agent card: HTTP 503', fetchedAt: new Date().toISOString() },
    ], recent: [
      { id: 'f1', remote: 'eu', skill: 'translate', client: 'agent:travel-bot', state: 'completed', durationMs: 182, at: new Date().toISOString() },
    ] });
    // 8.3: live collaborative debugging.
    if (p === '/admin/debug-sessions') return json({ enabled: true, sessions: [
      { id: 'a1b2c3d4', name: 'checkout bug', createdAt: new Date(Date.now() - 600000).toISOString(), owner: 'alice', participants: ['alice', 'bob'], match: { tools: ['payments/*'] }, breakpoints: [{ tool: 'payments/charge', when: { path: 'currency', equals: 'JPY' } }],
        paused: [{ callId: 'f00dcafe', tool: 'payments/charge', client: 'key:checkout', arguments: { amount: 1200, currency: 'JPY', card: '<redacted>' }, pausedForMs: 8000 }], lastSeq: 42 },
    ] });
    // 8.4: cost optimization advisor.
    if (p === '/admin/cost-advisor') return json({ enabled: true, currency: 'USD', window: { minutes: 1440, since: new Date(Date.now() - 86400000).toISOString(), calls: 18420 }, spend: 412.6, totalSavings: 131.9, recommendations: [
      { id: 'cache:search/query', kind: 'cache', tool: 'search/query', savings: 88.4, detail: '8840 of 12100 calls repeated identical arguments (73%)', suggestion: { cache: { enabled: true, rules: [{ servers: ['search'], tools: ['query'], ttlSeconds: 300 }] } } },
      { id: 'cheaper-upstream:search/query', kind: 'cheaper-upstream', tool: 'search/query', savings: 36.3, detail: '"query" is also served by "search-lite" at 0.007 per call (vs 0.01)' },
      { id: 'failures:github/create_issue', kind: 'failures', tool: 'github/create_issue', savings: 7.2, detail: '144 of 610 calls failed (24%) — failed calls are still billed' },
    ] });
    // 8.5: zero-downtime blue/green upgrades.
    if (p === '/admin/blue-green') return json({ deployments: [
      { id: 'search', blue: 'search-v1', green: 'search-v2', active: 'green', activeServer: 'search-v2', tools: ['*'], inFlight: { blue: 2, green: 14 }, calls: { blue: 48210, green: 1290 }, errors: { blue: 96, green: 3 }, verifying: { color: 'green', remainingSeconds: 74, calls: 1290, errors: 3 },
        history: [{ at: new Date(Date.now() - 46000).toISOString(), from: 'blue', to: 'green', reason: 'manual switch' }] },
    ] });
    // 8.6: data lineage.
    if (p === '/admin/data-lineage') return json({ enabled: true, scope: 'client', nodes: 3, edges: 2, recent: [
      { id: 'n3', at: new Date().toISOString(), tool: 'mail/send', client: 'agent:travel-bot', success: true, inputs: 1, outputs: 0 },
      { id: 'n2', at: new Date(Date.now() - 4000).toISOString(), tool: 'billing/invoices', client: 'agent:travel-bot', success: true, inputs: 1, outputs: 1 },
      { id: 'n1', at: new Date(Date.now() - 9000).toISOString(), tool: 'crm/find', client: 'agent:travel-bot', success: true, inputs: 0, outputs: 1 },
    ] });
    if (p.startsWith('/admin/data-lineage/nodes/')) return json({ node: { id: 'n3', tool: 'mail/send', inputs: 1, outputs: 0 }, upstream: { nodes: [{ id: 'n2', tool: 'billing/invoices' }, { id: 'n1', tool: 'crm/find' }], edges: [{ from: 'n2', to: 'n3', path: 'body' }, { from: 'n1', to: 'n2', path: 'customer' }] }, downstream: { nodes: [], edges: [] } });
    // 8.7: natural-language config assistant (demo: the phrasebook only, nothing is applied).
    if (p === '/admin/config-assistant/plan') return json({ valid: true, planId: 'demo-plan', steps: [
      { text: 'rate limit to 60 per minute', summary: 'rate limit 60 per 60s per key', source: 'phrasebook' },
      { text: 'require approval for payments/*', summary: 'policy rule: approve payments/* (first in order)', source: 'phrasebook' },
    ], changes: [{ path: 'rateLimit.limit', from: 120, to: 60 }, { path: 'policy.rules[0]', to: { effect: 'approve', servers: ['payments'], tools: ['*'] } }], unparsed: [] });
    // 8.8: chaos testing.
    if (p === '/admin/chaos') return json({ experiments: [
      { id: 'slow-search', servers: ['search'], tools: ['*'], clients: ['key:staging-*'], percent: 25, fault: { latencyMs: 1500, timeoutMs: 30000 }, every: 'daily', state: 'running', reason: null, startedAt: new Date(Date.now() - 120000).toISOString(), remainingSeconds: 180, injected: { latency: 212, error: 0, timeout: 0, corrupt: 0 }, calls: 847, errors: 4 },
      { id: 'github-flaky', servers: ['github'], tools: ['*'], clients: ['*'], percent: 10, fault: { errorRate: 0.5, timeoutMs: 30000 }, every: null, state: 'aborted', reason: 'steady-state guard: error rate 0.31 > 0.3', startedAt: new Date(Date.now() - 86400000).toISOString(), remainingSeconds: 0, injected: { latency: 0, error: 19, timeout: 0, corrupt: 0 }, calls: 61, errors: 19 },
    ] });
    // 9.1: multimodal tools.
    if (p === '/admin/multimodal') return json({ enabled: true, policy: { enabled: true, allowedTypes: ['image/*', 'audio/*'], maxItemBytes: 10485760, maxTotalBytes: 33554432, onViolation: 'refuse', offloadAboveBytes: 262144, blobTtlSeconds: 600, maxBlobs: 256, servers: ['*'] }, stats: { results: 1840, items: 412, bytes: 96468992, refused: 3, stripped: 0, offloaded: 57 }, blobs: [
      { id: '6f0c2a9e-demo', mimeType: 'image/png', bytes: 1843200, serverId: 'browser', tool: 'screenshot', expiresAt: new Date(Date.now() + 420000).toISOString() },
      { id: '9b1d77c3-demo', mimeType: 'audio/mpeg', bytes: 3145728, serverId: 'speech', tool: 'synthesize', expiresAt: new Date(Date.now() + 180000).toISOString() },
    ] });
    // 9.2: edge WASM runtime 2.0.
    if (p === '/admin/edge-runtime') return json({ enabled: true, tools: [
      { name: 'geo-lookup', wasm: './tools/geo.wasm', export: 'run', sha256: '9f2c41d0b7e3a8c5f1e6d2b49a07c3e8d5f1a2b6c9e0d4f7a3b8c1e5d2f6a90b', pinned: true, loaded: true, error: null, limits: { timeoutMs: 50, memoryMb: 8, maxConcurrent: 4 }, pool: { warm: 2, idle: 2, busy: 0, started: 3 }, calls: 18422, errors: 2, coldStarts: 1, latencyMs: { p50: 1, max: 21 } },
      { name: 'markdown-to-html', wasm: './tools/md.wasm', export: 'run', sha256: '1c7e9a2f4b8d0e6c3a5f7b9d1e2c4a6f8b0d2e4c6a8f0b2d4e6c8a0f2b4d6e8c', pinned: false, loaded: true, error: null, limits: { timeoutMs: 100, memoryMb: 16, maxConcurrent: 4 }, pool: { warm: 1, idle: 1, busy: 0, started: 1 }, calls: 640, errors: 0, coldStarts: 0, latencyMs: { p50: 2, max: 9 } },
    ] });
    // 9.3: confidential computing / TEE.
    if (p === '/admin/confidential') return json({ enabled: true, servers: [
      { id: 'postgres', match: 'postgres', platforms: ['sev-snp', 'tdx'], attested: true, platform: 'sev-snp', measurement: '5f1c9a0e7b2d4c6f8a1e3b5d7f9c0a2e4b6d8f0a1c3e5b7d', attestedAt: new Date(Date.now() - 900000).toISOString(), expiresAt: new Date(Date.now() + 2700000).toISOString(), lastFailure: null },
      { id: 'payroll', match: 'payroll*', platforms: ['nitro'], attested: false, platform: null, measurement: null, attestedAt: null, expiresAt: null, lastFailure: { at: new Date(Date.now() - 60000).toISOString(), reason: 'measurement is not in the allowlist' } },
    ] });
    // 9.4: global tool registry.
    if (p === '/admin/tool-registry') return json({ enabled: true, count: 3, entries: [
      { id: 'acme/search', publisher: 'acme', name: 'search', version: '1.3.0', description: 'Web search with citations', tools: ['web_search', 'fetch_page'], verified: true, origin: 'local' },
      { id: 'globex/crm', publisher: 'globex', name: 'crm', version: '4.1.2', description: 'CRM contacts and deals', tools: ['find_contact', 'create_deal'], verified: true, origin: 'https://registry.globex.example/api/v1/features/tool-registry/index.json' },
      { id: 'initech/tickets', publisher: 'initech', name: 'tickets', version: '0.9.0', description: 'Ticketing', tools: ['open_ticket'], verified: true, origin: 'local' },
    ], mirrors: [{ url: 'https://registry.globex.example/api/v1/features/tool-registry/index.json', lastSyncAt: new Date(Date.now() - 1200000).toISOString(), ok: true, added: 2, error: null }], pins: { 'acme/search': '~1.2.0' } });
    // 9.5: SLA monitoring.
    if (p === '/admin/sla') return json({ enabled: true, generatedAt: new Date().toISOString(), targets: [
      { id: 'search-gold', windowDays: 30, from: new Date(Date.now() - 30 * 86400000).toISOString(), calls: 182440, failures: 91, availability: 99.9501, objective: { availability: 99.9, latencyP95Ms: 800 }, latencyP95Ms: 500, errorBudget: { allowedFailures: 182.44, remaining: 91.44, remainingPercent: 50.12 }, met: true, breaches: [], credit: { percent: 0, amount: 0, currency: 'EUR' }, tenants: [{ tenant: 'acme', calls: 120000, failures: 60, availability: 99.95 }, { tenant: 'globex', calls: 62440, failures: 31, availability: 99.9504 }] },
      { id: 'github-silver', windowDays: 30, from: new Date(Date.now() - 30 * 86400000).toISOString(), calls: 40210, failures: 610, availability: 98.483, objective: { availability: 99.5, latencyP95Ms: null }, latencyP95Ms: 750, errorBudget: { allowedFailures: 201.05, remaining: -408.95, remainingPercent: -203.41 }, met: false, breaches: ['availability 98.483% < 99.5%'], credit: { percent: 10, amount: 50, currency: 'EUR' }, tenants: [] },
    ] });
    // 9.6: self-healing.
    if (p === '/admin/self-healing') return json({ enabled: true, windowSeconds: 60, rules: [
      { id: 'search-down', servers: ['search'], when: { errorRateAbove: 0.5 }, action: 'eject', fallback: 'search-backup', cooldownSeconds: 120 },
      { id: 'github-slow', servers: ['github'], when: { p95Above: 3000 }, action: 'throttle', maxPerSecond: 5, cooldownSeconds: 60 },
    ], active: [
      { rule: 'github-slow', server: 'github', action: 'throttle', reason: 'p95 4210ms > 3000ms over 64 calls', since: new Date(Date.now() - 20000).toISOString(), until: new Date(Date.now() + 40000).toISOString(), refused: 12, rerouted: 0, to: null },
    ], servers: [{ id: 'search', calls: 210, errors: 2, errorRate: 0.0095, p95: 310 }, { id: 'github', calls: 64, errors: 1, errorRate: 0.0156, p95: 4210 }], history: [
      { at: new Date(Date.now() - 20000).toISOString(), rule: 'github-slow', server: 'github', action: 'throttle', event: 'triggered', reason: 'p95 4210ms > 3000ms over 64 calls' },
      { at: new Date(Date.now() - 7200000).toISOString(), rule: 'search-down', server: 'search', action: 'eject', event: 'lifted', reason: 'cool-down elapsed' },
    ] });
    // 9.7: post-quantum TLS.
    if (p === '/admin/pq-tls') return json({ configured: true, mode: 'prefer', supported: true, openssl: '3.5.4', groups: 'X25519MLKEM768:X25519:P-256', certificatePolicy: { minRsaBits: 3072, allowedKeyTypes: ['ec', 'ed25519', 'ed448', 'rsa', 'rsa-pss', 'ml-dsa'], maxValidityDays: 398, rejectSha1: true }, servers: [
      { id: 'search', url: 'https://search.internal:8443/mcp', lastProbe: { server: 'search', host: 'search.internal', port: 8443, pq: true, pqError: null, protocol: 'TLSv1.3', classicalGroup: 'X25519', certificate: { subject: 'CN=search.internal', keyType: 'ec', bits: null, signature: null, validTo: new Date(Date.now() + 80 * 86400000).toISOString(), validityDays: 90 }, violations: [], at: new Date(Date.now() - 600000).toISOString() } },
      { id: 'postgres', url: 'https://pg-mcp.internal/mcp', lastProbe: { server: 'postgres', host: 'pg-mcp.internal', port: 443, pq: false, pqError: 'ssl/tls alert handshake failure', protocol: 'TLSv1.3', classicalGroup: 'X25519', certificate: { subject: 'CN=pg-mcp.internal', keyType: 'rsa', bits: 2048, signature: null, validTo: new Date(Date.now() + 300 * 86400000).toISOString(), validityDays: 365 }, violations: ['RSA key of 2048 bits < 3072'], at: new Date(Date.now() - 600000).toISOString() } },
    ] });
    // 9.8: ecosystem marketplace GA.
    if (p === '/admin/ecosystem') return json({ enabled: true, stats: { listings: 42, pending: 2, approved: 37, rejected: 3, reviews: 518 }, queue: [
      { id: 'acme.pii-guard@2.0.0', name: 'pii-guard', version: '2.0.0', kind: 'plugin', publisher: { id: 'acme', name: 'ACME Corp', verified: true }, submittedBy: 'key:acme-ci', submittedAt: new Date(Date.now() - 3600000).toISOString() },
      { id: 'indie.weather@0.3.1', name: 'weather', version: '0.3.1', kind: 'wasm-tool', publisher: { id: 'indie', name: 'indie', verified: false }, submittedBy: 'key:indie', submittedAt: new Date(Date.now() - 600000).toISOString() },
    ], publishers: [
      { id: 'acme', name: 'ACME Corp', domain: 'acme.example', keyIds: ['acme-2026'], verified: true, verifiedAt: new Date(Date.now() - 86400000 * 12).toISOString() },
      { id: 'globex', name: 'Globex', domain: 'globex.example', keyIds: ['gx-1'], verified: false, verifiedAt: null },
    ], listings: [] });
    // 10.0: unified kernel.
    if (p === '/admin/kernel') return json({ version: VERSION, schema: 11, line: { line: '11.x', lts: false }, moduleMode: 'lazy', lts: { line: '10.x', codename: 'Kernel', lts: true, activeUntil: '2027-10-31', maintenanceUntil: '2028-10-31', status: 'active' },
      modules: DEMO_FEATURES.map((m) => ({ ...m, path: `/api/v1/admin/${m.id}` })),
      hooks: ['chaos', 'multimodal', 'confidential', 'sla', 'self-healing'].map((id, i) => ({ order: i + 1, id, before: id !== 'multimodal' && id !== 'sla', after: id !== 'confidential' })),
      features: ['sla', 'selfHealing', 'chaos'].map((k) => ({ section: `features.${k}`, configured: !!(demoConfig.features && demoConfig.features[k]) })) });
    if (p === '/policy') return json({ rules: 3, default: 'allow', approval: { pending: demoApprovals.length, timeoutSeconds: 300 }, outputFilter: { enabled: true, action: 'redact', findings: { email: 4, 'aws-key': 1 } } });
    // 10.0: nothing is deprecated (the demo config is on schema v10).
    if (p === '/admin/deprecations') return json({ runtime: [], config: [] });
    // 9.0: event-sourced store.
    if (p === '/admin/store/compact' && method === 'POST') return json({ compacted: true, eventlog: { kind: 'eventlog', dir: '/data/store', keys: 38, eventsSinceSnapshot: 0, totalEvents: 4212, snapshots: 3, lastSnapshotAt: new Date().toISOString(), replayed: 117 } });
    if (p === '/admin/store') return json({ backend: 'eventlog', failureMode: 'open', eventlog: { kind: 'eventlog', dir: '/data/store', keys: 38, eventsSinceSnapshot: 212, totalEvents: 4212, snapshots: 2, lastSnapshotAt: new Date(Date.now() - 3600000).toISOString(), replayed: 117 } });
    // 7.0: control plane — data planes pulling config and sending heartbeats.
    if (p === '/admin/data-planes') {
      const seen = (s) => new Date(Date.now() - s * 1000).toISOString();
      const etag = '"3f9a1c0d7e5b42a8c6d1e0f9b8a7c6d5"';
      const dataPlanes = [
        { nodeId: 'dp-eu-1', firstSeen: seen(86400), lastSeen: seen(4), configEtag: etag, inSync: true, status: 'online', version: VERSION, pullIntervalMs: 10000, servers: { online: 3, total: 3 } },
        { nodeId: 'dp-eu-2', firstSeen: seen(86000), lastSeen: seen(7), configEtag: etag, inSync: true, status: 'online', version: VERSION, pullIntervalMs: 10000, servers: { online: 3, total: 3 } },
        { nodeId: 'dp-us-1', firstSeen: seen(3600), lastSeen: seen(95), configEtag: '"0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e"', inSync: false, status: 'stale', version: VERSION, pullIntervalMs: 10000, servers: { online: 2, total: 3 }, lastError: 'config pull failed: connect ETIMEDOUT' },
      ];
      return json({ role: 'control', configEtag: etag, dataPlanes, summary: { total: 3, online: 2, inSync: 2 } });
    }
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
