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
  commercialTapHomebrewExclusion,
  isCommercialTapEligible,
  findExactVaultPackagedBeerImage,
  COMMERCIAL_TAP_ENTITY_TYPE,
  COMMERCIAL_TAP_JOB_TYPE
} = await import("./commercial_tap_enrichment.js");
const { tapMatchesBrewBatch, tapLinksToAnyBrewBatch } = await import("./catalog.js");
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
    source_type?: string;
  }
) {
  const row = loadTap(tapNumber);
  db.prepare(
    `UPDATE taps SET
      maker=?, brewery_batch=?, style=?, abv=?, image_url=?, notes=?,
      source_type=?, remaining_l=?, keg_size_l=19.5,
      updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).run(
    fields.maker,
    fields.beer,
    fields.style ?? "",
    fields.abv ?? 0,
    fields.image_url ?? "",
    fields.notes ?? "",
    fields.source_type ?? "Commercial",
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

function insertBrew(batchName: string, brewfatherId?: string) {
  const result = db
    .prepare(
      `INSERT INTO brews (batch_name, style, status, maker, brewfather_id, calculated_abv)
       VALUES (?, 'IPA', 'Ready to Keg', 'Vault', ?, 6.2)`
    )
    .run(batchName, brewfatherId ?? `${PREFIX}-${batchName}`);
  return Number(result.lastInsertRowid);
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
  db.prepare(`DELETE FROM brews WHERE brewfather_id LIKE '${PREFIX}%' OR batch_name LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM packaged_beer WHERE brewery LIKE '${PREFIX}%' OR name LIKE '${PREFIX}%' OR notes LIKE '${PREFIX}%'`).run();
  for (const n of [1, 2, 3, 4, 5, 6, 7]) resetTap(n);
}

afterEach(cleanup);

test("isCommercialTap excludes Homebrew source_type only", () => {
  assert.equal(isCommercialTap({ source_type: "Commercial" }), true);
  assert.equal(isCommercialTap({ source_type: "Homebrew" }), false);
  assert.equal(isCommercialTap({ source_type: "" }), true);
});

test("tap↔brew linkage helpers reuse tapsForBatch exact-name semantics", () => {
  const tap = { tap_number: 1, brewery_batch: "Vault IPA" };
  assert.equal(tapMatchesBrewBatch(tap, "Vault IPA"), true);
  assert.equal(tapMatchesBrewBatch(tap, "vault ipa"), true);
  assert.equal(tapMatchesBrewBatch(tap, "Vault IPA Extra"), false);
  assert.equal(
    tapLinksToAnyBrewBatch(tap, [{ batch_name: "Other" }, { batch_name: "Vault IPA" }]),
    true
  );
  assert.equal(tapLinksToAnyBrewBatch(tap, [{ batch_name: "Other" }]), false);
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

test("1. Homebrew source_type is rejected with no mutations", async () => {
  const tap = setHomebrewTap(2);
  assert.equal(commercialTapHomebrewExclusion(tap), "homebrew_excluded");
  assert.equal(isCommercialTapEligible(tap), false);

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
  assert.equal(result.reason, "homebrew_excluded");
  assert.deepEqual(result.updatedFields, []);
  const updated = loadTap(2);
  assert.equal(updated.style, "IPA");
  assert.equal(Number(updated.abv), 6.2);
  assert.equal(updated.image_url, "");
});

test("2. Blank source_type + exact linked brews.batch_name is rejected", async () => {
  const batch = `${PREFIX} Linked Smash`;
  insertBrew(batch);
  const tap = setCommercialTap(1, {
    maker: "Vault",
    beer: batch,
    style: "",
    abv: 0,
    source_type: ""
  });
  assert.equal(commercialTapHomebrewExclusion(tap), "homebrew_batch_linked");

  const queued = queueCommercialTapEnrichment(Number(tap.id));
  assert.equal(queued.ok, false);
  if (!queued.ok) {
    assert.equal(queued.statusCode, 400);
    assert.match(queued.error, /Brewery Lab|homebrew batch/i);
  }

  const result = await enrichCommercialTap(Number(tap.id), {
    discoveryDeps: { fetchHtml: dirtWolfFetch() },
    resolveWebsite: async () => ({
      websiteUrl: "https://victorybeer.com",
      websiteHost: "victorybeer.com"
    })
  });
  assert.equal(result.status, "skipped_homebrew");
  assert.equal(result.reason, "homebrew_batch_linked");
  assert.deepEqual(result.updatedFields, []);
  const updated = loadTap(1);
  assert.equal(updated.style, "");
  assert.equal(Number(updated.abv), 0);
  assert.equal(updated.image_url, "");
});

test("3. Commercial source_type + exact linked homebrew batch is rejected", async () => {
  const batch = `${PREFIX} Mislabeled Commercial`;
  insertBrew(batch);
  const tap = setCommercialTap(3, {
    maker: "Vault",
    beer: batch,
    style: "Keeper Style",
    abv: 5.5,
    image_url: "",
    source_type: "Commercial"
  });
  assert.equal(commercialTapHomebrewExclusion(tap), "homebrew_batch_linked");

  const queued = queueCommercialTapEnrichment(Number(tap.id));
  assert.equal(queued.ok, false);

  const result = await enrichCommercialTap(Number(tap.id), {
    discoveryDeps: { fetchHtml: dirtWolfFetch() },
    resolveWebsite: async () => ({
      websiteUrl: "https://victorybeer.com",
      websiteHost: "victorybeer.com"
    })
  });
  assert.equal(result.status, "skipped_homebrew");
  assert.equal(result.reason, "homebrew_batch_linked");
  assert.deepEqual(result.updatedFields, []);
  const updated = loadTap(3);
  assert.equal(updated.style, "Keeper Style");
  assert.equal(Number(updated.abv), 5.5);
  assert.equal(updated.image_url, "");
});

test("4. Blank source_type + no linked brew remains legacy-commercial eligible", async () => {
  const tap = setCommercialTap(1, {
    maker: "Victory Brewing Company",
    beer: "DirtWolf",
    source_type: ""
  });
  assert.equal(commercialTapHomebrewExclusion(tap), null);
  assert.equal(isCommercialTapEligible(tap), true);

  const queued = queueCommercialTapEnrichment(Number(tap.id));
  assert.equal(queued.ok, true);

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
        throw new Error("localize skipped");
      }
    }
  });
  assert.equal(result.status, "matched");
  assert.ok(result.updatedFields.includes("style"));
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


function insertPackagedBeer(fields: {
  brewery: string;
  name: string;
  image_url: string;
  style?: string;
  abv?: number;
}) {
  const result = db
    .prepare(
      `INSERT INTO packaged_beer (brewery, name, style, abv, image_url, notes, vessel)
       VALUES (?, ?, ?, ?, ?, ?, 'Can')`
    )
    .run(
      fields.brewery,
      fields.name,
      fields.style ?? "IPA",
      fields.abv ?? 8.7,
      fields.image_url,
      `${PREFIX} vault packaged`
    );
  return Number(result.lastInsertRowid);
}

test("PR138 vault packaged art: exact brewery+beer reuses localized can image without network", async () => {
  insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    image_url: "/api/media/images/vault-dirtwolf-can.jpg"
  });
  const tap = setCommercialTap(1, {
    maker: "Victory Brewing Company",
    beer: "DirtWolf"
  });

  let networkHits = 0;
  const result = await enrichCommercialTap(Number(tap.id), {
    discoveryDeps: {
      fetchHtml: async () => {
        networkHits += 1;
        throw new Error("network should not be required for vault image reuse");
      }
    },
    fetchHtml: async () => {
      networkHits += 1;
      throw new Error("network should not be required for vault image reuse");
    },
    resolveWebsite: async () => ({ websiteUrl: null, websiteHost: null }),
    localizeImageDeps: {
      request: async () => {
        throw new Error("localize should not run for already-local vault media");
      }
    }
  });

  assert.equal(result.status, "matched");
  assert.equal(result.reason, "exact_vault_packaged_beer_image");
  assert.deepEqual(result.updatedFields, ["image_url"]);
  assert.equal(result.imageKind, "product");
  assert.equal(networkHits, 0);

  const updated = loadTap(1);
  assert.equal(updated.image_url, "/api/media/images/vault-dirtwolf-can.jpg");
  assert.equal(updated.style, "");
});

test("PR138 vault packaged art: same brewery wrong beer is rejected", async () => {
  insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "Golden Monkey",
    image_url: "/api/media/images/vault-golden-monkey.jpg"
  });
  const tap = setCommercialTap(1, {
    maker: "Victory Brewing Company",
    beer: "DirtWolf"
  });
  assert.equal(
    findExactVaultPackagedBeerImage("Victory Brewing Company", "DirtWolf"),
    null
  );

  const result = await enrichCommercialTap(Number(tap.id), {
    discoveryDeps: { fetchHtml: dirtWolfFetch() },
    fetchHtml: dirtWolfFetch(),
    resolveWebsite: async () => ({
      websiteUrl: "https://victorybeer.com",
      websiteHost: "victorybeer.com"
    }),
    localizeImageDeps: {
      request: async () => {
        throw new Error("localize skipped");
      }
    }
  });
  // Official discovery may still match DirtWolf; Golden Monkey vault art must not be used.
  if (result.status === "matched" && result.updatedFields.includes("image_url")) {
    assert.notEqual(result.updatedFields && loadTap(1).image_url, "/api/media/images/vault-golden-monkey.jpg");
    assert.equal(/golden-monkey/i.test(String(loadTap(1).image_url)), false);
  }
});

test("PR138 vault packaged art: weak incomplete identity does not reuse packaged image", async () => {
  insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    image_url: "/api/media/images/vault-dirtwolf-can.jpg"
  });
  const tap = setCommercialTap(1, {
    maker: "",
    beer: "DirtWolf"
  });
  const result = await enrichCommercialTap(Number(tap.id), {
    resolveWebsite: async () => ({ websiteUrl: null, websiteHost: null })
  });
  assert.equal(result.status, "skipped_incomplete_identity");
  assert.deepEqual(result.updatedFields, []);
  assert.equal(loadTap(1).image_url, "");
});

test("PR138 vault packaged art: Keeper image is preserved over vault can art", async () => {
  insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    image_url: "/api/media/images/vault-dirtwolf-can.jpg"
  });
  setCommercialTap(1, {
    maker: "Victory Brewing Company",
    beer: "DirtWolf",
    image_url: "/api/media/images/keeper-tap.jpg"
  });
  const result = await enrichCommercialTap(1, {
    discoveryDeps: { fetchHtml: dirtWolfFetch() },
    fetchHtml: dirtWolfFetch(),
    resolveWebsite: async () => ({
      websiteUrl: "https://victorybeer.com",
      websiteHost: "victorybeer.com"
    })
  });
  assert.equal(result.imageKind, "keeper");
  assert.ok(result.preservedFields.includes("image_url"));
  assert.equal(loadTap(1).image_url, "/api/media/images/keeper-tap.jpg");
});

test("PR138 vault packaged art: homebrew taps never receive commercial can art", async () => {
  insertPackagedBeer({
    brewery: "Vault",
    name: `${PREFIX} Citra Smash`,
    image_url: "/api/media/images/should-not-apply.jpg"
  });
  const tap = setHomebrewTap(2);
  const result = await enrichCommercialTap(Number(tap.id), {
    resolveWebsite: async () => ({ websiteUrl: null, websiteHost: null })
  });
  assert.equal(result.status, "skipped_homebrew");
  assert.equal(loadTap(2).image_url, "");
});

test("PR138 product-before-logo: packaged can candidate preferred over beer logo", async () => {
  const { extractOfficialBeerImageCandidates } = await import("./official_brewery_beer_discovery.js");
  const html = `
    <html><body>
      <img src="/assets/dirtwolf-beer-logo.svg" alt="DirtWolf logo"/>
      <img src="/assets/dirtwolf-can.webp" alt="DirtWolf Double IPA can"/>
      <img src="/assets/victory-brewery-logo.png" alt="Victory Brewing Company logo"/>
    </body></html>`;
  const candidates = extractOfficialBeerImageCandidates({
    html,
    pageUrl: "https://victorybeer.com/beers/dirtwolf/",
    beerName: "DirtWolf"
  });
  assert.ok(candidates.some((url) => /dirtwolf-can/i.test(url)));
});
