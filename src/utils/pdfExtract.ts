import { extractJsonFromDocument, isoDate, num, str } from "./geminiDoc";

/**
 * Reads a vendor quotation, invoice, or old PO - a PDF, or a photo/scan of
 * one - and pulls out enough to pre-fill a new purchase order, via Gemini,
 * which reads a document's text, layout and tables (whether born-digital or a
 * photographed page) natively, no separate OCR step needed.
 *
 * Deliberately does NOT attempt to extract GST%/tax mode: an Indian invoice's
 * tax structure (GST vs CGST+SGST vs IGST, and the rate) is exactly the kind
 * of thing worth getting from the source document rather than a guess baked
 * into a prompt - a wrong auto-filled tax rate is a real accounting mistake,
 * not just a typo to fix. The user sets that deliberately, same as today.
 */

export interface ExtractedPoItem {
  name: string;
  description: string;
  hsnCode: string;
  quantity: number;
  unit: string;
  price: number;
}

export interface ExtractedPoData {
  supplier: {
    name: string;
    gstNumber: string;
    address: string;
    contactPerson: string;
    phone: string;
    email: string;
  };
  vendorCode: string;
  poDate: string;
  supplierRef: string;
  currency: string;
  paymentTerms: string;
  items: ExtractedPoItem[];
  notes: string;
}

const MAX_ITEMS = 200;

const PROMPT = `You are reading a vendor quotation, invoice, or purchase order document (a PDF, or a photo/scan of one) for a construction/procurement company in India.

Extract the following into a single JSON object and return ONLY that JSON - no markdown fences, no commentary before or after it.

{
  "supplier": {
    "name": string,        // the vendor/supplier company's name (not the buyer)
    "gstNumber": string,   // their GSTIN, e.g. "29BCQPH9380B1Z8" - empty string if not found
    "address": string,     // their postal address - empty string if not found
    "contactPerson": string,
    "phone": string,
    "email": string
  },
  "vendorCode": string,       // the vendor's own reference/code for themselves, if printed - else ""
  "poDate": string,           // the document's date, as YYYY-MM-DD - else ""
  "supplierRef": string,      // their quotation/invoice number, e.g. "SG-QTN-110" - else ""
  "currency": string,         // ISO code, e.g. "INR" - default "INR" if not stated
  "paymentTerms": string,     // e.g. "50% advance, 50% on delivery" - else ""
  "items": [
    {
      "name": string,          // short item name
      "description": string,   // longer spec/description, if separate from the name - else ""
      "hsnCode": string,        // HSN/SAC code if a column for it exists - else ""
      "quantity": number,
      "unit": string,           // e.g. "NOS", "KG", "MTR", "SQFT" - else ""
      "price": number           // unit rate, not the line total
    }
  ],
  "notes": string   // any other relevant remark on the document worth keeping - else ""
}

Rules:
- Every field must be present. Use "" for an unknown string and 0 for an unknown number - never null, never omit a key.
- "items" must be an array, even if empty.
- Numbers must be plain JSON numbers, not strings, and not include currency symbols or thousands separators.
- Do not invent data that is not on the document.`;

function coerce(raw: unknown): ExtractedPoData {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (r.supplier && typeof r.supplier === "object" ? r.supplier : {}) as Record<
    string,
    unknown
  >;

  const rawItems = Array.isArray(r.items) ? r.items : [];
  const items: ExtractedPoItem[] = rawItems.slice(0, MAX_ITEMS).map((it) => {
    const item = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    return {
      name: str(item.name),
      description: str(item.description),
      hsnCode: str(item.hsnCode),
      quantity: num(item.quantity),
      unit: str(item.unit),
      price: num(item.price),
    };
  });

  return {
    supplier: {
      name: str(s.name),
      gstNumber: str(s.gstNumber).toUpperCase(),
      address: str(s.address),
      contactPerson: str(s.contactPerson),
      phone: str(s.phone),
      email: str(s.email).toLowerCase(),
    },
    vendorCode: str(r.vendorCode),
    poDate: isoDate(r.poDate),
    supplierRef: str(r.supplierRef),
    currency: str(r.currency).toUpperCase() || "INR",
    paymentTerms: str(r.paymentTerms),
    items,
    notes: str(r.notes),
  };
}

export async function extractPurchaseOrderFromPdf(
  file: Buffer,
  mimeType: string
): Promise<ExtractedPoData> {
  return coerce(await extractJsonFromDocument(file, mimeType, PROMPT));
}
