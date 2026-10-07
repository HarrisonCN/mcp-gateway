// bun run examples/edge/bun.ts
import { serveBun, configFromEnv } from '@winstonsayno/mcp-gateway/edge';

serveBun(configFromEnv(process.env as Record<string, string>), { port: 3000 });
