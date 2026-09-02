import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { imagesDir, localizeImage, saveImageBuffer, sniffImageType } from "./images.js";
import type { LookupFn, PinnedRequestFn, SafeHttpResponse } from "./network_safety.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

test("sniffImageType recognizes PNG magic bytes", () => {
  assert.equal(sniffImageType(png), "image/png");
  assert.equal(sniffImageType(Buffer.from("not-an-image")), "");
});

test("saveImageBuffer stores a PNG and returns a local media URL", () => {
  const url = saveImageBuffer(png, "image/png", "label.png");
  assert.match(url, /^\/api\/media\/images\/[a-f0-9]{32}\.png$/);
  const filename = url.split("/").pop()!;
  const path = join(imagesDir, filename);
  assert.equal(existsSync(path), true);
  const again = saveImageBuffer(png, "image/png", "label.png");
  assert.equal(again, url);
  unlinkSync(path);
});

test("saveImageBuffer rejects non-images", () => {
  assert.throws(() => saveImageBuffer(Buffer.from("hello"), "text/plain", "notes.txt"), /JPEG, PNG/);
});

const PUBLIC_LOOKUP: LookupFn = async () => [{ address: "203.0.113.10", family: 4 }];

function pngResponse(headers: Record<string, string> = {}): SafeHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "image/png", "content-length": String(png.length), ...headers },
    body: Readable.from([png])
  };
}

function imageHashPath(remoteUrl: string, ext = ".png") {
  const hash = createHash("sha256").update(remoteUrl).digest("hex").slice(0, 32);
  return join(imagesDir, `${hash}${ext}`);
}

function leftoverTemps() {
  return readdirSync(imagesDir).filter((name) => name.startsWith(".tmp-"));
}

function cleanupLocalized(remoteUrl: string) {
  const path = imageHashPath(remoteUrl);
  if (existsSync(path)) unlinkSync(path);
  for (const name of leftoverTemps()) unlinkSync(join(imagesDir, name));
}

test("localizeImage writes http and https public images and preserves the hash URL", async () => {
  const hits: string[] = [];
  const request: PinnedRequestFn = async (url) => {
    hits.push(url.protocol);
    return pngResponse();
  };
  for (const remoteUrl of ["http://cdn.example/label.png", "https://cdn.example/label.png"]) {
    cleanupLocalized(remoteUrl);
    const local = await localizeImage(remoteUrl, { lookup: PUBLIC_LOOKUP, request });
    assert.equal(local, `/api/media/images/${createHash("sha256").update(remoteUrl).digest("hex").slice(0, 32)}.png`);
    assert.equal(existsSync(imageHashPath(remoteUrl)), true);
    cleanupLocalized(remoteUrl);
  }
  assert.deepEqual(hits, ["http:", "https:"]);
});

test("localizeImage rejects localhost, loopback, RFC1918, metadata, and IPv6 private targets", async () => {
  let requested = 0;
  const request: PinnedRequestFn = async () => {
    requested += 1;
    return pngResponse();
  };
  const blocked = [
    "http://localhost/a.png",
    "http://127.0.0.1/a.png",
    "http://[::1]/a.png",
    "http://10.4.5.6/a.png",
    "http://172.16.9.1/a.png",
    "http://192.168.10.2/a.png",
    "http://169.254.169.254/latest/meta-data",
    "http://[fe80::2]/a.png",
    "http://[fd00::2]/a.png"
  ];
  for (const url of blocked) {
    const result = await localizeImage(url, { lookup: PUBLIC_LOOKUP, request });
    assert.equal(result, url, url);
    assert.equal(existsSync(imageHashPath(url)), false, url);
  }
  assert.equal(requested, 0);
});

test("localizeImage rejects a hostname that resolves to a private IP", async () => {
  let requested = 0;
  const result = await localizeImage("https://evil.example/a.png", {
    lookup: async () => [{ address: "10.0.0.9", family: 4 }],
    request: async () => {
      requested += 1;
      return pngResponse();
    }
  });
  assert.equal(result, "https://evil.example/a.png");
  assert.equal(requested, 0);
});

test("localizeImage rejects a public-to-private redirect", async () => {
  const remoteUrl = "https://cdn.example/start.png";
  const result = await localizeImage(remoteUrl, {
    lookup: PUBLIC_LOOKUP,
    request: async () => ({
      status: 302,
      headers: { location: "http://192.168.1.50/pwn.png" },
      body: Readable.from([])
    })
  });
  assert.equal(result, remoteUrl);
  assert.equal(existsSync(imageHashPath(remoteUrl)), false);
});

test("localizeImage rejects a redirect chain beyond the limit", async () => {
  const remoteUrl = "https://cdn.example/start.png";
  let hops = 0;
  const result = await localizeImage(remoteUrl, {
    lookup: PUBLIC_LOOKUP,
    request: async () => {
      hops += 1;
      return {
        status: 302,
        headers: { location: `https://cdn.example/next-${hops}.png` },
        body: Readable.from([])
      };
    }
  });
  assert.equal(result, remoteUrl);
  assert.ok(hops > 5);
  assert.equal(existsSync(imageHashPath(remoteUrl)), false);
});

