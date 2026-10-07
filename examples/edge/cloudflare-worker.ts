// Cloudflare Worker: npm i @winstonsayno/mcp-gateway ; wrangler deploy
// Config comes from Worker vars / secrets (see wrangler.toml):
//   MCP_GATEWAY_SERVERS  JSON array of { id, url, headers?, tools? }   (Streamable HTTP upstreams)
//   MCP_GATEWAY_API_KEYS comma-separated keys (`wrangler secret put MCP_GATEWAY_API_KEYS`)
import { workersHandler } from '@winstonsayno/mcp-gateway/edge';

export default workersHandler();
