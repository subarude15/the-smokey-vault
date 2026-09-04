/**
 * Integration regression: an image job rebuilt from inventory regains trusted PLCB
 * provenance from the government catalog and can use the narrow FWGS Figranium path.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { db } from "../../db.js";
import { writeExcelMatrix } from "../catalogs/government/excel-matrix.js";
import { PA_EXPECTED_HEADERS } from "../catalogs/government/pa-columns.js";
import { importPaSpiritsWorkbook } from "../catalogs/government/pa-import.js";
import { resetGovernmentDbConnection } from "../catalogs/government/schema.js";
import {
  claimNextPendingJob,
  clearEnrichmentJobsForTests,
  clearProductImagesForTests,
  enqueueImageJob,
  getProductImage,
  runImageJob
} from "./index.js";

const CAPTAIN_UPC = "087000201156";
const CAPTAIN_ITEM = "000004766";
const FWGS_IMAGE =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg&height=475&width=475";
const FWGS_IMAGE_1200 =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg&height=1200&width=1200";

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

function makePng(width: number, height: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 0);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

async function writeCaptainMorganWorkbook(filePath: string): Promise<void> {
  const row: Record<string, unknown> & { upcs: string[] } = {
    "Division Name": "Stock Spirits",
    "Group Name": "Rum",
    "Class Name": "Spiced Rum",
    "PLCB Item": CAPTAIN_ITEM,
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

test("Captain Morgan image job bridges government PLCB provenance into FWGS Figranium", async () => {
  const govDbPath = path.join(
    os.tmpdir(),
    `captain-image-job-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
  const workbook = `${govDbPath}.xlsx`;
  const previousGovDbPath = process.env.GOVERNMENT_CATALOG_DB_PATH;
  const originalFetch = globalThis.fetch;
  process.env.GOVERNMENT_CATALOG_DB_PATH = govDbPath;
  resetGovernmentDbConnection();
  clearEnrichmentJobsForTests();
  clearProductImagesForTests();
  db.prepare("DELETE FROM spirits WHERE upc=?").run(CAPTAIN_UPC);

  try {
    await writeCaptainMorganWorkbook(workbook);
    await importPaSpiritsWorkbook(workbook, { dbPath: govDbPath });

    const inserted = db.prepare(`
      INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, image_url)
      VALUES (?, ?, ?, ?, ?, ?, '')
    `).run(
      "Captain Morgan Original Spiced Rum",
      "Captain Morgan",
      "Rum",
      35,
      1750,
      CAPTAIN_UPC
    );
    const entityId = Number(inserted.lastInsertRowid);
    enqueueImageJob({ entityType: "spirits", entityId, upc: CAPTAIN_UPC });
    const job = claimNextPendingJob();
    assert.ok(job);

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith("https://www.finewineandgoodspirits.com/")) {
        return new Response("blocked", { status: 403 });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    let visionReceivedRecoveredBytes = false;
    let imageSearchCalls = 0;
    let visionCalls = 0;
    const result = await runImageJob(job!, {
      searchImageHits: async () => {
        imageSearchCalls += 1;
        return [
          { url: "https://thumbs.dreamstime.com/junk.jpg" },
          { url: "https://www.totalwine.com/media/captain.jpg" }
        ];
      },
      searchWebHits: async () => [],
      fetchPageHtml: async () => null,
      extractFwgsPlcbImages: async (plcbItem) => {
        assert.equal(plcbItem, CAPTAIN_ITEM);
        return {
          matched: true,
          plcbItem,
          imageUrls: [FWGS_IMAGE],
          primaryImageUrl: FWGS_IMAGE,
          extractionSource: "embedded_json"
        };
      },
      fetchFwgsImageViaFigranium: async (imageUrl, plcbItem) => {
        assert.equal(plcbItem, CAPTAIN_ITEM);
        assert.equal(imageUrl, FWGS_IMAGE_1200);
        const bytes = makePng(64, 64);
        return {
          ok: true,
          image: {
            plcbItem,
            sourceUrl: imageUrl,
            contentType: "image/png",
            bytes,
            width: 1200,
            height: 1200
          }
        };
      },
      verifyImage: async (request) => {
        visionCalls += 1;
        visionReceivedRecoveredBytes = Boolean(request.imageBase64);
        return {
          correct_product: true,
          bottle_prominent: true,
          contains_people: false,
          meme_or_graphic: false,
          clean_product_photo: true,
          multiple_products: false
        };
      }
    });

    assert.equal(result.imageSaved, true);
    assert.equal(result.inventoryImageUrl, null);
    assert.equal(visionReceivedRecoveredBytes, true);
    assert.equal(imageSearchCalls, 0, "generic SearXNG must not run after FWGS accept");
    assert.ok(visionCalls <= 3);
    assert.equal(visionCalls, 1);
    assert.equal(result.execution?.selected?.url, FWGS_IMAGE_1200);
    assert.ok(
      result.execution?.diagnostics.stages.some(
        (s) => s.stage === "generic_image_search_skipped" && s.reason === "generic_search_not_needed"
      )
    );
    const stored = getProductImage("spirits", entityId);
    assert.ok(stored?.url?.startsWith("/api/media/images/"));
    assert.notEqual(stored?.url, FWGS_IMAGE_1200);
    assert.ok(stored?.source_type !== "user");
    assert.equal(stored?.verified, true);
    const inventory = db.prepare("SELECT image_url FROM spirits WHERE id=?").get(entityId) as {
      image_url: string;
    };
    assert.equal(inventory.image_url, "");
  } finally {
    globalThis.fetch = originalFetch;
    clearEnrichmentJobsForTests();
    clearProductImagesForTests();
    db.prepare("DELETE FROM spirits WHERE upc=?").run(CAPTAIN_UPC);
    resetGovernmentDbConnection();
    if (previousGovDbPath === undefined) delete process.env.GOVERNMENT_CATALOG_DB_PATH;
    else process.env.GOVERNMENT_CATALOG_DB_PATH = previousGovDbPath;
    for (const file of [govDbPath, `${govDbPath}-wal`, `${govDbPath}-shm`, workbook]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore already-removed SQLite sidecars and temporary workbook files.
      }
    }
  }
});
