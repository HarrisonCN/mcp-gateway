// tool-quota — an example third-party gateway plugin (plugin API v5).
//
// Limits how many calls each client may make to each tool within a time window. Self-contained (no imports), so one
// `mcp-gateway plugin sign` signature covers the whole plugin, and written for an isolated runtime (worker / process):
// it only reads call metadata, never rewrites arguments or responses, needs no network and no environment.
//
// The counters live in the runtime's memory: they start over when the plugin is updated, reloaded or its runtime
// crashes and is restarted. Use a gateway rate limit (rateLimit / quotas) when a limit must survive restarts.

const VERSION = '1.0.0';

/** plugins[].options validation — an error refuses the plugin at load / reload. */
export function checkOptions(options = {}) {
  const errors = [];
  if (options.limit !== undefined && !(Number.isInteger(options.limit) && options.limit > 0)) errors.push('limit must be a positive integer');
  if (options.windowMs !== undefined && !(Number.isInteger(options.windowMs) && options.windowMs >= 1000)) errors.push('windowMs must be an integer ≥ 1000');
  if (options.tools !== undefined && !(Array.isArray(options.tools) && options.tools.every((t) => typeof t === 'string'))) errors.push('tools must be a list of tool names');
  return errors;
}

/** The plugin for one set of options (exported for unit tests). */
export function create(options = {}, now = () => Date.now()) {
  const limit = options.limit ?? 100;
  const windowMs = options.windowMs ?? 60_000;
  const only = Array.isArray(options.tools) && options.tools.length ? new Set(options.tools) : undefined;
  const windows = new Map(); // `${client}\u0000${tool}` → { start, count }
  return {
    name: 'tool-quota',
    apiVersion: 6,
    configSchema: checkOptions,
    onToolCall(call) {
      if (only && !only.has(call.name)) return { action: 'continue' };
      const key = `${call.clientId ?? 'anonymous'}\u0000${call.serverId}/${call.name}`;
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        w = { start: t, count: 0 };
        windows.set(key, w);
        if (windows.size > 10_000) windows.delete(windows.keys().next().value); // bounded
      }
      w.count++;
      if (w.count > limit) {
        return { action: 'deny', reason: `${call.name}: quota of ${limit} call${limit === 1 ? '' : 's'} per ${Math.round(windowMs / 1000)} s reached (tool-quota ${VERSION})` };
      }
      return { action: 'continue' };
    },
  };
}

// The gateway calls the default export with { options, logger, gatewayVersion, apiVersion }.
export default (ctx) => create(ctx.options);
