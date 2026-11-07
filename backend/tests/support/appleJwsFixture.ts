/**
 * A stand-in for Apple's signing chain, built fresh for each test run with the
 * openssl CLI: a root, an intermediate carrying Apple's WWDR marker extension,
 * and a leaf carrying the App Store receipt-signing marker. Nothing here is
 * Apple's and no key is committed; the keys live in a temp directory for the
 * life of the process.
 *
 * `signJws` produces a compact ES256 JWS with the chain in `x5c`, the shape
 * StoreKit and the App Store Server send. Pass `fixture.rootPem` as the
 * verifier's trusted root.
 */
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ChainFixture {
  rootPem: string;
  x5c: [string, string, string];
  leafKeyPem: string;
}

function run(args: string[], cwd: string) {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' });
}

function der64(pemPath: string): string {
  return Buffer.from(new X509Certificate(readFileSync(pemPath)).raw).toString('base64');
}

export function makeChain(
  opts: { leafMarker?: boolean; intermediateMarker?: boolean } = {}
): ChainFixture {
  const leafMarker = opts.leafMarker ?? true;
  const intermediateMarker = opts.intermediateMarker ?? true;
  const dir = mkdtempSync(join(tmpdir(), 'fg-apple-jws-'));
  writeFileSync(
    join(dir, 'ext.cnf'),
    [
      '[ca_ext]',
      'basicConstraints=critical,CA:TRUE',
      'keyUsage=critical,keyCertSign,cRLSign',
      '[int_ext]',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      'keyUsage=critical,keyCertSign,cRLSign',
      ...(intermediateMarker ? ['1.2.840.113635.100.6.2.1=ASN1:NULL'] : []),
      '[leaf_ext]',
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      ...(leafMarker ? ['1.2.840.113635.100.6.11.1=ASN1:NULL'] : []),
      '',
    ].join('\n')
  );
  const ec = ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out'];
  run([...ec, 'root.key'], dir);
  run([...ec, 'int.key'], dir);
  run([...ec, 'leaf.key'], dir);
  run(
    [
      'req',
      '-new',
      '-x509',
      '-key',
      'root.key',
      '-subj',
      '/CN=Test Root',
      '-days',
      '3650',
      '-sha256',
      '-extensions',
      'ca_ext',
      '-config',
      'ext.cnf',
      '-out',
      'root.pem',
    ],
    dir
  );
  run(
    [
      'req',
      '-new',
      '-key',
      'int.key',
      '-subj',
      '/CN=Test Intermediate',
      '-out',
      'int.csr',
      '-config',
      'ext.cnf',
    ],
    dir
  );
  run(
    [
      'x509',
      '-req',
      '-in',
      'int.csr',
      '-CA',
      'root.pem',
      '-CAkey',
      'root.key',
      '-CAcreateserial',
      '-days',
      '3650',
      '-sha256',
      '-extfile',
      'ext.cnf',
      '-extensions',
      'int_ext',
      '-out',
      'int.pem',
    ],
    dir
  );
  run(
    [
      'req',
      '-new',
      '-key',
      'leaf.key',
      '-subj',
      '/CN=Test Leaf',
      '-out',
      'leaf.csr',
      '-config',
      'ext.cnf',
    ],
    dir
  );
  run(
    [
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'int.pem',
      '-CAkey',
      'int.key',
      '-CAcreateserial',
      '-days',
      '3650',
      '-sha256',
      '-extfile',
      'ext.cnf',
      '-extensions',
      'leaf_ext',
      '-out',
      'leaf.pem',
    ],
    dir
  );
  return {
    rootPem: readFileSync(join(dir, 'root.pem'), 'utf8'),
    x5c: [der64(join(dir, 'leaf.pem')), der64(join(dir, 'int.pem')), der64(join(dir, 'root.pem'))],
    leafKeyPem: readFileSync(join(dir, 'leaf.key'), 'utf8'),
  };
}

export function signJws(
  chain: ChainFixture,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {}
): string {
  const h = Buffer.from(JSON.stringify({ alg: 'ES256', x5c: chain.x5c, ...header })).toString(
    'base64url'
  );
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), {
    key: createPrivateKey(chain.leafKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${h}.${p}.${sig.toString('base64url')}`;
}
