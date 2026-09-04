/**
 * Integration regression: an image job rebuilt from inventory regains trusted PLCB
 * provenance from the government catalog and can use the narrow FWGS Figranium path.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
    const result = await runImageJob(job!, {
      searchImageHits: async () => [],
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
        return {
          ok: true,
          image: {
            plcbItem,
            sourceUrl: imageUrl,
            contentType: "image/png",
            bytes: Buffer.from("captain-morgan-product-image"),
            width: 1200,
            height: 1200
          }
        };
      },
      verifyImage: async (request) => {
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
    assert.equal(result.execution?.selected?.url, FWGS_IMAGE_1200);
    assert.equal(getProductImage("spirits", entityId)?.url, FWGS_IMAGE_1200);
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
