import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { db } from "../../db.js";
import { lookupProduct } from "../../lookup.js";
import {
  CONFIDENCE,
  SOURCE_CONFIDENCE,
  candidateFromProduct,
  confidenceForSource,
  field,
  fieldSourceFromLookupSource,
  mergeCandidates,
  mergeField
} from "../candidate/index.js";
import {
  iowaCategorySpecificity,
  isGenericIowaCategory,
  preferIowaRow
} from "./iowa-category.js";
import {
  IOWA_REQUIRED_HEADERS,
  deriveAbvFromProof,
  formatIowaImportSummary,
  importIowaCsv,
  normalizeIowaVolumeMl,
  rowFromIowaCsv,
  validateIowaHeaders
} from "./iowa-import.js";
import {
  countIowaProducts,
  replaceIowaProducts,
  resetIowaDbConnection,
  resolveIowaByUpc,
  type IowaProductRow
} from "./iowa-store.js";
import { expandScientificUpc, normalizeIowaUpc } from "./iowa-upc.js";
import { iowaRowToSchema, searchIowaByUpc, tryIowaStage } from "./iowa.js";

async function withTempIowaDb<T>(fn: (dbPath: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iowa-test-"));
  const dbPath = join(dir, "iowa.sqlite");
  const prev = process.env.IOWA_LIQUOR_DB_PATH;
  process.env.IOWA_LIQUOR_DB_PATH = dbPath;
  resetIowaDbConnection();
  try {
    return await fn(dbPath);
  } finally {
    resetIowaDbConnection();
    if (prev == null) delete process.env.IOWA_LIQUOR_DB_PATH;
    else process.env.IOWA_LIQUOR_DB_PATH = prev;
  }
}

function fireballRow(overrides: Partial<IowaProductRow> = {}): IowaProductRow {
  return {
    item_no: "100015",
    category_name: "Whiskey Liqueur",
    name: "Fireball Cinnamon Whiskey Bag in Box",
    vendor_no: "421",
    vendor_name: "SAZERAC COMPANY  INC",
    bottle_volume_ml: 3500,
    age: null,
    proof: 66,
    abv: 33,
    list_on: "2017-10-01",
    report_as_of: "2026-08-01",
    upc: "088004022723",
    raw_upc: "088004022723",
    ...overrides
  };
}

test("required Iowa headers are validated", () => {
  assert.throws(() => validateIowaHeaders(["item_no", "upc"]), /missing required headers/i);
  validateIowaHeaders([...IOWA_REQUIRED_HEADERS]);
});

test("plain UPC string preserves leading zero", () => {
  const result = normalizeIowaUpc("088004022723");
  assert.equal(result.valid, true);
  assert.equal(result.upc, "088004022723");
  assert.equal(result.precisionLost, false);
  assert.equal(result.rawUpc, "088004022723");
});

test("scientific notation UPC normalizes when exact", () => {
  const result = normalizeIowaUpc("8.8004022723e10");
  assert.equal(result.valid, true);
  assert.equal(result.upc, "88004022723");
  assert.equal(result.precisionLost, false);
  const expanded = expandScientificUpc("8.8004022723e10");
  assert.equal(expanded.digits, "88004022723");
  assert.equal(expanded.precisionLost, false);
});

test("precision-lost scientific notation is rejected", () => {
  const result = normalizeIowaUpc("8.35e11");
  assert.equal(result.valid, false);
  assert.equal(result.upc, null);
  assert.equal(result.precisionLost, true);
});

test("raw_upc retained for diagnostics", () => {
  const built = rowFromIowaCsv({
    item_no: "1",
    category_name: "Imported Vodkas",
    im_desc: "Test",
    vendor_no: "1",
    vendor_name: "Vendor",
    bottle_volume_ml: "750",
    pack: "6",
    inner_pack: "1",
    age: "0",
    proof: "80",
    list_on: "2024-01-01",
    upc: "8.35e11",
    scc: "",
    state_bottle_cost: "1",
    state_case_cost: "1",
    state_bottle_retail: "1",
    report_as_of: "2026-08-01"
  });
  assert.equal(built.upcValid, false);
  assert.equal(built.upcPrecisionLost, true);
  assert.equal(built.row.upc, null);
  assert.equal(built.row.raw_upc, "8.35e11");
});

test("proof 66 derives ABV 33", () => {
  assert.deepEqual(deriveAbvFromProof(66), { proof: 66, abv: 33 });
});

test("proof 80 derives ABV 40", () => {
  assert.deepEqual(deriveAbvFromProof(80), { proof: 80, abv: 40 });
});

test("invalid proof rejected", () => {
  assert.deepEqual(deriveAbvFromProof(0), { proof: null, abv: null });
  assert.deepEqual(deriveAbvFromProof(-10), { proof: null, abv: null });
  assert.deepEqual(deriveAbvFromProof(400), { proof: null, abv: null });
  assert.deepEqual(deriveAbvFromProof(""), { proof: null, abv: null });
});

test("volume normalized", () => {
  assert.equal(normalizeIowaVolumeMl("3500"), 3500);
  assert.equal(normalizeIowaVolumeMl(750), 750);
  assert.equal(normalizeIowaVolumeMl(0), null);
  assert.equal(normalizeIowaVolumeMl(-1), null);
});

test("duplicate item_no specialty + vodka prefers useful spirit category", () => {
  const specialty = fireballRow({
    item_no: "100026",
    category_name: "Temporary & Specialty Packages",
    name: "Absolut w/Fever Tree Ginger Beer",
    upc: "835229000308",
    proof: 80,
    abv: 40,
    bottle_volume_ml: 750
  });
  const vodka = { ...specialty, category_name: "Imported Vodkas" };
  assert.ok(
    iowaCategorySpecificity("Imported Vodkas") >
      iowaCategorySpecificity("Temporary & Specialty Packages")
  );
  assert.equal(preferIowaRow([specialty, vodka]).category_name, "Imported Vodkas");
  assert.equal(preferIowaRow([vodka, specialty]).category_name, "Imported Vodkas");
});

test("generic specialty category does not overwrite a specific spirit category", () => {
  assert.equal(isGenericIowaCategory("Temporary & Specialty Packages"), true);
  assert.equal(isGenericIowaCategory("Imported Vodkas"), false);
  assert.equal(isGenericIowaCategory("Whiskey Liqueur"), false);
});

test("Iowa exact UPC lookup works", async () => {
  await withTempIowaDb(async () => {
    replaceIowaProducts([fireballRow()]);
    const product = searchIowaByUpc("088004022723");
    assert.ok(product);
    assert.equal(product!.name, "Fireball Cinnamon Whiskey Bag in Box");
    assert.equal(product!.abv, 33);
    assert.equal(product!.proof, 66);
    assert.equal(product!.volume_ml, 3500);
    const stage = await tryIowaStage({ upc: "088004022723" });
    assert.equal(stage.hit?.source, "iowa");
  });
});

test("unknown UPC returns miss", async () => {
  await withTempIowaDb(async () => {
    replaceIowaProducts([fireballRow()]);
    assert.equal(searchIowaByUpc("000000000000"), null);
    assert.equal((await tryIowaStage({ upc: "000000000000" })).hit, null);
  });
});

test("Iowa uses HIGH provenance", () => {
  assert.equal(confidenceForSource("iowa"), CONFIDENCE.HIGH);
  assert.equal(SOURCE_CONFIDENCE.iowa, CONFIDENCE.HIGH);
  assert.equal(fieldSourceFromLookupSource("iowa"), "iowa");
});

test("Iowa does not overwrite keeper/Vault values", () => {
  const vault = candidateFromProduct(
    {
      upc: "088004022723",
      name: "Keeper Fireball",
      brand: "Keeper Brand",
      category: "Whiskey",
      abv: 35,
      image_url: null,
      fill_level_percent: 100,
      bottle_count: 1,
      notes: null,
      volume_ml: 750,
      product_type: "spirit",
      ttb_id: null,
      origin: null,
      approval_date: null
    },
    "vault"
  );
  const iowa = candidateFromProduct(
    {
      upc: "088004022723",
      name: "Fireball Cinnamon Whiskey Bag in Box",
      brand: "SAZERAC COMPANY  INC",
      category: "Liqueur",
      abv: 33,
      image_url: null,
      fill_level_percent: 100,
      bottle_count: 1,
      notes: null,
      volume_ml: 3500,
      product_type: "spirit",
      ttb_id: null,
      origin: null,
      approval_date: null,
      proof: 66
    },
    "iowa"
  );
  const merged = mergeCandidates(vault, iowa);
  assert.equal(merged.candidate.name.value, "Keeper Fireball");
  assert.equal(merged.candidate.brand.value, "Keeper Brand");
  assert.equal(merged.candidate.abv.value, 35);
  assert.equal(merged.candidate.name.source, "vault");
});

test("Iowa satisfies ABV/proof before web enrichment", async () => {
  await withTempIowaDb(async () => {
    replaceIowaProducts([fireballRow()]);
    const upc = "088004022723";
    db.prepare("DELETE FROM cola_cache WHERE upc=?").run(upc);
    db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(upc);
    const order: string[] = [];
    const result = await lookupProduct(upc, {
      kind: "spirits",
      catalogs: {
        searchIowa: async () => searchIowaByUpc(upc),
        searchFwgs: async () => {
          order.push("fwgs");
          return null;
        },
        searchCola: async () => {
          order.push("cola");
          return null;
        },
        searchOff: async () => {
          order.push("off");
          return null;
        },
        searchUpcItemDb: async () => {
          order.push("upcitemdb");
          return null;
        }
      }
    });
    assert.equal(result.source, "iowa");
    assert.equal(result.product?.abv, 33);
    assert.equal(result.product?.proof, 66);
    assert.deepEqual(order, []);
  });
});

test("vendor name does not blindly overwrite known brand", () => {
  const existing = field("Absolut", "vault");
  const incoming = field("PERNOD RICARD USA", "iowa");
  const merged = mergeField(existing, incoming, "brand");
  assert.equal(merged.field.value, "Absolut");
  assert.equal(merged.field.source, "vault");
  assert.equal(merged.overwritten, false);
});

test("lookup order calls Iowa before FWGS for spirits", async () => {
  const upc = "055566677701";
  db.prepare("DELETE FROM cola_cache WHERE upc=?").run(upc);
  db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(upc);
  const order: string[] = [];
  await lookupProduct(upc, {
    kind: "spirits",
    catalogs: {
      searchIowa: async () => {
        order.push("iowa");
        return null;
      },
      searchFwgs: async () => {
        order.push("fwgs");
        return null;
      },
      searchCola: async () => {
        order.push("cola");
        return null;
      },
      searchOff: async () => {
        order.push("off");
        return null;
      },
      searchUpcItemDb: async () => {
        order.push("upcitemdb");
        return null;
      }
    }
  });
  assert.deepEqual(order, ["iowa", "fwgs", "cola", "off", "upcitemdb"]);
});

test("Iowa import writes sqlite and summary counts", async () => {
  await withTempIowaDb(async (dbPath) => {
    const dir = mkdtempSync(join(tmpdir(), "iowa-csv-"));
    const csvPath = join(dir, "sample.csv");
    writeFileSync(
      csvPath,
      [
        "item_no,category_name,im_desc,vendor_no,vendor_name,bottle_volume_ml,pack,inner_pack,age,proof,list_on,upc,scc,state_bottle_cost,state_case_cost,state_bottle_retail,report_as_of",
        "100015,Whiskey Liqueur,Fireball Cinnamon Whiskey Bag in Box,421,SAZERAC COMPANY  INC,3500,3,1,0,66,2017-10-01,088004022723,10083664874139,30,90,45,2026-08-01",
        "100026,Temporary & Specialty Packages,Absolut w/Fever Tree Ginger Beer,370,PERNOD RICARD USA,750,6,1,0,80,2024-04-01,835229000308,1,8.99,53.94,13.49,2026-08-01",
        "100026,Imported Vodkas,Absolut w/Fever Tree Ginger Beer,370,PERNOD RICARD USA,750,6,1,0,80,2024-04-01,835229000308,1,8.99,53.94,13.49,2026-08-01",
        "999999,Imported Vodkas,Bad Sci UPC,1,Vendor,750,6,1,0,80,2024-04-01,8.35E+11,1,1,1,1,2026-08-01"
      ].join("\n"),
      "utf8"
    );
    const summary = await importIowaCsv(csvPath, { dbPath });
    assert.equal(summary.rowsRead, 4);
    assert.equal(summary.rowsImported, 4);
    assert.equal(summary.validUpcs, 3);
    assert.equal(summary.invalidUpcs, 1);
    assert.equal(summary.duplicateItemNumbers, 1);
    assert.equal(countIowaProducts(dbPath), 4);
    assert.equal(resolveIowaByUpc("835229000308", dbPath)?.category_name, "Imported Vodkas");
    assert.match(formatIowaImportSummary(summary), /Rows read: 4/);
  });
});

test("iowaRowToSchema maps Fireball proof/ABV/volume", () => {
  const schema = iowaRowToSchema("088004022723", fireballRow());
  assert.equal(schema.abv, 33);
  assert.equal(schema.proof, 66);
  assert.equal(schema.volume_ml, 3500);
  assert.equal(schema.name, "Fireball Cinnamon Whiskey Bag in Box");
});
