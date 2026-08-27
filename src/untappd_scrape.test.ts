import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseUntappdBeerHtml } from "./untappd_scrape.js";

const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/untappd-beer.html"), "utf8");

test("parseUntappdBeerHtml reads og tags and abv", () => {
  const hit = parseUntappdBeerHtml(fixture, "https://untappd.com/b/troegs-perpetual-ipa/46159");
  assert.ok(hit);
  assert.equal(hit?.name, "Perpetual IPA");
  assert.match(hit?.brewery ?? "", /Tröegs/i);
  assert.equal(hit?.abv, 7.5);
  assert.match(hit?.image_url ?? "", /untappd\.com/);
  assert.equal(hit?.untappd_bid, "46159");
});
