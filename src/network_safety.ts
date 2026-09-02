/**
 * Shared SSRF / private-network guards for outbound HTTP.
 * Used by recipe import and bottle-image localization so both share one deny list.
 */
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

export const MAX_SAFE_REDIRECTS = 5;

export type NetworkSafetyReason =
  | "invalid_url"
  | "bad_scheme"
  | "credentials"
  | "blocked_host"
  | "private_ip"
  | "dns"
  | "redirect"
  | "too_large"
  | "timeout"
  | "type";

export class NetworkSafetyError extends Error {
  constructor(message: string, readonly reason: NetworkSafetyReason) {
    super(message);
    this.name = "NetworkSafetyError";
  }
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.internal",
  "instance-data",
  "metadata"
]);

export type AddressRecord = { address: string; family?: number };
export type LookupFn = (hostname: string) => Promise<AddressRecord[]>;

export type SafeHttpHeaders = Record<string, string | string[] | undefined>;

export type SafeHttpResponse = {
  status: number;
  headers: SafeHttpHeaders;
  body: Readable;
};

export type PinnedRequestFn = (
  url: URL,
  ip: string,
  options: { timeoutMs: number; headers?: Record<string, string> }
) => Promise<SafeHttpResponse>;

export type FetchSafeOptions = {
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  lookup?: LookupFn;
  request?: PinnedRequestFn;
};

function stripBrackets(host: string) {
  return host.replace(/^\[|\]$/g, "");
}

function isIPv4(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

/** True for loopback, RFC1918, link-local, unique-local, multicast, unspecified, CGNAT, metadata. */
export function isUnsafeIp(ip: string): boolean {
  const value = stripBrackets(ip).toLowerCase().replace(/^::ffff:/, "");
  if (isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (value === "::" || value === "0:0:0:0:0:0:0:0") return true;
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;

  const firstHextet = value.split(":")[0] ?? "";
  const first = firstHextet ? Number.parseInt(firstHextet, 16) : Number.NaN;
  if (Number.isFinite(first)) {
    if (first >= 0xfe80 && first <= 0xfebf) return true;
    if (first >= 0xfc00 && first <= 0xfdff) return true;
    if (first >= 0xff00) return true;
  }
  return false;
}

/** Back-compat alias used by recipe import tests. */
export const isPrivateIp = isUnsafeIp;

export function parseSafeHttpUrl(raw: string, base?: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim(), base);
  } catch {
    throw new NetworkSafetyError("That does not look like a web link.", "invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NetworkSafetyError("Use an http or https link.", "bad_scheme");
  }
  if (parsed.username || parsed.password) {
    throw new NetworkSafetyError("That link cannot be opened.", "credentials");
  }
  const host = stripBrackets(parsed.hostname).toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new NetworkSafetyError("That link cannot be opened.", "blocked_host");
  }
  if (isIP(host) && isUnsafeIp(host)) {
    throw new NetworkSafetyError("That link cannot be opened.", "private_ip");
  }
  return parsed;
}

export async function resolvePublicAddresses(hostname: string, lookupFn?: LookupFn): Promise<string[]> {
  const host = stripBrackets(hostname);
  if (isIP(host)) {
    if (isUnsafeIp(host)) throw new NetworkSafetyError("That link cannot be opened.", "private_ip");
    return [host];
  }
  try {
    const results = lookupFn
      ? await lookupFn(host)
      : await dnsLookup(host, { all: true });
    const addresses = results.map((entry) => entry.address).filter(Boolean);
    if (!addresses.length) throw new NetworkSafetyError("Could not reach that site.", "dns");
    if (addresses.some((address) => isUnsafeIp(address))) {
      throw new NetworkSafetyError("That link cannot be opened.", "private_ip");
    }
    return addresses;
  } catch (error) {
    if (error instanceof NetworkSafetyError) throw error;
    throw new NetworkSafetyError("Could not reach that site.", "dns");
  }
}

export function sanitizeUrlForLog(value: string | URL): string {
  try {
    const parsed = value instanceof URL ? value : new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "invalid url";
  }
}

export function headerValue(headers: SafeHttpHeaders, name: string): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

function defaultPinnedRequest(
  url: URL,
  ip: string,
  options: { timeoutMs: number; headers?: Record<string, string> }
): Promise<SafeHttpResponse> {
  const lib = url.protocol === "https:" ? https : http;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const family = ip.includes(":") && !ip.includes(".") ? 6 : 4;
  const hostname = stripBrackets(ip);

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          Host: url.host,
          Accept: "image/*",
          "User-Agent": "TheSmokeyVault/1.0 (+https://github.com/subarude15/the-smokey-vault)",
          ...options.headers
        },
        setHost: false,
        servername: isIP(stripBrackets(url.hostname)) ? undefined : stripBrackets(url.hostname),
        family,
        timeout: options.timeoutMs
      },
      (res: IncomingMessage) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new NetworkSafetyError("Image download timed out.", "timeout"));
    });
    req.on("error", (error) => {
      if (error instanceof NetworkSafetyError) reject(error);
      else reject(new NetworkSafetyError("Could not reach that site.", "dns"));
    });
    req.end();
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new NetworkSafetyError("Image download timed out.", "timeout"));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Fetches an http(s) URL after resolving and pinning a public address.
 * Redirects are followed manually so each hop is re-validated.
 */
export async function fetchSafeHttp(input: string | URL, options: FetchSafeOptions = {}): Promise<SafeHttpResponse> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRedirects = options.maxRedirects ?? MAX_SAFE_REDIRECTS;
  const lookupFn = options.lookup;
  const request = options.request ?? defaultPinnedRequest;

  let current = parseSafeHttpUrl(typeof input === "string" ? input : input.href);
  let redirects = 0;

  while (true) {
    const addresses = await resolvePublicAddresses(current.hostname, lookupFn);
    const pinned = addresses[0];
    let response: SafeHttpResponse;
    try {
      response = await withTimeout(
        request(current, pinned, { timeoutMs, headers: options.headers }),
        timeoutMs
      );
    } catch (error) {
      if (error instanceof NetworkSafetyError) throw error;
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new NetworkSafetyError("Image download timed out.", "timeout");
      }
      throw new NetworkSafetyError("Could not reach that site.", "dns");
    }

    if (response.status >= 300 && response.status < 400) {
      response.body.resume();
      if (redirects >= maxRedirects) {
        throw new NetworkSafetyError("Too many redirects from that link.", "redirect");
      }
      const location = headerValue(response.headers, "location");
      if (!location) throw new NetworkSafetyError("The page redirected without a destination.", "redirect");
      current = parseSafeHttpUrl(location, current.href);
      redirects += 1;
      continue;
    }

    return response;
  }
}
