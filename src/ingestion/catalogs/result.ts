import {
  ean13Form,
  getLastQuota,
  productToInventoryFields,
  upcAForm,
  type ProductSchema
} from "../../cola_client.js";
import { localizeImage } from "../../images.js";
import {
  missMessage,
  type ImportKind,
  type LookupResult,
  type LookupSource,
  type MissReason
} from "../../lookup-shared.js";
import { inferImportKind, tableForKind } from "./kind.js";

export async function withLocalImage(product: ProductSchema): Promise<ProductSchema> {
  const local = await localizeImage(product.image_url);
  if (!local || local === product.image_url) return product;
  return { ...product, image_url: local };
}

export function variantsFor(upc: string): LookupResult["variants"] {
  const upcA = upcAForm(upc);
  const ean13 = ean13Form(upc);
  if (!upcA && !ean13) return undefined;
  return { upcA: upcA || upc, ean13: ean13 || upc };
}

export function placeholderProduct(upc: string) {
  return {
    upc,
    name: "",
    brand: "",
    category: "Spirits",
    abv: null,
    image_url: "",
    notes: "",
    fill_level: 100,
    stock_count: 1,
    volume_ml: 750
  };
}

export async function success(
  source: LookupSource,
  upc: string,
  product: ProductSchema,
  kindHint?: ImportKind
): Promise<LookupResult> {
  const localized = await withLocalImage(product);
  const kind = inferImportKind(localized, kindHint);
  return {
    source,
    upc,
    table: tableForKind(kind),
    kind,
    product: productToInventoryFields(localized),
    quota: getLastQuota() ?? undefined,
    variants: variantsFor(upc)
  };
}

export function miss(
  reason: MissReason,
  upc: string,
  kind?: ImportKind,
  extra?: { raw?: string }
): LookupResult {
  const display = upc || extra?.raw || "";
  return {
    source: "not_found",
    upc: display,
    table: kind ? tableForKind(kind) : undefined,
    kind,
    product: placeholderProduct(display),
    reason,
    message: missMessage(reason, display, variantsFor(display)),
    quota: getLastQuota() ?? undefined,
    variants: variantsFor(display)
  };
}

export function rawDigitLength(raw: string) {
  return String(raw ?? "").replace(/\D/g, "").length;
}

export function formatAmbiguous(raw: string) {
  const length = rawDigitLength(raw);
  return length === 6 || length === 7 || length === 8 || (length >= 9 && length <= 11);
}
