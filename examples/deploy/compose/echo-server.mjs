// Minimal MCP stdio server used by the deployment examples (one `echo` tool). Replace it with your own servers.
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result =
    m.method === 'initialize'
      ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } }
      : m.method === 'tools/list'
        ? { tools: [{ name: 'echo', description: 'Echo the arguments back', inputSchema: { type: 'object' } }] }
        : m.method === 'tools/call'
          ? { content: [{ type: 'text', text: JSON.stringify(m.params.arguments ?? {}) }] }
          : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
});
