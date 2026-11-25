/** The API Tester's outbound request, guarded against server-side request forgery. */
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { HttpError } from './http.ts';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/** Never reachable: link-local (which includes cloud metadata services), multicast and reserved. */
const always = new BlockList();
always.addSubnet('169.254.0.0', 16, 'ipv4');
always.addSubnet('224.0.0.0', 3, 'ipv4');
always.addSubnet('fe80::', 10, 'ipv6');
always.addSubnet('ff00::', 8, 'ipv6');

const privateRanges = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
] as const) {
  privateRanges.addSubnet(net, bits, 'ipv4');
}
privateRanges.addAddress('::', 'ipv6');
privateRanges.addAddress('::1', 'ipv6');
privateRanges.addSubnet('fc00::', 7, 'ipv6');
// NAT64 and 6to4 prefixes can smuggle a private IPv4 address.
privateRanges.addSubnet('64:ff9b::', 96, 'ipv6');
privateRanges.addSubnet('2002::', 16, 'ipv6');

export function isBlockedAddress(address: string, allowPrivate: boolean): boolean {
  const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
  if (always.check(address, family)) return true;
  // BlockList matches IPv4-mapped IPv6 addresses against the IPv4 rules.
  return !allowPrivate && privateRanges.check(address, family);
}

const blocked = () =>
  new HttpError(
    403,
    'That address is blocked. Private network targets need ALLOW_PRIVATE_TARGETS=1.',
  );

export interface ProxyRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ProxyResponse {
  status: number;
  statusText: string;
  headers: { key: string; value: string }[];
  timeMs: number;
  sizeBytes: number;
  truncated: boolean;
  bodyBase64: string;
}

function once(request: ProxyRequest, allowPrivate: boolean, signal: AbortSignal) {
  return new Promise<{ message: http.IncomingMessage; body: Buffer; truncated: boolean }>(
    (resolve, reject) => {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return reject(new HttpError(400, 'Enter a full URL, such as https://example.com/api'));
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return reject(new HttpError(400, 'Only http and https URLs are supported'));
      }
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) && isBlockedAddress(host, allowPrivate)) return reject(blocked());

      // Checking inside the connection's own DNS lookup prevents DNS rebinding.
      const lookup: LookupFunction = (hostname, options, callback) => {
        dnsLookup(hostname, { ...options, all: true }, (error, result) => {
          const addresses = result as unknown as LookupAddress[];
          if (error) return callback(error, '', 4);
          if (addresses.some((a) => isBlockedAddress(a.address, allowPrivate)))
            return callback(blocked(), '', 4);
          if (options.all) {
            (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
          } else {
            callback(null, addresses[0]!.address, addresses[0]!.family);
          }
        });
      };

      const client = url.protocol === 'https:' ? https : http;
      let outgoing: http.ClientRequest;
      try {
        outgoing = client.request(url, {
          method: request.method,
          headers: request.headers,
          lookup,
          signal,
        });
      } catch (error) {
        return reject(new HttpError(400, `Invalid request: ${(error as Error).message}`));
      }
      outgoing.on('error', reject);
      outgoing.on('response', (message) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () => resolve({ message, body: Buffer.concat(chunks), truncated });
        message.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const room = MAX_RESPONSE_BYTES - size;
          chunks.push(chunk.subarray(0, room));
          size += Math.min(room, chunk.length);
          if (chunk.length > room) {
            truncated = true;
            finish();
            outgoing.destroy();
          }
        });
        message.on('end', finish);
        message.on('error', reject);
      });
      if (request.body !== null) outgoing.write(request.body);
      outgoing.end();
    },
  );
}

export async function proxy(request: ProxyRequest, allowPrivate: boolean): Promise<ProxyResponse> {
  const started = performance.now();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = request;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const { message, body, truncated } = await once(current, allowPrivate, signal);
      const status = message.statusCode ?? 0;
      const location = message.headers.location;
      if (location && [301, 302, 303, 307, 308].includes(status)) {
        const next = new URL(location, current.url);
        const headers = { ...current.headers };
        // Credentials must not follow a redirect to another origin.
        if (next.origin !== new URL(current.url).origin) {
          for (const key of Object.keys(headers)) {
            if (['authorization', 'cookie', 'proxy-authorization'].includes(key.toLowerCase()))
              delete headers[key];
          }
        }
        const toGet =
          status === 303 || ((status === 301 || status === 302) && current.method === 'POST');
        if (toGet) {
          for (const key of Object.keys(headers))
            if (key.toLowerCase().startsWith('content-')) delete headers[key];
        }
        current = {
          url: next.href,
          headers,
          method: toGet ? 'GET' : current.method,
          body: toGet ? null : current.body,
        };
        continue;
      }
      const pairs: { key: string; value: string }[] = [];
      for (let i = 0; i < message.rawHeaders.length; i += 2) {
        pairs.push({ key: message.rawHeaders[i]!, value: message.rawHeaders[i + 1]! });
      }
      return {
        status,
        statusText: message.statusMessage ?? '',
        headers: pairs,
        timeMs: Math.round(performance.now() - started),
        sizeBytes: body.length,
        truncated,
        bodyBase64: body.toString('base64'),
      };
    }
    throw new HttpError(502, 'Too many redirects');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (signal.aborted) throw new HttpError(504, 'The request timed out after 20 seconds');
    throw new HttpError(502, `Request failed: ${(error as Error).message}`);
  }
}
