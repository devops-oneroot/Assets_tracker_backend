import { extractJsonFromDocument, isoDate, num, str } from "./geminiDoc";

/**
 * Reads a purchase invoice - a PDF, or a photo of one - and pulls out enough
 * to pre-fill the Create Asset form.
 *
 * Only what the vendor's own document actually states: what was bought, from
 * whom, when, for how much, and its warranty. Everything that is the
 * company's own decision rather than the document's fact - the FA code, the
 * owning entity, depreciation policy, who it's assigned to, where it lives -
 * is left alone for the user to fill in, the same as before.
 */

export interface ExtractedAssetData {
  product: string;
  category: string;
  brand: string;
  productNumber: string;
  purchaseDate: string;
  paymentDate: string;
  invoiceNumber: string;
  vendor: string;
  /** The taxable value before GST, since the form adds GST on top of it. */
  purchaseCost: number;
  gstPercent: number;
  warrantyProvider: string;
  warrantyExpiry: string;
  notes: string;
}

const PROMPT = `You are reading a purchase invoice (a PDF, or a photo/scan of one) for a company in India that is recording the purchased item in its fixed-asset register.

Extract the following into a single JSON object and return ONLY that JSON - no markdown fences, no commentary before or after it.

{
  "product": string,        // what was bought, e.g. "Dell Latitude 5440 Laptop" - the main line item
  "category": string,       // a short category for it, e.g. "Laptop", "Furniture", "Air Conditioner" - else ""
  "brand": string,          // make/manufacturer, e.g. "Dell" - else ""
  "productNumber": string,  // model / part / serial number printed for the item - else ""
  "purchaseDate": string,   // the invoice date, as YYYY-MM-DD - else ""
  "paymentDate": string,    // the date payment was made, as YYYY-MM-DD, only if the document states one - else ""
  "invoiceNumber": string,  // the invoice/bill number - else ""
  "vendor": string,         // the seller/supplier company's name (not the buyer) - else ""
  "purchaseCost": number,   // the TAXABLE VALUE before GST, for the asset itself - 0 if unclear
  "gstPercent": number,     // the GST rate as a plain number, e.g. 18 - 0 if not stated
  "warrantyProvider": string, // who provides the warranty, if stated - else ""
  "warrantyExpiry": string,   // warranty end date as YYYY-MM-DD, if stated or clearly derivable - else ""
  "notes": string           // any other remark on the document worth keeping - else ""
}

Rules:
- Every field must be present. Use "" for an unknown string and 0 for an unknown number - never null, never omit a key.
- Numbers must be plain JSON numbers, not strings, and not include currency symbols or thousands separators.
- "purchaseCost" is the pre-GST taxable amount, NOT the grand total. If only a GST-inclusive total is shown and the rate is known, work back to the pre-GST value.
- If the invoice lists several items, use the single most valuable one - this register records one asset at a time.
- Do not invent data that is not on the document.`;

function coerce(raw: unknown): ExtractedAssetData {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  return {
    product: str(r.product),
    category: str(r.category),
    brand: str(r.brand),
    productNumber: str(r.productNumber),
    purchaseDate: isoDate(r.purchaseDate),
    paymentDate: isoDate(r.paymentDate),
    invoiceNumber: str(r.invoiceNumber),
    vendor: str(r.vendor),
    purchaseCost: num(r.purchaseCost),
    gstPercent: num(r.gstPercent),
    warrantyProvider: str(r.warrantyProvider),
    warrantyExpiry: isoDate(r.warrantyExpiry),
    notes: str(r.notes),
  };
}

export async function extractAssetFromDocument(
  file: Buffer,
  mimeType: string
): Promise<ExtractedAssetData> {
  return coerce(await extractJsonFromDocument(file, mimeType, PROMPT));
}