test("localizeImage rejects unsupported schemes without fetching", async () => {
  let requested = 0;
  const request: PinnedRequestFn = async () => {
    requested += 1;
    return pngResponse();
  };
  for (const url of ["file:///tmp/a.png", "ftp://cdn.example/a.png", "data:image/png;base64,xx", "javascript:alert(1)"]) {
    assert.equal(await localizeImage(url, { lookup: PUBLIC_LOOKUP, request }), url);
  }
  assert.equal(requested, 0);
});

test("localizeImage rejects Content-Length over the cap before writing", async () => {
  const remoteUrl = "https://cdn.example/huge.png";
  cleanupLocalized(remoteUrl);
  let bodyRead = false;
  const result = await localizeImage(remoteUrl, {
    lookup: PUBLIC_LOOKUP,
    maxBytes: 64,
    request: async () => ({
      status: 200,
      headers: { "content-type": "image/png", "content-length": "999999" },
      body: new Readable({
        read() {
          bodyRead = true;
          this.push(png);
          this.push(null);
        }
      })
    })
  });
  assert.equal(result, remoteUrl);
  assert.equal(existsSync(imageHashPath(remoteUrl)), false);
  assert.equal(leftoverTemps().length, 0);
  assert.equal(bodyRead, false);
});

test("localizeImage aborts a streaming body that exceeds the cap, including when Content-Length is missing", async () => {
  const remoteUrl = "https://cdn.example/stream.png";
  cleanupLocalized(remoteUrl);
  const chunk = Buffer.alloc(40, 0x41);
  const result = await localizeImage(remoteUrl, {
    lookup: PUBLIC_LOOKUP,
    maxBytes: 50,
    request: async () => ({
      status: 200,
      headers: { "content-type": "image/png" },
      body: Readable.from([chunk, chunk, chunk])
    })
  });
  assert.equal(result, remoteUrl);
  assert.equal(existsSync(imageHashPath(remoteUrl)), false);
  assert.equal(leftoverTemps().length, 0);
});

test("localizeImage times out a stalled download and leaves no temp file", async () => {
  const remoteUrl = "https://cdn.example/slow.png";
  cleanupLocalized(remoteUrl);
  const result = await localizeImage(remoteUrl, {
    lookup: PUBLIC_LOOKUP,
    timeoutMs: 40,
    request: () => new Promise(() => {})
  });
  assert.equal(result, remoteUrl);
  assert.equal(existsSync(imageHashPath(remoteUrl)), false);
  assert.equal(leftoverTemps().length, 0);
});

test("localizeImage times out a body that stalls after the first chunk", async () => {
  const remoteUrl = "https://cdn.example/stalled-body.png";
  cleanupLocalized(remoteUrl);
  let destroyed = false;
  const body = new Readable({
    read() {
      if ((this as Readable & { sent?: boolean }).sent) return;
      (this as Readable & { sent?: boolean }).sent = true;
      this.push(png.subarray(0, 12));
    }
  });
  body.on("close", () => {
    destroyed = true;
  });

  const started = Date.now();
  const result = await localizeImage(remoteUrl, {
    lookup: PUBLIC_LOOKUP,
    timeoutMs: 80,
    request: async () => ({
      status: 200,
      headers: { "content-type": "image/png" },
      body
    })
  });
  const elapsed = Date.now() - started;

  assert.equal(result, remoteUrl);
  assert.ok(elapsed < 2000, `stalled body must not hang (took ${elapsed}ms)`);
  assert.equal(destroyed, true);
  assert.equal(existsSync(imageHashPath(remoteUrl)), false);
  assert.equal(leftoverTemps().length, 0);
});

test("localizeImage rejects non-image content types", async () => {
  const remoteUrl = "https://cdn.example/page.html";
  const result = await localizeImage(remoteUrl, {
    lookup: PUBLIC_LOOKUP,
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html", "content-length": "12" },
      body: Readable.from([Buffer.from("<html></html>")])
    })
  });
  assert.equal(result, remoteUrl);
  assert.equal(existsSync(imageHashPath(remoteUrl)), false);
});

test("localizeImage logs a sanitized hostname without query tokens", async () => {
  const remoteUrl = "https://cdn.example/ok.png?token=super-secret";
  cleanupLocalized(remoteUrl);
  const events: Array<{ url: string; outcome: string }> = [];
  const local = await localizeImage(remoteUrl, {
    lookup: PUBLIC_LOOKUP,
    request: async () => pngResponse(),
    log: (entry) => events.push({ url: entry.url, outcome: entry.outcome })
  });
  assert.match(local ?? "", /\/api\/media\/images\/[a-f0-9]{32}\.png$/);
  assert.equal(events[0]?.url.includes("super-secret"), false);
  assert.equal(events[0]?.url.includes("token="), false);
  cleanupLocalized(remoteUrl);
});

