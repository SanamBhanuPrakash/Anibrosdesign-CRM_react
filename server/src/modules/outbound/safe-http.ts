import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { config } from '../../platform/config';

/**
 * Outbound HTTP to addresses that customers type in. The one rule: the CRM must never be turned into a tool for reaching things that are
 * not on the public internet (the database, the cloud metadata service, another client's internal systems).
 *
 *   - https only in production (http is allowed in development and tests so a local receiver can be used)
 *   - no credentials in the URL, no redirects followed
 *   - the hostname is resolved HERE and every address it resolves to must be public; the connection is made to that same resolved
 *     address, so a DNS answer that changes between the check and the connection (DNS rebinding) cannot sneak through
 *   - hard timeout and a small cap on how much of the answer is read
 */
export class BlockedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedTargetError';
  }
}

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96], ['100::', 64]] as const) blocked.addSubnet(net6, prefix, 'ipv6');

/** True for any address that is not a normal public one (including IPv4 hidden inside an IPv6 "mapped" address). */
export function isBlockedAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isBlockedAddress(mapped[1]!);
  // The same thing written in hex (what URL parsing turns ::ffff:127.0.0.1 into): ::ffff:7f00:1
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const family = net.isIP(ip);
  if (!family) return true;
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

const allowPrivate = () => config.OUTBOUND_ALLOW_PRIVATE === true;

/** Checks the URL's shape only (no network). Throws BlockedTargetError with a message that is safe to show to the person typing it. */
export function checkUrlShape(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedTargetError('That is not a valid web address. Use something like https://example.com/hooks/crm');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (!config.isProduction || allowPrivate()))) throw new BlockedTargetError('Use an https:// address so the data is encrypted on its way.');
  if (u.username || u.password) throw new BlockedTargetError('Remove the username and password from the address; use the signing secret to verify messages instead.');
  const host = u.hostname.toLowerCase();
  if (!allowPrivate()) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new BlockedTargetError('That address points to a private network. Use a public address.');
    const literal = host.startsWith('[') ? host.slice(1, -1) : host;
    if (net.isIP(literal) && isBlockedAddress(literal)) throw new BlockedTargetError('That address points to a private network. Use a public address.');
  }
  return u;
}

/** Shape check plus a real DNS lookup: every address must be public. Used when an address is saved, so a bad one is refused at once. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = checkUrlShape(raw);
  if (allowPrivate()) return u;
  const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
  if (net.isIP(host)) return u;
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new BlockedTargetError('We could not find that address. Check the spelling of the domain name.');
  }
  if (addrs.length === 0 || addrs.some((a) => isBlockedAddress(a.address))) throw new BlockedTargetError('That address points to a private network. Use a public address.');
  return u;
}

export interface PostResult {
  status: number;
  ms: number;
  body: string;
}

/** POST a JSON string. Never follows redirects. Rejects on timeout, on a blocked target and on connection errors. */
export async function postJson(rawUrl: string, body: string, headers: Record<string, string>, opts: { timeoutMs?: number } = {}): Promise<PostResult> {
  const u = checkUrlShape(rawUrl);
  const timeoutMs = opts.timeoutMs ?? 8000;
  const lib = u.protocol === 'https:' ? https : http;
  const started = Date.now();
  return await new Promise<PostResult>((resolve, reject) => {
    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers },
        timeout: timeoutMs,
        // The address checked is the address connected to: resolve here, refuse anything non-public, hand the vetted address back.
        lookup: (hostname, options, cb) => {
          dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
            if (err) return cb(err, '', 4);
            if (!allowPrivate() && addrs.some((a) => isBlockedAddress(a.address))) return cb(new BlockedTargetError('That address points to a private network.') as NodeJS.ErrnoException, '', 4);
            const first = addrs[0]!;
            if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addrs);
            else cb(null, first.address, first.family);
          });
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= 2048) chunks.push(c);
          else res.destroy();
        });
        const done = () => resolve({ status: res.statusCode ?? 0, ms: Date.now() - started, body: Buffer.concat(chunks).toString('utf8').slice(0, 500) });
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`No answer within ${Math.round(timeoutMs / 1000)} seconds`)));
    req.on('error', reject);
    req.end(body);
  });
}
