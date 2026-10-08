/**
 * Generates the throwaway test PKI for the mTLS tests at run time (no private keys committed to the repo):
 * a CA, a server cert (localhost / 127.0.0.1 / SPIFFE `…/ns/tools/sa/search`) and two client certs with the same
 * SPIFFE ID (`…/ns/gateway/sa/mcp-gateway`) for rotation tests. Needs the `openssl` CLI (1.1.1+).
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let cached: string | undefined;

export function mtlsFixtureDir(): string {
  if (cached) return cached;
  const d = mkdtempSync(join(tmpdir(), 'mcpgw-mtls-'));
  const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: d, stdio: 'pipe' });
  const key = (name: string) => ssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', `${name}.key`);
  key('ca');
  ssl('req', '-x509', '-new', '-key', 'ca.key', '-subj', '/CN=test-ca', '-days', '3650', '-out', 'ca.pem',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  const leaf = (name: string, san: string, eku: string) => {
    key(name);
    ssl('req', '-new', '-key', `${name}.key`, '-subj', `/CN=${name}`, '-out', `${name}.csr`);
    writeFileSync(join(d, `${name}.ext`), `subjectAltName=${san}\nextendedKeyUsage=${eku}\nbasicConstraints=CA:FALSE\n`);
    ssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '3650',
      '-extfile', `${name}.ext`, '-out', `${name}.pem`);
  };
  leaf('srv', 'DNS:localhost,IP:127.0.0.1,URI:spiffe://example.org/ns/tools/sa/search', 'serverAuth');
  leaf('cli', 'URI:spiffe://example.org/ns/gateway/sa/mcp-gateway', 'clientAuth');
  leaf('cli2', 'URI:spiffe://example.org/ns/gateway/sa/mcp-gateway', 'clientAuth');
  cached = d;
  return d;
}
