/**
 * Pure UI helpers for cocktail recipe imagery (PR129).
 * Keep eligibility logic out of App.tsx so tests can assert without mounting React.
 */

export function canFindCocktailPhoto(admin: boolean, imageUrl?: string | null): boolean {
  return Boolean(admin) && !String(imageUrl ?? "").trim();
}

export function cocktailImageDiscoveryMessage(
  status: "updated" | "no_result" | "already_has_image" | "error" | ""
): string {
  switch (status) {
    case "updated":
      return "Photo added";
    case "no_result":
      return "No trustworthy photo found";
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
