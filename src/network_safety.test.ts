import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  MAX_SAFE_REDIRECTS,
  NetworkSafetyError,
  fetchSafeHttp,
  isUnsafeIp,
  parseSafeHttpUrl,
  resolvePublicAddresses,
  sanitizeUrlForLog
} from "./network_safety.js";

test("isUnsafeIp blocks loopback, RFC1918, link-local, unique-local, multicast, unspecified", () => {
  assert.equal(isUnsafeIp("127.0.0.1"), true);
  assert.equal(isUnsafeIp("0.0.0.0"), true);
  assert.equal(isUnsafeIp("10.1.2.3"), true);
  assert.equal(isUnsafeIp("172.16.0.1"), true);
  assert.equal(isUnsafeIp("172.31.255.1"), true);
  assert.equal(isUnsafeIp("192.168.1.9"), true);
  assert.equal(isUnsafeIp("169.254.169.254"), true);
  assert.equal(isUnsafeIp("::1"), true);
  assert.equal(isUnsafeIp("::"), true);
  assert.equal(isUnsafeIp("fe80::1"), true);
  assert.equal(isUnsafeIp("fd12:3456::1"), true);
  assert.equal(isUnsafeIp("fc00::1"), true);
  assert.equal(isUnsafeIp("ff02::1"), true);
  assert.equal(isUnsafeIp("224.0.0.1"), true);
  assert.equal(isUnsafeIp("::ffff:127.0.0.1"), true);
  assert.equal(isUnsafeIp("8.8.8.8"), false);
  assert.equal(isUnsafeIp("172.15.0.1"), false);
  assert.equal(isUnsafeIp("172.32.0.1"), false);
  assert.equal(isUnsafeIp("1.1.1.1"), false);
  assert.equal(isUnsafeIp("2001:4860:4860::8888"), false);
});

test("parseSafeHttpUrl allows only http(s) and rejects unsafe hosts and schemes", () => {
  assert.equal(parseSafeHttpUrl("http://cdn.example/a.png").protocol, "http:");
  assert.equal(parseSafeHttpUrl("https://cdn.example/a.png").protocol, "https:");
  for (const raw of [
    "file:///etc/passwd",
    "ftp://cdn.example/a.png",
    "data:image/png;base64,xx",
    "javascript:alert(1)",
    "blob:https://cdn.example/1"
  ]) {
    assert.throws(() => parseSafeHttpUrl(raw), (error: unknown) => (
      error instanceof NetworkSafetyError && error.reason === "bad_scheme"
    ));
  }
  assert.throws(() => parseSafeHttpUrl("http://localhost/x"), NetworkSafetyError);
  assert.throws(() => parseSafeHttpUrl("http://127.0.0.1/x"), NetworkSafetyError);
  assert.throws(() => parseSafeHttpUrl("http://[::1]/x"), NetworkSafetyError);
  assert.throws(() => parseSafeHttpUrl("http://10.0.0.4/x"), NetworkSafetyError);
  assert.throws(() => parseSafeHttpUrl("http://172.20.0.2/x"), NetworkSafetyError);
  assert.throws(() => parseSafeHttpUrl("http://192.168.0.5/x"), NetworkSafetyError);
  assert.throws(() => parseSafeHttpUrl("http://169.254.169.254/latest"), NetworkSafetyError);
  assert.throws(() => parseSafeHttpUrl("http://[fe80::1]/x"), NetworkSafetyError);
  assert.throws(() => parseSafeHttpUrl("http://[fd00::1]/x"), NetworkSafetyError);
  assert.throws(() => parseSafeHttpUrl("http://user:pass@cdn.example/x"), NetworkSafetyError);
});

test("sanitizeUrlForLog strips query tokens", () => {
  assert.equal(
    sanitizeUrlForLog("https://cdn.example/img.png?token=secret&sig=1"),
    "https://cdn.example/img.png"
  );
});

test("resolvePublicAddresses rejects a hostname that resolves to a private IP", async () => {
  await assert.rejects(
    () => resolvePublicAddresses("evil.example", async () => [{ address: "10.0.0.8", family: 4 }]),
    (error: unknown) => error instanceof NetworkSafetyError && error.reason === "private_ip"
  );
  await assert.rejects(
    () => resolvePublicAddresses("evil.example", async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "169.254.169.254", family: 4 }
    ]),
    (error: unknown) => error instanceof NetworkSafetyError && error.reason === "private_ip"
  );
  const publicIps = await resolvePublicAddresses("cdn.example", async () => [{ address: "203.0.113.10", family: 4 }]);
  assert.deepEqual(publicIps, ["203.0.113.10"]);
});

test("fetchSafeHttp rejects a redirect to a private target and over-long chains", async () => {
  const lookup = async () => [{ address: "203.0.113.10", family: 4 }];
  await assert.rejects(
    () => fetchSafeHttp("https://cdn.example/start.png", {
      lookup,
      request: async () => ({
        status: 302,
        headers: { location: "http://127.0.0.1/secret" },
        body: Readable.from([])
      })
    }),
    (error: unknown) => error instanceof NetworkSafetyError && error.reason === "private_ip"
  );

  let hops = 0;
  await assert.rejects(
    () => fetchSafeHttp("https://cdn.example/start.png", {
      lookup,
      maxRedirects: MAX_SAFE_REDIRECTS,
      request: async () => {
        hops += 1;
        return {
          status: 302,
          headers: { location: `https://cdn.example/hop-${hops}.png` },
          body: Readable.from([])
        };
      }
    }),
    (error: unknown) => error instanceof NetworkSafetyError && error.reason === "redirect"
  );
  assert.equal(hops, MAX_SAFE_REDIRECTS + 1);
});
