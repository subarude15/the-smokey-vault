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
