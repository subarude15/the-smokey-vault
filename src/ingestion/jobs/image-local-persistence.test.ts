/**
 * Local persistence of accepted enriched product images (product_images only).
 * Covers FWGS Figranium byte save, remote repair, user-image priority, and
 * no binary leakage into result payloads.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { db } from "../../db.js";
import { writeExcelMatrix } from "../catalogs/government/excel-matrix.js";
import { PA_EXPECTED_HEADERS } from "../catalogs/government/pa-columns.js";
import { importPaSpiritsWorkbook } from "../catalogs/government/pa-import.js";
import { resetGovernmentDbConnection } from "../catalogs/government/schema.js";
import { FwgsFigraniumProviderError } from "../../fwgs-figranium.js";
import { imagesDir, isLocalImagePath, saveImageBuffer } from "../../images.js";
import {
  claimNextPendingJob,
  clearEnrichmentJobsForTests,
  clearProductImagesForTests,
  enqueueImageJob,
  getProductImage,
  hasDurableAcceptedProductImage,
  productImageNeedsLocalization,
  resolveInventoryDisplayImageUrl,
  runImageJob,
  shouldScheduleImageEnrichment,
  upsertProductImage
} from "./index.js";

const JACQUIN_UPC = "084380282645";
const JACQUIN_PLCB = "000005555";
const JACQUIN_FWGS =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000005555_F1.jpg&height=1200&width=1200";
const JACQUIN_PDP =
  "https://www.finewineandgoodspirits.com/jacquins-creme-de-menthe-white/product/000005555";

const CAPTAIN_UPC = "087000201156";
const CAPTAIN_PLCB = "000004766";
const CAPTAIN_FWGS =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg&height=1200&width=1200";

const cleanVision = {
  correct_product: true,
  bottle_prominent: true,
  contains_people: false,
  meme_or_graphic: false,
  clean_product_photo: true,
  multiple_products: false
};

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(width: number, height: number, seed = 0): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3, seed & 0xff);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function expectedLocalPath(bytes: Buffer): string {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return `/api/media/images/${hash}.png`;
}

function cleanupSpirits(...upcs: string[]) {
  clearEnrichmentJobsForTests();
  clearProductImagesForTests();
  for (const upc of upcs) {
    db.prepare("DELETE FROM spirits WHERE upc=?").run(upc);
  }
}

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "PersistTest Spirit",
    brand: "PersistTest",
    category: "Liqueur",
    abv: 30,
    volume_ml: 750,
    upc: "084380282645",
    image_url: "",
    ...overrides
  };
  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.name, row.brand, row.category, row.abv, row.volume_ml, row.upc, row.image_url);
  const id = Number(result.lastInsertRowid);
  return db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
}

async function writeJacquinWorkbook(filePath: string): Promise<void> {
  const row: Record<string, unknown> & { upcs: string[] } = {
    "Division Name": "Stock Spirits",
    "Group Name": "Cordials",
    "Class Name": "Creme de Menthe",
    "PLCB Item": JACQUIN_PLCB,
    "Item Description": "Jacquin's Creme de Menthe White",
    "PLCB SCC Item": "10008438028264",
    "Manufacturer SCC": "00008438028264",
    "Liquid Volume": "750 mL",
    "Case Pack": 12,
    "Current Regular Retail": 9.99,
    "Price Indicator": "N",
    Proof: 60,
    Vintage: "N/A",
    "Brand Name": "JACQUIN'S",
    "Import/Domestic": "Domestic",
    Country: "United States",
    Region: "",
    "Extraction Date": "2026-03-23",
    upcs: [JACQUIN_UPC, "", "", "", ""]
  };
  let upcOrdinal = 0;
  await writeExcelMatrix(
    [
      [...PA_EXPECTED_HEADERS],
      PA_EXPECTED_HEADERS.map((header) =>
        header === "UPC" ? row.upcs[upcOrdinal++] ?? "" : row[header] ?? ""
      )
    ],
    filePath
  );
}

async function writeCaptainWorkbook(filePath: string): Promise<void> {
  const row: Record<string, unknown> & { upcs: string[] } = {
    "Division Name": "Stock Spirits",
    "Group Name": "Rum",
    "Class Name": "Spiced Rum",
    "PLCB Item": CAPTAIN_PLCB,
    "Item Description": "Captain Morgan Original Spiced Rum",
    "PLCB SCC Item": "10008700020115",
    "Manufacturer SCC": "00008700020115",
    "Liquid Volume": "1.75 L",
    "Case Pack": 6,
    "Current Regular Retail": 29.99,
    "Price Indicator": "N",
    Proof: 70,
    Vintage: "N/A",
    "Brand Name": "CAPTAIN MORGAN",
    "Import/Domestic": "Domestic",
    Country: "United States",
    Region: "",
    "Extraction Date": "2026-03-23",
    upcs: [CAPTAIN_UPC, "", "", "", ""]
  };
  let upcOrdinal = 0;
  await writeExcelMatrix(
    [
      [...PA_EXPECTED_HEADERS],
      PA_EXPECTED_HEADERS.map((header) =>
        header === "UPC" ? row.upcs[upcOrdinal++] ?? "" : row[header] ?? ""
      )
    ],
    filePath
  );
}

test("A/B/D/E/K. new FWGS accepted image is saved locally; inventory untouched; exact Figranium bytes; no binary in payload", async () => {
  const govDbPath = path.join(
    os.tmpdir(),
    `jacquin-persist-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
  const workbook = `${govDbPath}.xlsx`;
  const previousGovDbPath = process.env.GOVERNMENT_CATALOG_DB_PATH;
  const originalFetch = globalThis.fetch;
  process.env.GOVERNMENT_CATALOG_DB_PATH = govDbPath;
  resetGovernmentDbConnection();
  cleanupSpirits(JACQUIN_UPC);

  const png = makePng(64, 64, 7);
  let figraniumCalls = 0;
  let directFwgsGets = 0;

  try {
    await writeJacquinWorkbook(workbook);
    await importPaSpiritsWorkbook(workbook, { dbPath: govDbPath });

    const spirit = insertSpirit({
      name: "Jacquin's Creme de Menthe White",
      brand: "Jacquin's",
      upc: JACQUIN_UPC,
      image_url: ""
    });
    const entityId = Number(spirit.id);
    enqueueImageJob({ entityType: "spirits", entityId, upc: JACQUIN_UPC });
    const job = claimNextPendingJob()!;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://www.finewineandgoodspirits.com/")) {
        directFwgsGets += 1;
        return new Response("blocked", { status: 403 });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const result = await runImageJob(job, {
      searchImageHits: async () => [],
      searchWebHits: async () => [],
      fetchPageHtml: async () => null,
      extractFwgsPlcbImages: async (plcbItem) => {
        assert.equal(plcbItem, JACQUIN_PLCB);
        return {
          matched: true,
          plcbItem,
          imageUrls: [JACQUIN_FWGS],
          primaryImageUrl: JACQUIN_FWGS,
          extractionSource: "embedded_json"
        };
      },
      fetchFwgsImageViaFigranium: async (imageUrl, plcbItem) => {
        figraniumCalls += 1;
        assert.equal(plcbItem, JACQUIN_PLCB);
        assert.ok(validateUrlIsJacquin(imageUrl));
        return {
          ok: true,
          image: {
            plcbItem,
            sourceUrl: imageUrl,
            contentType: "image/png",
            bytes: png,
            width: 1200,
            height: 1200
          }
        };
      },
      verifyImage: async (request) => {
        assert.ok(request.imageBase64);
        assert.equal(request.imageBase64, png.toString("base64"));
        return cleanVision;
      }
    });

    assert.equal(result.imageSaved, true);
    assert.equal(result.inventoryImageUrl, null);
    assert.ok(figraniumCalls >= 1);
    // Direct probe runs once for the already-1200 FWGS URL; Figranium supplies bytes.
    // A second accidental direct FWGS GET would fail this assertion.
    assert.equal(directFwgsGets, 1);
    const stored = getProductImage("spirits", entityId);
    assert.ok(stored);
    assert.ok(isLocalImagePath(stored!.url));
    assert.equal(stored!.url, expectedLocalPath(png));
    assert.notEqual(stored!.url, JACQUIN_FWGS);
    assert.ok(stored!.source_type !== "user");
    assert.ok(["official", "approved", "licensed"].includes(String(stored!.source_type)));
    assert.equal(stored!.verified, true);
    assert.ok((stored!.score ?? 0) >= 75);

    const inventory = db.prepare("SELECT image_url FROM spirits WHERE id=?").get(entityId) as {
      image_url: string;
    };
    assert.equal(inventory.image_url, "");

    const display = resolveInventoryDisplayImageUrl("spirits", entityId, {
      ...spirit,
      image_url: ""
    });
    assert.equal(display, stored!.url);

    const payloadJson = JSON.stringify(result.resultPayload);
    assert.equal(payloadJson.includes("imageBase64"), false);
    assert.equal(payloadJson.includes(png.toString("base64")), false);
    assert.equal(/\"bytes\"\s*:/.test(payloadJson), false);
    assert.equal(payloadJson.includes("Buffer"), false);

    const diagJson = JSON.stringify(result.resultPayload.diagnostics ?? {});
    assert.equal(diagJson.includes(png.toString("base64")), false);
    assert.equal(diagJson.includes("imageBase64"), false);

    // selectedAsset must not leak into the persisted payload shape.
    assert.equal("selectedAsset" in result.resultPayload, false);
  } finally {
    globalThis.fetch = originalFetch;
    cleanupSpirits(JACQUIN_UPC);
    resetGovernmentDbConnection();
    if (previousGovDbPath === undefined) delete process.env.GOVERNMENT_CATALOG_DB_PATH;
    else process.env.GOVERNMENT_CATALOG_DB_PATH = previousGovDbPath;
    for (const file of [govDbPath, `${govDbPath}-wal`, `${govDbPath}-shm`, workbook]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }
});

function validateUrlIsJacquin(url: string): boolean {
  return url.includes("000005555") && url.includes("finewineandgoodspirits.com");
}

test("C. user image always wins — no machine localization", async () => {
  cleanupSpirits("084380299001");
  const spirit = insertSpirit({
    name: "PersistTest UserWins",
    upc: "084380299001",
    image_url: "/api/media/images/user-photo.jpg"
  });
  const entityId = Number(spirit.id);
  enqueueImageJob({ entityType: "spirits", entityId, upc: "084380299001" });
  const job = claimNextPendingJob()!;

  let fetchCalled = 0;
  const result = await runImageJob(job, {
    fetchFwgsImageViaFigranium: async () => {
      fetchCalled += 1;
      return { ok: false, reason: "not_configured" };
    },
    searchImageHits: async () => {
      fetchCalled += 1;
      return [];
    },
    localizeImage: async () => {
      fetchCalled += 1;
      return "/api/media/images/should-not-happen.jpg";
    }
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "user_image_present");
  assert.equal(fetchCalled, 0);
  assert.equal(
    getProductImage("spirits", entityId)?.source_type,
    "user"
  );
  const inventory = db.prepare("SELECT image_url FROM spirits WHERE id=?").get(entityId) as {
    image_url: string;
  };
  assert.equal(inventory.image_url, "/api/media/images/user-photo.jpg");
  cleanupSpirits("084380299001");
});

test("F. existing accepted remote FWGS image is repairable (not already_complete)", async () => {
  const govDbPath = path.join(
    os.tmpdir(),
    `jacquin-repair-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
  const workbook = `${govDbPath}.xlsx`;
  const previousGovDbPath = process.env.GOVERNMENT_CATALOG_DB_PATH;
  process.env.GOVERNMENT_CATALOG_DB_PATH = govDbPath;
  resetGovernmentDbConnection();
  cleanupSpirits(JACQUIN_UPC);

  const png = makePng(48, 48, 11);
  let figraniumCalls = 0;

  try {
    await writeJacquinWorkbook(workbook);
    await importPaSpiritsWorkbook(workbook, { dbPath: govDbPath });

    const spirit = insertSpirit({
      name: "Jacquin's Creme de Menthe White",
      brand: "Jacquin's",
      upc: JACQUIN_UPC,
      image_url: ""
    });
    const entityId = Number(spirit.id);

    upsertProductImage({
      entityType: "spirits",
      entityId,
      url: JACQUIN_FWGS,
      sourceType: "approved",
      sourceUrl: JACQUIN_PDP,
      width: 1200,
      height: 1200,
      mimeType: "image/jpeg",
      score: 75,
      verified: true,
      rejectionReason: null
    });

    assert.equal(productImageNeedsLocalization("spirits", entityId), true);
    assert.equal(hasDurableAcceptedProductImage("spirits", entityId), false);
    assert.equal(
      shouldScheduleImageEnrichment({
        entityType: "spirits",
        entityId,
        row: spirit
      }),
      true
    );

    enqueueImageJob({ entityType: "spirits", entityId, upc: JACQUIN_UPC });
    const job = claimNextPendingJob()!;

    const result = await runImageJob(job, {
      fetchFwgsImageViaFigranium: async (imageUrl, plcbItem) => {
        figraniumCalls += 1;
        assert.equal(plcbItem, JACQUIN_PLCB);
        assert.equal(imageUrl, JACQUIN_FWGS);
        return {
          ok: true,
          image: {
            plcbItem,
            sourceUrl: imageUrl,
            contentType: "image/png",
            bytes: png,
            width: 1200,
            height: 1200
          }
        };
      },
      extractFwgsPlcbImages: async () => {
        throw new Error("FWGS rediscovery must not run during successful repair");
      },
      searchImageHits: async () => {
        throw new Error("generic search must not run during FWGS repair");
      },
      searchWebHits: async () => {
        throw new Error("web search must not run during FWGS repair");
      },
      fetchPageHtml: async () => null
    });

    assert.ok(
      figraniumCalls >= 1,
      "repair requires government PLCB + Figranium fetch"
    );

    assert.notEqual(result.reason, "already_complete");
    assert.equal(result.imageSaved, true);
    assert.equal(result.reason, "localized_existing");
    assert.equal(figraniumCalls, 1);

    const stored = getProductImage("spirits", entityId)!;
    assert.ok(isLocalImagePath(stored.url));
    assert.equal(stored.url, expectedLocalPath(png));
    assert.equal(stored.source_type, "approved");
    assert.equal(stored.source_url, JACQUIN_PDP);
    assert.equal(stored.score, 75);
    assert.equal(stored.verified, true);

    const inventory = db.prepare("SELECT image_url FROM spirits WHERE id=?").get(entityId) as {
      image_url: string;
    };
    assert.equal(inventory.image_url, "");
  } finally {
    cleanupSpirits(JACQUIN_UPC);
    resetGovernmentDbConnection();
    if (previousGovDbPath === undefined) delete process.env.GOVERNMENT_CATALOG_DB_PATH;
    else process.env.GOVERNMENT_CATALOG_DB_PATH = previousGovDbPath;
    for (const file of [govDbPath, `${govDbPath}-wal`, `${govDbPath}-shm`, workbook]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }
});

test("B. accepted FWGS remote without trusted PLCB does not use generic localizeImage", async () => {
  // No government catalog → no trusted PLCB. Repair must refuse FWGS generic localize.
  cleanupSpirits(JACQUIN_UPC);
  const previousGovDbPath = process.env.GOVERNMENT_CATALOG_DB_PATH;
  delete process.env.GOVERNMENT_CATALOG_DB_PATH;
  resetGovernmentDbConnection();

  const spirit = insertSpirit({
    name: "Jacquin's Creme de Menthe White",
    brand: "Jacquin's",
    upc: JACQUIN_UPC,
    image_url: ""
  });
  const entityId = Number(spirit.id);
  upsertProductImage({
    entityType: "spirits",
    entityId,
    url: JACQUIN_FWGS,
    sourceType: "approved",
    sourceUrl: JACQUIN_PDP,
    width: 1200,
    height: 1200,
    mimeType: "image/jpeg",
    score: 75,
    verified: true,
    rejectionReason: null
  });

  enqueueImageJob({ entityType: "spirits", entityId, upc: JACQUIN_UPC });
  const job = claimNextPendingJob()!;

  let localizeCalls = 0;
  let figraniumCalls = 0;

  try {
    const result = await runImageJob(job, {
      localizeImage: async () => {
        localizeCalls += 1;
        return "/api/media/images/should-not-localize-fwgs.jpg";
      },
      fetchFwgsImageViaFigranium: async () => {
        figraniumCalls += 1;
        return { ok: false, reason: "not_configured" };
      },
      extractFwgsPlcbImages: async () => null,
      searchImageHits: async () => [],
      searchWebHits: async () => [],
      fetchPageHtml: async () => null
    });

    assert.equal(localizeCalls, 0, "FWGS URL must never use generic localizeImage");
    assert.equal(figraniumCalls, 0, "Figranium requires trusted PLCB binding");
    assert.notEqual(result.reason, "localized_existing");
    const stored = getProductImage("spirits", entityId);
    if (stored?.url && isLocalImagePath(stored.url)) {
      assert.fail("FWGS without trusted PLCB must not create a local accepted image via repair");
    }
  } finally {
    cleanupSpirits(JACQUIN_UPC);
    resetGovernmentDbConnection();
    if (previousGovDbPath === undefined) delete process.env.GOVERNMENT_CATALOG_DB_PATH;
    else process.env.GOVERNMENT_CATALOG_DB_PATH = previousGovDbPath;
  }
});

test("C. accepted FWGS remote with mismatched PLCB skips Figranium and generic localize", async () => {
  const govDbPath = path.join(
    os.tmpdir(),
    `jacquin-mismatch-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
  const workbook = `${govDbPath}.xlsx`;
  const previousGovDbPath = process.env.GOVERNMENT_CATALOG_DB_PATH;
  process.env.GOVERNMENT_CATALOG_DB_PATH = govDbPath;
  resetGovernmentDbConnection();
  cleanupSpirits(JACQUIN_UPC);

  // FWGS URL bound to Captain Morgan PLCB — will not validate against Jacquin PLCB.
  const mismatchedFwgsUrl = CAPTAIN_FWGS;

  try {
    await writeJacquinWorkbook(workbook);
    await importPaSpiritsWorkbook(workbook, { dbPath: govDbPath });

    const spirit = insertSpirit({
      name: "Jacquin's Creme de Menthe White",
      brand: "Jacquin's",
      upc: JACQUIN_UPC,
      image_url: ""
    });
    const entityId = Number(spirit.id);
    upsertProductImage({
      entityType: "spirits",
      entityId,
      url: mismatchedFwgsUrl,
      sourceType: "approved",
      sourceUrl: JACQUIN_PDP,
      width: 1200,
      height: 1200,
      mimeType: "image/jpeg",
      score: 75,
      verified: true,
      rejectionReason: null
    });

    enqueueImageJob({ entityType: "spirits", entityId, upc: JACQUIN_UPC });
    const job = claimNextPendingJob()!;

    let localizeCalls = 0;
    let figraniumCalls = 0;

    const result = await runImageJob(job, {
      localizeImage: async () => {
        localizeCalls += 1;
        return "/api/media/images/should-not-localize-mismatched-fwgs.jpg";
      },
      fetchFwgsImageViaFigranium: async () => {
        figraniumCalls += 1;
        return {
          ok: true,
          image: {
            plcbItem: CAPTAIN_PLCB,
            sourceUrl: mismatchedFwgsUrl,
            contentType: "image/png",
            bytes: makePng(8, 8, 1),
            width: 8,
            height: 8
          }
        };
      },
      extractFwgsPlcbImages: async () => null,
      searchImageHits: async () => [],
      searchWebHits: async () => [],
      fetchPageHtml: async () => null
    });

    assert.equal(localizeCalls, 0, "mismatched FWGS URL must not use generic localizeImage");
    assert.equal(figraniumCalls, 0, "mismatched PLCB must not call Figranium");
    assert.notEqual(result.reason, "localized_existing");
    const stored = getProductImage("spirits", entityId);
    if (stored?.url && isLocalImagePath(stored.url)) {
      assert.fail("mismatched FWGS URL must not create a local accepted image");
    }
    // Remote accepted row may remain or be cleared by rediscovery — either is fine.
    if (stored?.url) {
      assert.equal(isLocalImagePath(stored.url), false);
    }
  } finally {
    cleanupSpirits(JACQUIN_UPC);
    resetGovernmentDbConnection();
    if (previousGovDbPath === undefined) delete process.env.GOVERNMENT_CATALOG_DB_PATH;
    else process.env.GOVERNMENT_CATALOG_DB_PATH = previousGovDbPath;
    for (const file of [govDbPath, `${govDbPath}-wal`, `${govDbPath}-shm`, workbook]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }
});

test("D. existing accepted non-FWGS remote image still uses safe localizeImage", async () => {
  cleanupSpirits("080686299011");
  const spirit = insertSpirit({
    name: "PersistTest NonFwgsRepair",
    brand: "Buffalo Trace",
    upc: "080686299011",
    image_url: ""
  });
  const entityId = Number(spirit.id);
  const remote = "https://cdn.buffalotrace.com/products/buffalo-trace-repair.jpg";
  const local = "/api/media/images/non-fwgs-repaired.png";

  upsertProductImage({
    entityType: "spirits",
    entityId,
    url: remote,
    sourceType: "official",
    sourceUrl: "https://www.buffalotrace.com/products/buffalo-trace",
    width: 1400,
    height: 1400,
    mimeType: "image/jpeg",
    score: 80,
    verified: true,
    rejectionReason: null
  });

  enqueueImageJob({ entityType: "spirits", entityId, upc: "080686299011" });
  const job = claimNextPendingJob()!;

  let localizeCalls = 0;
  let figraniumCalls = 0;

  const result = await runImageJob(job, {
    localizeImage: async (url) => {
      localizeCalls += 1;
      assert.equal(url, remote);
      return local;
    },
    fetchFwgsImageViaFigranium: async () => {
      figraniumCalls += 1;
      throw new Error("Figranium must not run for non-FWGS repair");
    },
    searchImageHits: async () => {
      throw new Error("rediscovery must not run after successful non-FWGS repair");
    }
  });

  assert.equal(result.imageSaved, true);
  assert.equal(result.reason, "localized_existing");
  assert.equal(localizeCalls, 1);
  assert.equal(figraniumCalls, 0);
  assert.equal(getProductImage("spirits", entityId)?.url, local);
  assert.equal(
    (db.prepare("SELECT image_url FROM spirits WHERE id=?").get(entityId) as { image_url: string })
      .image_url,
    ""
  );
  cleanupSpirits("080686299011");
});

test("G. existing local accepted image is already_complete", async () => {
  cleanupSpirits("084380299002");
  const spirit = insertSpirit({ name: "PersistTest LocalDone", upc: "084380299002" });
  const entityId = Number(spirit.id);
  upsertProductImage({
    entityType: "spirits",
    entityId,
    url: "/api/media/images/already-local.jpg",
    sourceType: "approved",
    sourceUrl: "https://www.example.com/product",
    score: 80,
    verified: true,
    rejectionReason: null
  });
  assert.equal(hasDurableAcceptedProductImage("spirits", entityId), true);
  enqueueImageJob({ entityType: "spirits", entityId, upc: "084380299002" });
  const job = claimNextPendingJob()!;
  const result = await runImageJob(job, {
    searchImageHits: async () => {
      throw new Error("should not search");
    }
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "already_complete");
  assert.equal(getProductImage("spirits", entityId)?.url, "/api/media/images/already-local.jpg");
  cleanupSpirits("084380299002");
});

test("H. Figranium provider failure during repair retries (throws)", async () => {
  const govDbPath = path.join(
    os.tmpdir(),
    `jacquin-provider-fail-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
  const workbook = `${govDbPath}.xlsx`;
  const previousGovDbPath = process.env.GOVERNMENT_CATALOG_DB_PATH;
  process.env.GOVERNMENT_CATALOG_DB_PATH = govDbPath;
  resetGovernmentDbConnection();
  cleanupSpirits(JACQUIN_UPC);

  try {
    await writeJacquinWorkbook(workbook);
    await importPaSpiritsWorkbook(workbook, { dbPath: govDbPath });

    const spirit = insertSpirit({
      name: "Jacquin's Creme de Menthe White",
      brand: "Jacquin's",
      upc: JACQUIN_UPC
    });
    const entityId = Number(spirit.id);
    upsertProductImage({
      entityType: "spirits",
      entityId,
      url: JACQUIN_FWGS,
      sourceType: "approved",
      sourceUrl: JACQUIN_PDP,
      score: 75,
      verified: true
    });
    enqueueImageJob({ entityType: "spirits", entityId, upc: JACQUIN_UPC });
    const job = claimNextPendingJob()!;

    await assert.rejects(
      () =>
        runImageJob(job, {
          fetchFwgsImageViaFigranium: async () => {
            throw new FwgsFigraniumProviderError(
              "retryable_error",
              "Figranium temporarily unavailable"
            );
          }
        }),
      /Figranium|provider|unavailable/i
    );

    // Must not wipe the accepted remote row into empty on provider failure.
    assert.equal(getProductImage("spirits", entityId)?.url, JACQUIN_FWGS);
  } finally {
    cleanupSpirits(JACQUIN_UPC);
    resetGovernmentDbConnection();
    if (previousGovDbPath === undefined) delete process.env.GOVERNMENT_CATALOG_DB_PATH;
    else process.env.GOVERNMENT_CATALOG_DB_PATH = previousGovDbPath;
    for (const file of [govDbPath, `${govDbPath}-wal`, `${govDbPath}-shm`, workbook]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }
});

test("I. invalid / mismatched FWGS payload is never saved locally during repair", async () => {
  const govDbPath = path.join(
    os.tmpdir(),
    `jacquin-invalid-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
  const workbook = `${govDbPath}.xlsx`;
  const previousGovDbPath = process.env.GOVERNMENT_CATALOG_DB_PATH;
  process.env.GOVERNMENT_CATALOG_DB_PATH = govDbPath;
  resetGovernmentDbConnection();
  cleanupSpirits(JACQUIN_UPC);

  try {
    await writeJacquinWorkbook(workbook);
    await importPaSpiritsWorkbook(workbook, { dbPath: govDbPath });

    const spirit = insertSpirit({
      name: "Jacquin's Creme de Menthe White",
      brand: "Jacquin's",
      upc: JACQUIN_UPC
    });
    const entityId = Number(spirit.id);
    upsertProductImage({
      entityType: "spirits",
      entityId,
      url: JACQUIN_FWGS,
      sourceType: "approved",
      sourceUrl: JACQUIN_PDP,
      score: 75,
      verified: true
    });
    enqueueImageJob({ entityType: "spirits", entityId, upc: JACQUIN_UPC });
    const job = claimNextPendingJob()!;

    // Soft invalid payload → fall through to discovery which finds nothing.
    const result = await runImageJob(job, {
      fetchFwgsImageViaFigranium: async () => ({ ok: false, reason: "plcb_mismatch" }),
      extractFwgsPlcbImages: async () => null,
      searchImageHits: async () => [],
      searchWebHits: async () => [],
      fetchPageHtml: async () => null
    });

    // Soft miss on repair then no rediscovery result — may mark empty or leave remote.
    // Must never create a local accepted path from invalid payload.
    const stored = getProductImage("spirits", entityId);
    if (stored?.url && isLocalImagePath(stored.url)) {
      assert.fail("invalid FWGS payload must never create a local accepted image");
    }
    assert.equal(result.imageSaved, false);
  } finally {
    cleanupSpirits(JACQUIN_UPC);
    resetGovernmentDbConnection();
    if (previousGovDbPath === undefined) delete process.env.GOVERNMENT_CATALOG_DB_PATH;
    else process.env.GOVERNMENT_CATALOG_DB_PATH = previousGovDbPath;
    for (const file of [govDbPath, `${govDbPath}-wal`, `${govDbPath}-shm`, workbook]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }
});

test("J. generic accepted remote image is localized via safe path", async () => {
  cleanupSpirits("080686299010");
  const spirit = insertSpirit({
    name: "PersistTest GenericLocalize",
    brand: "Buffalo Trace",
    upc: "080686299010"
  });
  const entityId = Number(spirit.id);
  enqueueImageJob({ entityType: "spirits", entityId, upc: "080686299010" });
  const job = claimNextPendingJob()!;

  const remote =
    "https://cdn.buffalotrace.com/products/buffalo-trace-persist.jpg";
  const local = "/api/media/images/generic-localized-test.png";
  let localizeCalls = 0;

  const result = await runImageJob(job, {
    searchImageHits: async () => [
      {
        url: remote,
        sourceUrl: "https://www.buffalotrace.com/products/buffalo-trace",
        width: 1500,
        height: 1500,
        mimeType: "image/jpeg"
      }
    ],
    searchWebHits: async () => [],
    probeImageMeta: async () => ({
      width: 1500,
      height: 1500,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async () => cleanVision,
    localizeImage: async (url) => {
      localizeCalls += 1;
      assert.equal(url, remote);
      return local;
    }
  });

  assert.equal(result.imageSaved, true);
  assert.equal(localizeCalls, 1);
  const stored = getProductImage("spirits", entityId)!;
  assert.equal(stored.url, local);
  assert.ok(stored.source_type !== "user");
  const inventory = db.prepare("SELECT image_url FROM spirits WHERE id=?").get(entityId) as {
    image_url: string;
  };
  assert.equal(inventory.image_url, "");
  cleanupSpirits("080686299010");
});

test("L. Captain Morgan accepted enrichment persists locally and user image still wins", async () => {
  const govDbPath = path.join(
    os.tmpdir(),
    `captain-persist-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
  const workbook = `${govDbPath}.xlsx`;
  const previousGovDbPath = process.env.GOVERNMENT_CATALOG_DB_PATH;
  const originalFetch = globalThis.fetch;
  process.env.GOVERNMENT_CATALOG_DB_PATH = govDbPath;
  resetGovernmentDbConnection();
  cleanupSpirits(CAPTAIN_UPC);

  const png = makePng(32, 32, 3);

  try {
    await writeCaptainWorkbook(workbook);
    await importPaSpiritsWorkbook(workbook, { dbPath: govDbPath });

    const spirit = insertSpirit({
      name: "Captain Morgan Original Spiced Rum",
      brand: "Captain Morgan",
      category: "Rum",
      abv: 35,
      volume_ml: 1750,
      upc: CAPTAIN_UPC,
      image_url: ""
    });
    const entityId = Number(spirit.id);
    enqueueImageJob({ entityType: "spirits", entityId, upc: CAPTAIN_UPC });
    const job = claimNextPendingJob()!;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith("https://www.finewineandgoodspirits.com/")) {
        return new Response("blocked", { status: 403 });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const result = await runImageJob(job, {
      searchImageHits: async () => [],
      searchWebHits: async () => [],
      fetchPageHtml: async () => null,
      extractFwgsPlcbImages: async (plcbItem) => ({
        matched: true,
        plcbItem,
        imageUrls: [CAPTAIN_FWGS],
        primaryImageUrl: CAPTAIN_FWGS,
        extractionSource: "embedded_json"
      }),
      fetchFwgsImageViaFigranium: async (imageUrl, plcbItem) => ({
        ok: true,
        image: {
          plcbItem,
          sourceUrl: imageUrl,
          contentType: "image/png",
          bytes: png,
          width: 1200,
          height: 1200
        }
      }),
      verifyImage: async () => cleanVision
    });

    assert.equal(result.imageSaved, true);
    const stored = getProductImage("spirits", entityId)!;
    assert.ok(isLocalImagePath(stored.url));
    assert.equal(
      resolveInventoryDisplayImageUrl("spirits", entityId, { image_url: "" }),
      stored.url
    );

    // User shelf photo still wins over durable enrichment.
    db.prepare("UPDATE spirits SET image_url=? WHERE id=?")
      .run("/api/media/images/user-captain.jpg", entityId);
    const withUser = db.prepare("SELECT * FROM spirits WHERE id=?").get(entityId) as Record<
      string,
      unknown
    >;
    assert.equal(
      resolveInventoryDisplayImageUrl("spirits", entityId, withUser),
      "/api/media/images/user-captain.jpg"
    );
  } finally {
    globalThis.fetch = originalFetch;
    cleanupSpirits(CAPTAIN_UPC);
    resetGovernmentDbConnection();
    if (previousGovDbPath === undefined) delete process.env.GOVERNMENT_CATALOG_DB_PATH;
    else process.env.GOVERNMENT_CATALOG_DB_PATH = previousGovDbPath;
    for (const file of [govDbPath, `${govDbPath}-wal`, `${govDbPath}-shm`, workbook]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }
});

test("saveImageBuffer content-addressed path is used for accepted bytes", () => {
  const png = makePng(16, 16, 99);
  const url = saveImageBuffer(png, "image/png");
  assert.equal(url, expectedLocalPath(png));
  assert.ok(fs.existsSync(path.join(imagesDir, path.basename(url))));
});
