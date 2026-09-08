/**
 * PR125 — Commercial tap beer identity + imagery enrichment.
 * Fixtures/stubs only — no live brewery network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { OfficialBeerDiscoveryDeps } from "./official_brewery_beer_discovery.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { db } = await import("./db.js");
const {
  enrichCommercialTap,
  extractOfficialLogoFallbackCandidates,
  isCommercialTap,
  COMMERCIAL_TAP_ENTITY_TYPE,
  COMMERCIAL_TAP_JOB_TYPE
} = await import("./commercial_tap_enrichment.js");
const {
  queueCommercialTapEnrichment,
  buildCommercialTapEnrichmentView,
  runCommercialTapEnrichmentJob
} = await import("./ingestion/jobs/commercial-tap-enrichment.js");
const {
  clearEnrichmentJobsForTests,
  clearEnrichmentSourcesForTests,
  runEnrichmentWorkerOnce,
  getLatestCommercialTapEnrichmentJob
} = await import("./ingestion/jobs/index.js");
const {
  clearOfficialBeerDiscoveryCache
} = await import("./official_brewery_beer_discovery.js");
const {
  GUEST_FORBIDDEN_INVENTORY_KEYS,
  serializeGuestInventoryItem
} = await import("./guest-inventory-response.js");
const { app, createTestAdminToken } = await import("./server.js");

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/official-brewery-beer");
const PREFIX = "PR125";

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

function mockFetch(
  map: Record<string, { html: string; contentType?: string; finalUrl?: string }>
): OfficialBeerDiscoveryDeps["fetchHtml"] {
  return async (url: string) => {
    const hit = map[url] ?? map[url.replace(/\/$/, "")] ?? map[`${url}/`];
    if (!hit) {
      return {
        finalUrl: url,
        html: "<html><head><title>Home</title></head><body></body></html>",
        contentType: "text/html"
      };
    }
    return {
      finalUrl: hit.finalUrl ?? url,
      html: hit.html,
      contentType:
        hit.contentType ??
        (hit.html.includes("<urlset") || hit.html.includes("<sitemapindex")
          ? "application/xml"
          : "text/html")
    };
  };
}

function resetTap(tapNumber: number) {
  db.prepare(
    `UPDATE taps SET
      brewery_batch='', maker='', style='', abv=0, ibu=0, tapped_date=NULL,
      remaining_l=0, notes='', tasting_notes='', image_url='', flavors='[]', tags='[]',
      source_type='Commercial', updated_at=CURRENT_TIMESTAMP
     WHERE tap_number=?`
  ).run(tapNumber);
}

function loadTap(tapNumber: number) {
  return db.prepare("SELECT * FROM taps WHERE tap_number=?").get(tapNumber) as Record<
    string,
    unknown
  >;
}

function setCommercialTap(
  tapNumber: number,
  fields: {
    maker: string;
    beer: string;
    style?: string;
    abv?: number;
    image_url?: string;
    notes?: string;
    remaining_l?: number;
  }
) {
  const row = loadTap(tapNumber);
  db.prepare(
    `UPDATE taps SET
      maker=?, brewery_batch=?, style=?, abv=?, image_url=?, notes=?,
      source_type='Commercial', remaining_l=?, keg_size_l=19.5,
      updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).run(
    fields.maker,
    fields.beer,
    fields.style ?? "",
    fields.abv ?? 0,
    fields.image_url ?? "",
    fields.notes ?? "",
    fields.remaining_l ?? 19.5,
    row.id
  );
  return loadTap(tapNumber);
}

function setHomebrewTap(tapNumber: number) {
  const row = loadTap(tapNumber);
  db.prepare(
    `UPDATE taps SET
      maker=?, brewery_batch=?, style=?, abv=?, image_url='', notes='house notes',
      source_type='Homebrew', remaining_l=10, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).run("Vault", `${PREFIX} Citra Smash`, "IPA", 6.2, row.id);
  return loadTap(tapNumber);
}

function dirtWolfFetch() {
  return mockFetch({
    "https://victorybeer.com/sitemap.xml": {
      html: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://victorybeer.com/beers/dirtwolf/</loc></url>
        <url><loc>https://victorybeer.com/beers/golden-monkey/</loc></url>
      </urlset>`,
      contentType: "application/xml"
    },
    "https://victorybeer.com/sitemap_index.xml": {
      html: "",
      contentType: "text/plain"
    },
    "https://victorybeer.com/beers/dirtwolf/": {
      html: fixture("victory-dirtwolf.html")
    },
    "https://victorybeer.com/beers/dirtwolf": {
      html: fixture("victory-dirtwolf.html")
    },
    "https://victorybeer.com": {
      html: `<html><body><img src="/images/victory-logo.png" alt="Victory Brewing logo"/></body></html>`
    }
  });
}

function cleanup() {
  clearOfficialBeerDiscoveryCache();
  clearEnrichmentJobsForTests();
  clearEnrichmentSourcesForTests();
  for (const n of [1, 2, 3, 4, 5, 6, 7]) resetTap(n);
}

afterEach(cleanup);

test("isCommercialTap excludes Homebrew source_type", () => {
  assert.equal(isCommercialTap({ source_type: "Commercial" }), true);
  assert.equal(isCommercialTap({ source_type: "Homebrew" }), false);
  assert.equal(isCommercialTap({ source_type: "" }), true);
});

test("exact packaged-art reuse: DirtWolf fills style, ABV, and product image", async () => {
  const tap = setCommercialTap(1, {
    maker: "Victory Brewing Company",
    beer: "DirtWolf"
  });
  const fetchHtml = dirtWolfFetch();
  const result = await enrichCommercialTap(Number(tap.id), {
    discoveryDeps: { fetchHtml },
    fetchHtml,
    resolveWebsite: async () => ({
      websiteUrl: "https://victorybeer.com",
      websiteHost: "victorybeer.com"
    }),
    localizeImageDeps: {
      request: async () => {
        throw new Error("localize skipped in unit test");
      }
    }
  });

  assert.equal(result.status, "matched");
  assert.equal(result.match, "exact_name");
  assert.ok(result.updatedFields.includes("style"));
  assert.ok(result.updatedFields.includes("abv"));
  assert.ok(result.updatedFields.includes("image_url"));
  assert.equal(result.imageKind, "product");

  const updated = loadTap(1);
  assert.equal(updated.style, "Double IPA");
  assert.equal(Number(updated.abv), 8.7);
  assert.match(String(updated.image_url), /dw-render/i);
});

test("identity rejection: same brewery, wrong beer does not mutate tap", async () => {
  const tap = setCommercialTap(1, {
    maker: "Victory Brewing Company",
    beer: "Not A Real Victory Beer",
    style: "",
    abv: 0
  });
  const fetchHtml = dirtWolfFetch();
  const result = await enrichCommercialTap(Number(tap.id), {
    discoveryDeps: { fetchHtml },
    fetchHtml,
    resolveWebsite: async () => ({
      websiteUrl: "https://victorybeer.com",
      websiteHost: "victorybeer.com"
    })
  });

  assert.equal(result.status, "no_result");
  assert.deepEqual(result.updatedFields, []);
  const updated = loadTap(1);
  assert.equal(updated.style, "");
  assert.equal(Number(updated.abv), 0);
  assert.equal(updated.image_url, "");
});

test("identity rejection: similar beer name without strong identity is not accepted", async () => {
  const tap = setCommercialTap(1, {
    maker: "Victory Brewing Company",
    beer: "Dirt"
  });
  const fetchHtml = dirtWolfFetch();
  const result = await enrichCommercialTap(Number(tap.id), {
    discoveryDeps: { fetchHtml },
    fetchHtml,
    resolveWebsite: async () => ({
      websiteUrl: "https://victorybeer.com",
      websiteHost: "victorybeer.com"
    })
  });
  assert.notEqual(result.status, "matched");
  assert.deepEqual(result.updatedFields, []);
});

test("Keeper preservation: image, style, ABV, and notes survive enrichment", async () => {
  const tap = setCommercialTap(1, {
    maker: "Victory Brewing Company",
    beer: "DirtWolf",
    style: "Keeper Style",
    abv: 9.9,
    image_url: "/api/media/images/keeper-tap.jpg",
    notes: "Keep these cellar notes"
  });
  const fetchHtml = dirtWolfFetch();
  const result = await enrichCommercialTap(Number(tap.id), {
    discoveryDeps: { fetchHtml },
    fetchHtml,
    resolveWebsite: async () => ({
      websiteUrl: "https://victorybeer.com",
      websiteHost: "victorybeer.com"
    })
  });

  assert.equal(result.status, "matched");
  assert.equal(result.imageKind, "keeper");
  assert.ok(result.preservedFields.includes("image_url"));
  assert.ok(result.preservedFields.includes("style"));
  assert.ok(result.preservedFields.includes("abv"));
  assert.ok(result.preservedFields.includes("notes"));
  assert.deepEqual(result.updatedFields, []);

  const updated = loadTap(1);
  assert.equal(updated.style, "Keeper Style");
  assert.equal(Number(updated.abv), 9.9);
  assert.equal(updated.image_url, "/api/media/images/keeper-tap.jpg");
  assert.equal(updated.notes, "Keep these cellar notes");
});

test("homebrew / Brewfather-linked taps are not processed", async () => {
  const tap = setHomebrewTap(2);
  const queued = queueCommercialTapEnrichment(Number(tap.id));
  assert.equal(queued.ok, false);
  if (!queued.ok) {
    assert.equal(queued.statusCode, 400);
    assert.match(queued.error, /commercial/i);
  }

  const result = await enrichCommercialTap(Number(tap.id), {
    discoveryDeps: { fetchHtml: dirtWolfFetch() },
    resolveWebsite: async () => ({
      websiteUrl: "https://victorybeer.com",
      websiteHost: "victorybeer.com"
    })
  });
  assert.equal(result.status, "skipped_homebrew");
  const updated = loadTap(2);
  assert.equal(updated.style, "IPA");
  assert.equal(Number(updated.abv), 6.2);
  assert.equal(updated.image_url, "");
});

test("no-result leaves tap untouched", async () => {
  const tap = setCommercialTap(1, {
    maker: "Drekker Brewing Company",
    beer: "Ectogasm",
    style: "",
    abv: 0
  });
  const fetchHtml = mockFetch({
    "https://drekkerbrewing.com/sitemap.xml": {
      html: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`,
      contentType: "application/xml"
    },
    "https://drekkerbrewing.com/sitemap_index.xml": {
      html: "",
      contentType: "text/plain"
    },
    "https://drekkerbrewing.com": {
      html: "<html><head><title>Drekker</title></head><body><h1>Brewery</h1></body></html>"
    }
  });
  const result = await enrichCommercialTap(Number(tap.id), {
    discoveryDeps: { fetchHtml },
    fetchHtml,
    resolveWebsite: async () => ({
      websiteUrl: "https://drekkerbrewing.com",
      websiteHost: "drekkerbrewing.com"
    })
  });
  assert.equal(result.status, "no_result");
  assert.deepEqual(result.updatedFields, []);
  const updated = loadTap(1);
  assert.equal(updated.style, "");
  assert.equal(Number(updated.abv), 0);
  assert.equal(updated.image_url, "");
});

test("queue + worker applies commercial tap enrichment in background", async () => {
  const tap = setCommercialTap(3, {
    maker: "Victory Brewing Company",
    beer: "DirtWolf"
  });
  const queued = queueCommercialTapEnrichment(Number(tap.id));
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  assert.equal(queued.created, true);
  assert.equal(queued.job.job_type, COMMERCIAL_TAP_JOB_TYPE);
  assert.equal(queued.job.entity_type, COMMERCIAL_TAP_ENTITY_TYPE);

  const fetchHtml = dirtWolfFetch();
  const ran = await runEnrichmentWorkerOnce({
    commercialTapDeps: {
      discoveryDeps: { fetchHtml },
      fetchHtml,
      resolveWebsite: async () => ({
        websiteUrl: "https://victorybeer.com",
        websiteHost: "victorybeer.com"
      }),
      localizeImageDeps: {
        request: async () => {
          throw new Error("localize skipped");
        }
      }
    }
  });
  assert.equal(ran, true);

  const job = getLatestCommercialTapEnrichmentJob(Number(tap.id));
  assert.equal(job?.status, "completed");
  const updated = loadTap(3);
  assert.equal(updated.style, "Double IPA");
  assert.equal(Number(updated.abv), 8.7);
});

test("Yuengling Traditional Lager control path can match packaged artwork", async () => {
  const tap = setCommercialTap(1, {
    maker: "Yuengling",
    beer: "Traditional Lager"
  });
  const html = `
    <html><head>
      <title>Traditional Lager | Yuengling</title>
      <meta property="og:image" content="https://www.yuengling.com/img/traditional-lager-can.png"/>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "Traditional Lager",
        brand: "Yuengling",
        image: "https://www.yuengling.com/img/traditional-lager-can.png",
        description: "America's Oldest Brewery classic lager.",
        additionalProperty: [
          { name: "ABV", value: "4.5%" },
          { name: "Style", value: "Amber Lager" }
        ]
      })}</script>
    </head><body>
      <h1>Traditional Lager</h1>
      <p>Style: Amber Lager</p>
      <p>ABV: 4.5%</p>
      <img src="https://www.yuengling.com/img/traditional-lager-can.png" alt="Traditional Lager can"/>
    </body></html>
  `;
  const fetchHtml = mockFetch({
    "https://www.yuengling.com/sitemap.xml": {
      html: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://www.yuengling.com/our-beer/traditional-lager/</loc></url>
      </urlset>`,
      contentType: "application/xml"
    },
    "https://www.yuengling.com/sitemap_index.xml": { html: "", contentType: "text/plain" },
    "https://www.yuengling.com/our-beer/traditional-lager/": { html },
    "https://www.yuengling.com/our-beer/traditional-lager": { html },
    "https://www.yuengling.com": { html: "<html><body>Yuengling</body></html>" }
  });

  const result = await enrichCommercialTap(Number(tap.id), {
    discoveryDeps: { fetchHtml },
    fetchHtml,
    resolveWebsite: async () => ({
      websiteUrl: "https://www.yuengling.com",
      websiteHost: "yuengling.com"
    }),
    localizeImageDeps: {
      request: async () => {
        throw new Error("localize skipped");
      }
    }
  });

  assert.equal(result.status, "matched");
  const updated = loadTap(1);
  assert.match(String(updated.style), /lager/i);
  assert.equal(Number(updated.abv), 4.5);
  assert.match(String(updated.image_url), /traditional-lager-can/i);
});

test("logo fallback extractor accepts beer/brewery logos after identity is known", () => {
  const logos = extractOfficialLogoFallbackCandidates({
    html: `
      <img src="/assets/dirtwolf-beer-logo.svg" alt="DirtWolf logo"/>
      <img src="/assets/victory-brewery-logo.png" alt="Victory Brewing Company logo"/>
      <img src="/assets/dw-render.webp" alt="DirtWolf can"/>
    `,
    pageUrl: "https://victorybeer.com/beers/dirtwolf/",
    beerName: "DirtWolf",
    breweryName: "Victory Brewing Company"
  });
  assert.match(String(logos.beerLogo), /dirtwolf-beer-logo/i);
  assert.match(String(logos.breweryLogo), /victory-brewery-logo/i);
});

test("Guest inventory sees enriched public fields and never raw keg quantities or job state", () => {
  const tap = setCommercialTap(1, {
    maker: "Victory Brewing Company",
    beer: "DirtWolf",
    style: "Double IPA",
    abv: 8.7,
    image_url: "/api/media/images/dirtwolf.jpg",
    notes: "Guest-visible cellar note",
    remaining_l: 12.5
  });
  const guest = serializeGuestInventoryItem("taps", tap);
  assert.equal(guest.maker, "Victory Brewing Company");
  assert.equal(guest.brewery_batch, "DirtWolf");
  assert.equal(guest.style, "Double IPA");
  assert.equal(guest.abv, 8.7);
  assert.equal(guest.image_url, "/api/media/images/dirtwolf.jpg");
  assert.ok(typeof guest.availability_pct === "number");
  for (const key of GUEST_FORBIDDEN_INVENTORY_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(guest, key), false, key);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(guest, "remaining_l"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(guest, "keg_size_l"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(guest, "enrichment"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(guest, "job"), false);
});

test("HTTP: Keeper can queue enrich-beer; Guest cannot; Homebrew rejected", async () => {
  const commercial = setCommercialTap(1, {
    maker: "Victory Brewing Company",
    beer: "DirtWolf"
  });
  const homebrew = setHomebrewTap(2);
  const token = createTestAdminToken();

  const guestDenied = await app.inject({
    method: "POST",
    url: `/api/inventory/taps/${commercial.id}/enrich-beer`
  });
  assert.equal(guestDenied.statusCode, 401);

  const guestGetDenied = await app.inject({
    method: "GET",
    url: `/api/inventory/taps/${commercial.id}/enrich-beer`
  });
  assert.equal(guestGetDenied.statusCode, 401);

  const queued = await app.inject({
    method: "POST",
    url: `/api/inventory/taps/${commercial.id}/enrich-beer`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(queued.statusCode, 200);
  const queuedBody = queued.json() as { queued?: boolean; jobId?: number };
  assert.equal(queuedBody.queued, true);
  assert.ok(Number(queuedBody.jobId) > 0);

  const status = await app.inject({
    method: "GET",
    url: `/api/inventory/taps/${commercial.id}/enrich-beer`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(status.statusCode, 200);
  const statusBody = status.json() as { eligible?: boolean; job?: { status?: string } };
  assert.equal(statusBody.eligible, true);
  assert.ok(statusBody.job);

  const homebrewQueue = await app.inject({
    method: "POST",
    url: `/api/inventory/taps/${homebrew.id}/enrich-beer`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(homebrewQueue.statusCode, 400);

  const view = buildCommercialTapEnrichmentView(Number(homebrew.id));
  assert.equal(view?.eligible, false);
  assert.equal(view?.reason, "homebrew_excluded");
});

test("runCommercialTapEnrichmentJob marks completed payload without guessing on miss", async () => {
  const tap = setCommercialTap(1, {
    maker: "Victory Brewing Company",
    beer: "Mystery Hop Explosion"
  });
  const queued = queueCommercialTapEnrichment(Number(tap.id));
  assert.equal(queued.ok, true);
  if (!queued.ok) return;

  const fetchHtml = dirtWolfFetch();
  const result = await runCommercialTapEnrichmentJob(queued.job, {
    discoveryDeps: { fetchHtml },
    fetchHtml,
    resolveWebsite: async () => ({
      websiteUrl: "https://victorybeer.com",
      websiteHost: "victorybeer.com"
    })
  });
  assert.equal(result.status, "no_result");
  const job = getLatestCommercialTapEnrichmentJob(Number(tap.id));
  assert.equal(job?.status, "completed");
  assert.match(String(job?.result_json ?? ""), /no_result|not_found/);
  const updated = loadTap(1);
  assert.equal(updated.style, "");
  assert.equal(updated.image_url, "");
});
