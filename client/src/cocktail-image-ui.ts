/**
 * Pure UI helpers for cocktail recipe imagery (PR129).
 * Keep eligibility logic out of App.tsx so tests can assert without mounting React.
 */

export function canFindCocktailPhoto(admin: boolean, imageUrl?: string | null): boolean {
  return Boolean(admin) && !String(imageUrl ?? "").trim();
}

/**
 * Bounded Keeper-facing reason for a failed discovery (PR154). Distinguishes the
 * discovery stage so a Keeper understands why no photo was saved. Never exposes
 * HTML, URLs, headers, or internal payloads.
 */
function noResultMessage(reason?: string): string {
  switch (reason) {
    case "search_miss":
      return "No matching cocktail pages were found.";
    case "identity_rejected":
      return "Found possible recipes, but none matched this cocktail closely enough.";
    case "no_page_image":
      return "Matched a recipe, but it did not expose a usable photo.";
    case "localize_failed":
      return "Found a photo, but it could not be saved locally.";
    case "search_failed":
      return "Photo search is unavailable right now.";
    default:
      return "No trustworthy photo found";
  }
}

export function cocktailImageDiscoveryMessage(
  status: "updated" | "no_result" | "already_has_image" | "error" | "",
  reason?: string
): string {
  switch (status) {
    case "updated":
      return "Photo added";
    case "no_result":
      return noResultMessage(reason);
    case "already_has_image":
      return "This recipe already has a photo";
    case "error":
      return "Could not search for a photo";
    case "":
      return "";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Bounded Keeper-only diagnostic snapshot from Find Photo (PR155). */
export type CocktailImageDiscoveryDiagnosticsView = {
  cocktail_name?: string;
  queries_tried?: number;
  query_labels?: string[];
  raw_results?: number;
  candidates_after_dedupe?: number;
  candidates_after_host_filter?: number;
  pages_fetched?: number;
  identity_matches?: number;
  identity_rejects?: number;
  pages_with_image?: number;
  image_host_rejects?: number;
  localize_attempts?: number;
  localize_failures?: number;
  stage?: string;
  note?: string;
};

/**
 * Build Keeper-only "Photo search details" lines from bounded diagnostics.
 * Returns an empty list when diagnostics are absent — Guests never receive them.
 */
export function cocktailImageDiscoveryDiagnosticLines(
  diagnostics?: CocktailImageDiscoveryDiagnosticsView | null
): string[] {
  if (!diagnostics) return [];
  const lines: string[] = [];
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const queries = n(diagnostics.queries_tried);
  if (queries != null) lines.push(`Queries tried: ${queries}`);
  const raw = n(diagnostics.raw_results);
  if (raw != null) lines.push(`Search results returned: ${raw}`);
  const candidates = n(diagnostics.candidates_after_dedupe) ?? n(diagnostics.candidates_after_host_filter);
  if (candidates != null) lines.push(`Candidate pages checked: ${candidates}`);
  const matches = n(diagnostics.identity_matches);
  if (matches != null) lines.push(`Identity matches: ${matches}`);
  const withImage = n(diagnostics.pages_with_image);
  if (withImage != null) lines.push(`Pages with usable image: ${withImage}`);
  const localizeFails = n(diagnostics.localize_failures);
  if (localizeFails != null && localizeFails > 0) {
    lines.push(`Localization failures: ${localizeFails}`);
  }
  if (diagnostics.note && String(diagnostics.note).trim()) {
    lines.push(String(diagnostics.note).trim());
  }
  if (diagnostics.stage) {
    const labels: Record<string, string> = {
      search_miss: "Photo could not be found — no usable recipe pages",
      search_failed: "Photo search is unavailable",
      identity_rejected: "Pages were found, but none matched this cocktail",
      no_page_image: "A matching recipe was found, but no usable photo was exposed",
      localize_failed: "Photo could not be saved locally",
      updated: "Photo saved",
      already_has_image: "Recipe already has a photo"
    };
    const stage = String(diagnostics.stage);
    lines.push(`Result: ${labels[stage] ?? stage.replace(/_/g, " ")}`);
  }
  return lines.slice(0, 12);
}
