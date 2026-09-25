import assert from "node:assert/strict";
import test from "node:test";
import { db } from "./db.js";
import {
  brewSheetPdfFilename,
  claimBrewSheetTicket,
  issueBrewSheetTicket,
  pdfFilenameFromDisposition,
  redactBrewSheetSecrets,
  setBrewSheetPdfRenderer
} from "./brew_sheet_pdf.js";
import { BREW_SHEET_PDF_ERROR } from "./brew_sheet_pdf_shared.js";

test("brew sheet PDF filenames stay ASCII and header-safe", () => {
  assert.equal(brewSheetPdfFilename("Candy Cloud Hazy DIPA"), "Candy-Cloud-Hazy-DIPA-Brew-Sheet.pdf");
  const unsafe = brewSheetPdfFilename('Candy\r\nCloud: "x"/\\*?<>|');
  assert.equal(unsafe.includes("\r"), false);
  assert.equal(unsafe.includes("\n"), false);
  assert.equal(unsafe.includes('"'), false);
  assert.match(unsafe, /^[A-Za-z0-9.-]+\.pdf$/);
  assert.equal(brewSheetPdfFilename("///"), "Brew-Brew-Sheet.pdf");
  assert.equal(
    pdfFilenameFromDisposition('attachment; filename="Candy-Cloud-Hazy-DIPA-Brew-Sheet.pdf"', "Brew-Brew-Sheet.pdf"),
    "Candy-Cloud-Hazy-DIPA-Brew-Sheet.pdf"
  );
  assert.equal(pdfFilenameFromDisposition('attachment; filename="../../etc/passwd"', "Brew-Brew-Sheet.pdf"), "Brew-Brew-Sheet.pdf");
  assert.equal(pdfFilenameFromDisposition(null, "Brew-Brew-Sheet.pdf"), "Brew-Brew-Sheet.pdf");
});

test("render tokens are loopback-only and do not carry source text", async () => {
  const { app } = await import("./server.js");
  const token = issueBrewSheetTicket({ beerName: "Candy Cloud Hazy DIPA", targetOg: "1.080" });
  const lan = await app.inject({
    method: "GET",
    url: `/api/brew-sheet-render/${token}`,
    remoteAddress: "10.0.0.8"
  });
  assert.equal(lan.statusCode, 404);
  const local = await app.inject({
    method: "GET",
    url: `/api/brew-sheet-render/${token}`,
    remoteAddress: "127.0.0.1"
  });
  assert.equal(local.statusCode, 200);
  const body = local.json() as { recipe: { beerName: string; sourceText?: string } };
  assert.equal(body.recipe.beerName, "Candy Cloud Hazy DIPA");
  assert.equal(body.recipe.sourceText, undefined);
  assert.equal(claimBrewSheetTicket("missing-token"), null);
  const mapped = await app.inject({
    method: "GET",
    url: `/api/brew-sheet-render/${issueBrewSheetTicket({ beerName: "Mapped" })}`,
    remoteAddress: "::ffff:127.0.0.1"
  });
  assert.equal(mapped.statusCode, 200);
});

test("keeper PDF route sends a private attachment and hides renderer failures", async () => {
  const { app, createTestAdminToken } = await import("./server.js");
  const headers = { authorization: `Bearer ${createTestAdminToken()}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/admin/brewery/recipes",
    headers,
    payload: {
      name: "Candy Cloud Hazy DIPA",
      style: "Hazy DIPA",
      sourceText: "do not leak",
      recipe: { beerName: "Candy Cloud Hazy DIPA", style: "Hazy DIPA", targetOg: "1.080" }
    }
  });
  assert.equal(created.statusCode, 201);
  const id = (created.json() as { recipe: { id: number } }).recipe.id;
  let seen: { recipe: { sourceText?: string; beerName?: string }; name: string } | undefined;
  setBrewSheetPdfRenderer(async (input) => {
    seen = input as typeof seen;
    return Buffer.from("%PDF-1.4\n% mock brew sheet");
  });
  try {
    const anonymous = await app.inject({ method: "GET", url: `/api/admin/brewery/recipes/${id}/pdf` });
    assert.equal(anonymous.statusCode, 401);

    const bad = await app.inject({ method: "GET", url: "/api/admin/brewery/recipes/nope/pdf", headers });
    assert.equal(bad.statusCode, 400);
    const missing = await app.inject({ method: "GET", url: "/api/admin/brewery/recipes/999999/pdf", headers });
    assert.equal(missing.statusCode, 404);

    const pdf = await app.inject({ method: "GET", url: `/api/admin/brewery/recipes/${id}/pdf`, headers });
    assert.equal(pdf.statusCode, 200);
    assert.match(pdf.headers["content-type"] ?? "", /application\/pdf/);
    assert.equal(pdf.headers["content-disposition"], 'attachment; filename="Candy-Cloud-Hazy-DIPA-Brew-Sheet.pdf"');
    assert.equal(pdf.headers["cache-control"], "private, no-store");
    assert.equal(pdf.body.startsWith("%PDF"), true);
    assert.equal(seen?.name, "Candy Cloud Hazy DIPA");
    assert.equal(seen?.recipe.beerName, "Candy Cloud Hazy DIPA");
    assert.equal(seen?.recipe.sourceText, undefined);
    assert.equal(pdf.body.includes("do not leak"), false);

    setBrewSheetPdfRenderer(async () => {
      throw new Error("launch /usr/bin/chromium failed Bearer keeper-token token=super-secret\nError: at /usr/bin/chromium");
    });
    const failed = await app.inject({ method: "GET", url: `/api/admin/brewery/recipes/${id}/pdf`, headers });
    assert.equal(failed.statusCode, 503);
    const payload = failed.json() as { error: string };
    assert.equal(payload.error, BREW_SHEET_PDF_ERROR);
    assert.equal(failed.body.includes("/usr/bin/chromium"), false);
    assert.equal(failed.body.includes("keeper-token"), false);
    assert.equal(failed.body.includes("super-secret"), false);
    assert.equal(failed.body.includes("at /usr"), false);
    assert.equal(redactBrewSheetSecrets("token=super-secret Bearer keeper-token").includes("super-secret"), false);
  } finally {
    setBrewSheetPdfRenderer(null);
    db.prepare("DELETE FROM brew_sessions WHERE recipe_id=?").run(id);
    db.prepare("DELETE FROM brew_recipes WHERE id=?").run(id);
  }
});
