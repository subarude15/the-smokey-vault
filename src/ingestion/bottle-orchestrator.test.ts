import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSchema } from "../cola_client.js";
import type { LookupResult } from "../lookup-shared.js";
import {
  assembleVisionLabelResult,
  identifyByBarcode,
  identifyByBarcodeWithCandidate,
  identifyByLocalLabelImage,
  identifyWithSmartFallback
} from "./bottle-orchestrator.js";
import { CONFIDENCE } from "./candidate/index.js";

const sampleProduct: ProductSchema = {
  upc: "082184090452",
  name: "Nugget Nectar",
  brand: "Troegs",
  category: "Imperial Amber Ale",
  abv: 7.5,
  image_url: null,
  fill_level_percent: 100,
  bottle_count: 1,
  notes: null,
  volume_ml: 355,
  product_type: "beer",
  ttb_id: null,
  origin: null,
  approval_date: null
};

test("identifyByBarcode forwards code and options to the barcode lookup", async () => {
  const calls: Array<{ code: string; options: unknown }> = [];
  const result = await identifyByBarcode(
    "080686000891",
    { kind: "spirits", mode: "live", forceRefresh: true },
    {
      lookupByBarcode: async (code, options) => {
        calls.push({ code, options });
        return {
          source: "vault",
          upc: code,
          table: "spirits",
          kind: "spirits",
          product: { name: "Eagle Rare", upc: code }
        } satisfies LookupResult;
      }
    }
  );
  assert.deepEqual(calls, [{
    code: "080686000891",
    options: { kind: "spirits", mode: "live", forceRefresh: true }
  }]);
  assert.equal(result.source, "vault");
  assert.equal(result.upc, "080686000891");
});

test("identifyByBarcodeWithCandidate keeps LookupResult and attaches provenance", async () => {
  const { result, candidate } = await identifyByBarcodeWithCandidate(
    "080686000891",
    { kind: "spirits" },
    {
      lookupByBarcode: async (code) => ({
        source: "fwgs",
        upc: code,
        table: "spirits",
        kind: "spirits",
        product: { name: "Eagle Rare", brand: "Buffalo Trace", upc: code, abv: 45 }
      })
    }
  );
  assert.equal(result.source, "fwgs");
  assert.equal(result.product?.name, "Eagle Rare");
  assert.equal(candidate.primarySource, "fwgs");
  assert.equal(candidate.name.value, "Eagle Rare");
  assert.equal(candidate.name.confidence, CONFIDENCE.HIGH);
  assert.equal(candidate.brand.value, "Buffalo Trace");
});

test("identifyByLocalLabelImage asks Catalog.beer only for beer product_type", async () => {
  let suggestionQuery = "";
  const beer = await identifyByLocalLabelImage("base64-beer", {
    labelWithLocalOllama: async () => sampleProduct,
    catalogBeerSuggestions: async (query) => {
      suggestionQuery = query;
      return [{
        source: "catalog_beer",
        table: "packaged_beer",
        catalog_beer_id: "cb-1",
        product: { name: "Nugget Nectar" }
      }];
    }
  });
  assert.equal(beer.source, "label");
  assert.equal(beer.upc, "082184090452");
  assert.equal(beer.suggestions.length, 1);
  assert.equal(suggestionQuery, "Troegs Nugget Nectar");

  let called = false;
  const spirit = await identifyByLocalLabelImage("base64-spirit", {
    labelWithLocalOllama: async () => ({
      ...sampleProduct,
      product_type: "spirit",
      name: "Eagle Rare",
      brand: "Buffalo Trace",
      category: "Bourbon"
    }),
    catalogBeerSuggestions: async () => {
      called = true;
      return [];
    }
  });
  assert.equal(spirit.suggestions.length, 0);
  assert.equal(called, false);
});

test("assembleVisionLabelResult mirrors local-label response shape", async () => {
  const result = await assembleVisionLabelResult(
    {
      name: "Village Rouge",
      brand: "Cellar",
      category: "Wine",
      abv: 13,
      volume_ml: 750,
      upc: "012345678905",
      product_type: "wine"
    },
    "/api/media/images/wine.jpg",
    {
      catalogBeerSuggestions: async () => {
        throw new Error("wine labels must not hit Catalog.beer");
      }
    }
  );
  assert.equal(result.source, "label");
  assert.equal(result.upc, "012345678905");
  assert.equal((result.product as { image_url: string }).image_url, "/api/media/images/wine.jpg");
  assert.equal(result.suggestions.length, 0);
});

test("identifyWithSmartFallback preserves catalog-before-web order via deps", async () => {
  const order: string[] = [];
  const product = await identifyWithSmartFallback(
    { upc: "082184090452" },
    {
      lookupByUpc: async () => {
        order.push("upc");
        return {
          source: "fwgs",
          upc: "082184090452",
          product: {
            upc: "082184090452",
            name: "Nugget Nectar",
            brand: "Troegs",
            category: "Beer",
            abv: 7.5,
            fill_level: 100,
            stock_count: 1,
            volume_ml: 355
          }
        };
      },
      searchWeb: async () => {
        order.push("web");
        throw new Error("should not search the web");
      },
      extractFromText: async () => {
        order.push("llm");
        throw new Error("should not call Ollama");
      }
    }
  );
  assert.deepEqual(order, ["upc"]);
  assert.equal(product?.name, "Nugget Nectar");
  assert.equal(product?.upc, "082184090452");
});

test("identifyWithSmartFallback reaches SearXNG then LLM when catalogs miss", async () => {
  const order: string[] = [];
  let searched = "";
  const product = await identifyWithSmartFallback(
    { upc: "099988877766", name: "Local Lager" },
    {
      lookupByUpc: async () => {
        order.push("upc");
        return {
          source: "not_found",
          upc: "099988877766",
          product: { name: "" },
          reason: "no_catalog"
        };
      },
      searchByName: async () => {
        order.push("name");
        return { results: [] };
      },
      searchWeb: async (query) => {
        order.push("web");
        searched = query;
        return "1. Local Lager — Neighborhood Brewing 5.2% ABV lager";
      },
      extractFromText: async (raw) => {
        order.push("llm");
        return {
          ...sampleProduct,
          upc: "",
          name: "Local Lager",
          brand: "Neighborhood Brewing",
          category: "Lager",
          abv: 5.2,
          notes: raw,
          product_type: "beer"
        };
      }
    }
  );
  assert.deepEqual(order, ["upc", "name", "web", "llm"]);
  assert.match(searched, /Local Lager 099988877766 beer abv style description/);
  assert.equal(product?.name, "Local Lager");
  assert.equal(product?.brand, "Neighborhood Brewing");
  assert.equal(product?.upc, "099988877766");
});
