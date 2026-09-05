/**
 * SSRF / streaming-size regressions for official brewery discovery's
 * production fetch path (fetchSafeHttp + domain gate). Fixtures/stubs only.
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  NetworkSafetyError,
  fetchSafeHttp
} from "./network_safety.js";
import {
  clearOfficialBeerDiscoveryCache,
  discoverOfficialBeerProductPage,
  type OfficialBeerDiscoveryDeps
} from "./official_brewery_beer_discovery.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/official-brewery-beer");

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

function publicLookup() {
  return async () => [{ address: "203.0.113.10", family: 4 }];
}

function privateLookup(ip: string) {
  return async () => [{ address: ip, family: 4 }];
}

function htmlResponse(html: string, headers: Record<string, string> = {}) {
  return {
    status: 200,
    headers: { "content-type": "text/html", ...headers },
    body: Readable.from([html])
  };
}

function redirectResponse(location: string) {
  return {
    status: 302,
    headers: { location },
    body: Readable.from([])
  };
}

test("fetchSafeHttp maxRedirects=0 returns redirect response to caller", async () => {
  const response = await fetchSafeHttp("https://yardsbrewing.com/beers/brawler", {
    maxRedirects: 0,
    lookup: publicLookup(),
    request: async () => redirectResponse("https://yardsbrewing.com/products/brawler")
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "https://yardsbrewing.com/products/brawler");
  response.body.resume();
});

test("A. hostname resolving to 127.0.0.1 is rejected", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      lookup: privateLookup("127.0.0.1"),
      request: async () => {
        throw new Error("request_should_not_run");
      }
    }
  );
  assert.notEqual(result.status, "matched");
  assert.equal(result.match, "none");
  assert.equal(result.productPageUrl, null);
});

test("B. hostname resolving to RFC1918 private IP is rejected", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      lookup: privateLookup("10.0.0.8"),
      request: async () => {
        throw new Error("request_should_not_run");
      }
    }
  );
  assert.notEqual(result.status, "matched");
  assert.equal(result.match, "none");
});

test("C. safe public DNS result proceeds", async () => {
  clearOfficialBeerDiscoveryCache();
  let sawRequest = false;
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      lookup: publicLookup(),
      request: async (url) => {
        sawRequest = true;
        const path = url.pathname;
        if (path.includes("sitemap")) {
          return htmlResponse(fixture("yards-sitemap.xml"), {
            "content-type": "application/xml"
          });
        }
        if (path.includes("brawler")) {
          return htmlResponse(fixture("yards-brawler.html"));
        }
        return htmlResponse("<html><title>Home</title><body></body></html>");
      }
    }
  );
  assert.equal(sawRequest, true);
  assert.equal(result.status, "matched");
  assert.equal(result.match, "exact_name");
  assert.match(String(result.productPageUrl), /brawler/);
});

test("D. redirect to private-address hostname is rejected", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      lookup: async (hostname) => {
        if (hostname === "127.0.0.1" || hostname === "localhost") {
          return [{ address: "127.0.0.1", family: 4 }];
        }
        return [{ address: "203.0.113.10", family: 4 }];
      },
      request: async (url) => {
        if (!url.pathname.includes("brawler") && !url.pathname.includes("sitemap")) {
          return redirectResponse("http://127.0.0.1/secret");
        }
        if (url.pathname.includes("sitemap")) {
          return htmlResponse("", { "content-type": "text/plain" });
        }
        return redirectResponse("http://127.0.0.1/secret");
      }
    }
  );
  assert.notEqual(result.status, "matched");
  assert.equal(result.productPageUrl, null);
});

test("E. redirect that leaves the official brewery domain is rejected", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      lookup: publicLookup(),
      request: async (url) => {
        if (url.pathname.includes("sitemap")) {
          return htmlResponse(fixture("yards-sitemap.xml"), {
            "content-type": "application/xml"
          });
        }
        // Product URL redirects off-domain to a public host.
        return redirectResponse("https://evil-cdn.example/brawler");
      }
    }
  );
  assert.notEqual(result.status, "matched");
  assert.equal(result.productPageUrl, null);
});

test("F. response exceeding maxBytes while streaming is stopped before full buffering", async () => {
  clearOfficialBeerDiscoveryCache();
  let destroyed = false;
  const maxBytes = 64;
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      maxBytes,
      lookup: publicLookup(),
      request: async (url) => {
        if (url.pathname.includes("sitemap")) {
          return htmlResponse("", { "content-type": "text/plain" });
        }
        const body = new Readable({
          read() {
            this.push(Buffer.alloc(maxBytes + 32, 0x61));
            this.push(null);
          },
          destroy(err, cb) {
            destroyed = true;
            cb(err);
          }
        });
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body
        };
      }
    }
  );
  assert.notEqual(result.status, "matched");
  assert.equal(destroyed, true);
});

test("G. Content-Length > maxBytes is rejected before body accumulation", async () => {
  clearOfficialBeerDiscoveryCache();
  let bodyRead = false;
  const maxBytes = 128;
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      maxBytes,
      lookup: publicLookup(),
      request: async (url) => {
        if (url.pathname.includes("sitemap")) {
          return htmlResponse("", { "content-type": "text/plain" });
        }
        const body = new Readable({
          read() {
            bodyRead = true;
            this.push("should-not-be-read");
            this.push(null);
          }
        });
        return {
          status: 200,
          headers: {
            "content-type": "text/html",
            "content-length": String(maxBytes + 500)
          },
          body
        };
      }
    }
  );
  assert.notEqual(result.status, "matched");
  assert.equal(bodyRead, false);
});

test("H. normal small HTML still discovers the product page via safe fetch path", async () => {
  clearOfficialBeerDiscoveryCache();
  const deps: OfficialBeerDiscoveryDeps = {
    lookup: publicLookup(),
    request: async (url) => {
      if (url.pathname.includes("sitemap.xml") && !url.pathname.includes("index")) {
        return htmlResponse(fixture("yards-sitemap.xml"), {
          "content-type": "application/xml"
        });
      }
      if (url.pathname.includes("sitemap")) {
        return htmlResponse("", { "content-type": "text/plain" });
      }
      if (url.pathname.includes("brawler")) {
        return htmlResponse(fixture("yards-brawler.html"));
      }
      return htmlResponse("<html><title>Home</title><body><a href=\"/beers/brawler\">Brawler</a></body></html>");
    }
  };
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    deps
  );
  assert.equal(result.status, "matched");
  assert.equal(result.match, "exact_name");
  assert.equal(result.fields.abv, 4.2);
  assert.match(String(result.productPageUrl), /brawler/);
});

test("private DNS rejection surfaces as NetworkSafetyError from fetchSafeHttp", async () => {
  await assert.rejects(
    () =>
      fetchSafeHttp("https://yardsbrewing.com/", {
        lookup: privateLookup("192.168.1.20"),
        request: async () => htmlResponse("nope")
      }),
    (error: unknown) => error instanceof NetworkSafetyError && error.reason === "private_ip"
  );
});
