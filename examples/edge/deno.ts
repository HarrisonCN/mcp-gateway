// deno run --allow-net --allow-env examples/edge/deno.ts
import { serveDeno, configFromEnv } from 'npm:@winstonsayno/mcp-gateway/edge';

serveDeno(configFromEnv(Deno.env.toObject()), { port: 8000 });
