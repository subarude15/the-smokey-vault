import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateFromProduct } from "../candidate/index.js";
import {
  executeTastingNotesEnrichment,
  extractTastingNotesExcerptFromHtml
} from "./execute-tasting-notes.js";

test("extractTastingNotesExcerptFromHtml strips chrome and centers on tasting notes section", () => {
  const padding = "Introductory distillery story text. ".repeat(120);
  const html = `
    <html>
      <head><style>.hero { color: red; }</style><script>window.x = 1;</script></head>
      <body>
        <header><nav><a href="/shop">Shop</a></nav></header>
        <main>
          <p>${padding}</p>
          <section class="c-tasting">
            <h1>Tasting Notes</h1>
            <p>Rich notes of dark fruit, caramel, sharp honey, chocolate, marzipan and toasted oak.</p>
            <p>A full-bodied mix of vanilla, dark caramel, hazelnut, apple, fruit and spices.</p>
            <p>Long and creamy with lingering hints of honeyed apple.</p>
          </section>
        </main>
        <footer>Copyright Distillery</footer>
      </body>
    </html>
  `;

  const excerpt = extractTastingNotesExcerptFromHtml(html, 800);
  assert.ok(!excerpt.includes("window.x"));
  assert.ok(!excerpt.includes("Copyright Distillery"));
  assert.ok(excerpt.includes("Tasting Notes"));
  assert.ok(excerpt.includes("dark fruit, caramel, sharp honey"));
  assert.ok(excerpt.includes("honeyed apple"));
  assert.ok(excerpt.length <= 800);
});

test("executeTastingNotesEnrichment fetches authoritative official pages (not retailer pages) to enrich snippets", async () => {
  const candidate = candidateFromProduct({
    upc: "081128001209",
    name: "Woodford Reserve Double Oaked Bourbon",
    brand: "Woodford Reserve",
    category: "Bourbon",
    abv: 45.2,
    image_url: null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: null,
    volume_ml: 750,
    product_type: "spirit",
    ttb_id: null,
    origin: "Kentucky",
    approval_date: null
  }, "vault");

  const fetchedUrls: string[] = [];
  let capturedSnippets = "";

  const result = await executeTastingNotesEnrichment(
    candidate,
    {
      searchWebHits: async () => [
        {
          title: "Double Oaked - Woodford Reserve",
          url: "https://www.woodfordreserve.com/whiskey/double-oaked/",
          content: "Deep Amber. Rich notes of dark fruit, caramel,"
        },
        {
          title: "Woodford Reserve Double Oaked Review",
          url: "https://www.totalwine.com/spirits/bourbon/woodford-reserve-double-oaked",
          content: "Retailer tasting notes should never be fetched or used as official."
        }
      ],
      fetchPageHtml: async (url) => {
        fetchedUrls.push(url);
        return `<html><body><h1>Tasting Notes</h1><p>Nose: Rich notes of dark fruit, caramel, sharp honey, chocolate, marzipan and toasted oak.</p><p>Taste: Full-bodied mix of vanilla, dark caramel, hazelnut, apple.</p><p>Finish: Long and creamy with lingering hints of honeyed apple.</p></body></html>`;
      },
      extractOfficial: async (req) => {
        capturedSnippets = req.authoritativeSnippets;
        return {
          official_notes: "Nose: dark fruit, caramel, sharp honey, toasted oak. Palate: vanilla, hazelnut, apple. Finish: long and creamy.",
          source_url: "https://www.woodfordreserve.com/whiskey/double-oaked/",
          confidence: "official"
        };
      }
    },
    { wantOfficial: true, wantHouseProfile: false }
  );

  assert.deepEqual(fetchedUrls, ["https://www.woodfordreserve.com/whiskey/double-oaked/"]);
  assert.ok(capturedSnippets.includes("Page excerpt:"));
  assert.ok(capturedSnippets.includes("lingering hints of honeyed apple"));
  assert.ok(!capturedSnippets.includes("totalwine.com"));
  assert.equal(result.officialSourceType, "official");
  assert.equal(result.officialSourceUrl, "https://www.woodfordreserve.com/whiskey/double-oaked/");
  assert.ok(result.officialNotes?.includes("toasted oak"));
});
