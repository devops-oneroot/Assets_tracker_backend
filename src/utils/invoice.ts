import PDFDocument from "pdfkit";
import type { DepreciationResult } from "./depreciation";

interface StoredFileLike {
  url?: string;
  fileName?: string;
  bytes?: number;
  format?: string;
}

interface InvoiceAsset {
  _id?: unknown;
  assetCode?: string;
  entity?: string;
  product?: string;
  productNumber?: string;
  brand?: string;
  category?: string;
  status?: string;
  purchaseDate?: Date | null;
  paymentDate?: Date | null;
  invoiceNumber?: string;
  vendor?: string;
  purchaseCost?: number;
  depreciation?: {
    method?: string;
    ratePercent?: number;
    usefulLifeYears?: number;
    salvageValue?: number;
  } | null;
  assignedEmployee?: { name?: string; employeeId?: string; email?: string } | null;
  department?: string;
  location?: string;
  serviceRecords?: {
    description?: string;
    purchaseDate?: Date | null;
    serviceDate?: Date | null;
    paymentDate?: Date | null;
    purchaseCost?: number;
    serviceCost?: number;
    invoiceNumber?: string;
    vendor?: string;
    warrantyPeriod?: string;
    photo?: StoredFileLike | null;
  }[];
  transferHistory?: {
    date?: Date | null;
    fromEmployee?: string;
    toEmployee?: string;
    fromDepartment?: string;
    toDepartment?: string;
    fromLocation?: string;
    toLocation?: string;
    remarks?: string;
  }[];
  warranty?: {
    provider?: string;
    expiryDate?: Date | null;
    document?: StoredFileLike | null;
  } | null;
  physicalVerification?: {
    verified?: boolean;
    verifiedOn?: Date | null;
    verifiedBy?: string;
    remarks?: string;
    photo?: StoredFileLike | null;
  } | null;
  photo?: StoredFileLike | null;
  purchaseInvoice?: StoredFileLike | null;
  notes?: string;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  book?: DepreciationResult;
  warrantyStatus?: string;
}

const GREEN = "#166534";
const LIGHT = "#f0fdf4";
const TEXT = "#18181b";
const MUTED = "#71717a";
const LINE = "#e4e4e7";

const PAGE_MARGIN = 44;
const DASH = "—";

function ddmmyyyy(value?: Date | string | null): string {
  if (!value) return DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return [
    String(d.getDate()).padStart(2, "0"),
    String(d.getMonth() + 1).padStart(2, "0"),
    d.getFullYear(),
  ].join("/");
}

function dateAndTime(value?: Date | string | null): string {
  if (!value) return DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${ddmmyyyy(d)}, ${hh}:${mm}`;
}

function rupees(value?: number | null): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return DASH;
  // "Rs." rather than ₹ — the built-in PDF fonts have no rupee glyph.
  return `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fileLabel(file?: StoredFileLike | null): string {
  if (!file?.url) return "Not uploaded";
  const size = file.bytes ? ` (${Math.max(1, Math.round(file.bytes / 1024))} KB)` : "";
  return `${file.fileName || "file"}${size}`;
}

/**
 * Cloudinary can transcode on delivery, so ask for a JPEG at a sane width.
 * PDFKit only understands JPEG and PNG, and the stored file may be WebP/HEIC.
 */
function jpegVersion(url: string): string {
  return url.includes("/upload/")
    ? url.replace("/upload/", "/upload/f_jpg,q_auto:good,w_600/")
    : url;
}

async function fetchPhoto(url?: string | null): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(jpegVersion(url), { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    // A missing or slow image must never stop the document being produced.
    return null;
  }
}

/** Builds the full asset record PDF — every stored field, plus both histories. */
export async function buildAssetInvoice(asset: InvoiceAsset): Promise<Buffer> {
  // Only the asset photo is embedded; the verification photo is deliberately
  // left out of the printed record.
  const photo = await fetchPhoto(asset.photo?.url);

  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  const left = PAGE_MARGIN;
  const right = doc.page.width - PAGE_MARGIN;
  const width = right - left;
  const bottom = doc.page.height - 64;

  let y = 0;

  /** Starts a new page when the next block would not fit. */
  const ensure = (needed: number): void => {
    if (y + needed <= bottom) return;
    doc.addPage();
    y = PAGE_MARGIN;
  };

  /* ---------------- Header band (page 1) ---------------- */
  doc.rect(0, 0, doc.page.width, 96).fill(GREEN);

  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(20)
    .text(asset.entity || "Asset Register", left, 26, { lineBreak: false });

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#d1fae5")
    .text("FIXED ASSET RECORD", left, 52, { characterSpacing: 1.4, lineBreak: false });

  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor("#ffffff")
    .text(asset.assetCode || DASH, left, 26, { width, align: "right", lineBreak: false });

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#d1fae5")
    .text(`Issued ${ddmmyyyy(new Date())}`, left, 54, {
      width,
      align: "right",
      lineBreak: false,
    });

  y = 120;

  /* ---------------- Photo + headline ---------------- */
  const photoW = 150;
  const photoH = 112;

  if (photo) {
    try {
      doc.save();
      doc.roundedRect(left, y, photoW, photoH, 6).clip();
      doc.image(photo, left, y, { cover: [photoW, photoH], align: "center", valign: "center" });
      doc.restore();
      doc.roundedRect(left, y, photoW, photoH, 6).lineWidth(1).stroke(LINE);
    } catch {
      doc.roundedRect(left, y, photoW, photoH, 6).lineWidth(1).stroke(LINE);
    }
  } else {
    doc.roundedRect(left, y, photoW, photoH, 6).lineWidth(1).dash(3, { space: 3 }).stroke(LINE);
    doc.undash();
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(MUTED)
      .text("No photo on file", left, y + photoH / 2 - 5, {
        width: photoW,
        align: "center",
        lineBreak: false,
      });
  }

  const infoX = left + photoW + 18;
  const infoW = width - photoW - 18;

  doc
    .font("Helvetica-Bold")
    .fontSize(17)
    .fillColor(TEXT)
    .text(asset.product || DASH, infoX, y + 2, { width: infoW, height: 22, ellipsis: true });

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(MUTED)
    .text([asset.brand, asset.category].filter(Boolean).join("  |  ") || DASH, infoX, y + 26, {
      width: infoW,
      height: 14,
      ellipsis: true,
    });

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MUTED)
    .text(`Product no. ${asset.productNumber || DASH}`, infoX, y + 44, {
      width: infoW,
      height: 12,
      ellipsis: true,
    });

  const chipY = y + photoH - 26;
  const chip = (label: string, x: number): number => {
    doc.font("Helvetica-Bold").fontSize(9);
    const w = doc.widthOfString(label) + 16;
    doc.roundedRect(x, chipY, w, 18, 9).fill(LIGHT);
    doc
      .fillColor(GREEN)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(label, x + 8, chipY + 5.5, { lineBreak: false });
    return x + w + 6;
  };
  let chipX = infoX;
  if (asset.entity) chipX = chip(asset.entity, chipX);
  if (asset.status) chipX = chip(asset.status, chipX);
  if (asset.warrantyStatus && asset.warrantyStatus !== "Unknown") {
    chipX = chip(asset.warrantyStatus, chipX);
  }
  chip(asset.physicalVerification?.verified ? "Verified" : "Not verified", chipX);

  y += photoH + 24;

  /* ---------------- Building blocks ---------------- */
  const sectionTitle = (title: string): void => {
    ensure(34);
    doc.rect(left, y, width, 20).fill(LIGHT);
    doc
      .fillColor(GREEN)
      .font("Helvetica-Bold")
      .fontSize(9.5)
      .text(title.toUpperCase(), left + 8, y + 6, { characterSpacing: 0.8, lineBreak: false });
    y += 26;
  };

  /** Two label/value pairs per row. */
  const pairs = (rows: [string, string][]): void => {
    const colW = width / 2;
    for (let i = 0; i < rows.length; i += 2) {
      ensure(30);
      for (let col = 0; col < 2; col += 1) {
        const entry = rows[i + col];
        if (!entry) continue;
        const x = left + col * colW;
        doc
          .font("Helvetica")
          .fontSize(7.5)
          .fillColor(MUTED)
          .text(entry[0].toUpperCase(), x + 8, y, {
            width: colW - 16,
            characterSpacing: 0.5,
            lineBreak: false,
          });
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .fillColor(TEXT)
          .text(entry[1] || DASH, x + 8, y + 10, {
            width: colW - 16,
            height: 13,
            ellipsis: true,
          });
      }
      y += 26;
      doc.moveTo(left, y - 4).lineTo(right, y - 4).lineWidth(0.5).stroke(LINE);
    }
    y += 8;
  };

  /** A free-text block that grows with its content. */
  const paragraph = (text: string): void => {
    doc.font("Helvetica").fontSize(9.5);
    const h = doc.heightOfString(text, { width: width - 16 });
    ensure(h + 12);
    doc.fillColor(TEXT).text(text, left + 8, y, { width: width - 16 });
    y += h + 12;
  };

  /** A simple table with a header row; widths are fractions of the content width. */
  const table = (
    headers: string[],
    widths: number[],
    rows: string[][],
    aligns: ("left" | "right")[] = []
  ): void => {
    const colX: number[] = [];
    let acc = left;
    for (const w of widths) {
      colX.push(acc);
      acc += w * width;
    }

    ensure(30);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
    headers.forEach((h, i) => {
      doc.text(h.toUpperCase(), colX[i]! + 4, y, {
        width: widths[i]! * width - 8,
        align: aligns[i] ?? "left",
        characterSpacing: 0.4,
        lineBreak: false,
      });
    });
    y += 12;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).stroke(LINE);
    y += 5;

    for (const row of rows) {
      // Row height is driven by the tallest wrapped cell.
      doc.font("Helvetica").fontSize(9);
      const heights = row.map((cell, i) =>
        doc.heightOfString(cell || DASH, { width: widths[i]! * width - 8 })
      );
      const rowH = Math.max(14, ...heights);
      ensure(rowH + 8);

      doc.fillColor(TEXT).font("Helvetica").fontSize(9);
      row.forEach((cell, i) => {
        doc.text(cell || DASH, colX[i]! + 4, y, {
          width: widths[i]! * width - 8,
          align: aligns[i] ?? "left",
        });
      });
      y += rowH + 4;
      doc.moveTo(left, y - 2).lineTo(right, y - 2).lineWidth(0.3).stroke(LINE);
    }
    y += 8;
  };

  /* ---------------- Asset details ---------------- */
  sectionTitle("Asset Details");
  pairs([
    ["FA Code", asset.assetCode ?? DASH],
    ["Entity", asset.entity ?? DASH],
    ["Product", asset.product ?? DASH],
    ["Product Number", asset.productNumber ?? DASH],
    ["Brand", asset.brand ?? DASH],
    ["Category", asset.category ?? DASH],
    ["Status", asset.status ?? DASH],
    ["Record ID", String(asset._id ?? DASH)],
  ]);

  /* ---------------- Purchase ---------------- */
  sectionTitle("Purchase");
  pairs([
    ["Purchase Date", ddmmyyyy(asset.purchaseDate)],
    ["Payment Date", ddmmyyyy(asset.paymentDate)],
    ["Invoice Number", asset.invoiceNumber ?? DASH],
    ["Vendor", asset.vendor ?? DASH],
    ["Purchase Cost", rupees(asset.purchaseCost)],
    ["Invoice Document", fileLabel(asset.purchaseInvoice)],
  ]);

  /* ---------------- Valuation ---------------- */
  sectionTitle("Depreciation & Valuation");
  pairs([
    ["Method", asset.depreciation?.method ?? DASH],
    ["Rate", `${asset.depreciation?.ratePercent ?? 0}%`],
    ["Useful Life", `${asset.depreciation?.usefulLifeYears ?? 0} years`],
    ["Salvage Value", rupees(asset.depreciation?.salvageValue)],
    ["Depreciation / Year", rupees(asset.book?.annualDepreciation)],
    ["Age", `${(asset.book?.yearsElapsed ?? 0).toFixed(2)} years`],
    ["Accumulated Depreciation", rupees(asset.book?.accumulatedDepreciation)],
    ["Purchase Cost", rupees(asset.purchaseCost)],
  ]);

  ensure(54);
  doc.roundedRect(left, y, width, 40, 6).fill(GREEN);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#d1fae5")
    .text("CURRENT BOOK VALUE", left + 14, y + 9, { characterSpacing: 1, lineBreak: false });
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor("#ffffff")
    .text(rupees(asset.book?.currentValue ?? asset.purchaseCost), left - 14, y + 11, {
      width,
      align: "right",
      lineBreak: false,
    });
  y += 54;

  /* ---------------- Assignment ---------------- */
  sectionTitle("Assignment & Location");
  pairs([
    ["Assigned Employee", asset.assignedEmployee?.name || "Unassigned"],
    ["Employee ID", asset.assignedEmployee?.employeeId ?? DASH],
    ["Employee Email", asset.assignedEmployee?.email ?? DASH],
    ["Department", asset.department ?? DASH],
    ["Location", asset.location ?? DASH],
  ]);

  /* ---------------- Warranty ---------------- */
  sectionTitle("Warranty");
  pairs([
    ["Provider", asset.warranty?.provider ?? DASH],
    ["Expiry Date", ddmmyyyy(asset.warranty?.expiryDate)],
    ["Status", asset.warrantyStatus ?? DASH],
    ["Warranty Document", fileLabel(asset.warranty?.document)],
  ]);

  /* ---------------- Physical verification ---------------- */
  sectionTitle("Physical Verification");
  pairs([
    ["Verified", asset.physicalVerification?.verified ? "Yes" : "No"],
    ["Verified On", ddmmyyyy(asset.physicalVerification?.verifiedOn)],
    ["Verified By", asset.physicalVerification?.verifiedBy ?? DASH],
    ["Verification Photo", fileLabel(asset.physicalVerification?.photo)],
  ]);

  if (asset.physicalVerification?.remarks) {
    ensure(24);
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(MUTED)
      .text("REMARKS", left + 8, y, { characterSpacing: 0.5, lineBreak: false });
    y += 11;
    paragraph(asset.physicalVerification.remarks);
  }

  /* ---------------- Transfer history (every entry) ---------------- */
  const transfers = asset.transferHistory ?? [];
  sectionTitle("Transfer History");
  if (transfers.length === 0) {
    paragraph("This asset has never been transferred.");
  } else {
    table(
      ["Date", "From", "To", "Department", "Location", "Remarks"],
      [0.12, 0.16, 0.16, 0.18, 0.18, 0.2],
      [...transfers]
        .sort((a, b) => +new Date(b.date ?? 0) - +new Date(a.date ?? 0))
        .map((t) => [
          ddmmyyyy(t.date),
          t.fromEmployee || "Unassigned",
          t.toEmployee || "Unassigned",
          `${t.fromDepartment || DASH} > ${t.toDepartment || DASH}`,
          `${t.fromLocation || DASH} > ${t.toLocation || DASH}`,
          t.remarks ?? DASH,
        ])
    );
  }

  /* ---------------- Attachments ---------------- */
  sectionTitle("Attachments");
  pairs([
    ["Asset Photo", fileLabel(asset.photo)],
    ["Purchase Invoice", fileLabel(asset.purchaseInvoice)],
    ["Warranty Document", fileLabel(asset.warranty?.document)],
    ["Verification Photo", fileLabel(asset.physicalVerification?.photo)],
  ]);

  /* ---------------- Notes ---------------- */
  if (asset.notes) {
    sectionTitle("Notes");
    paragraph(asset.notes);
  }

  /* ---------------- Record metadata ---------------- */
  sectionTitle("Record");
  pairs([
    ["Created", dateAndTime(asset.createdAt)],
    ["Last Updated", dateAndTime(asset.updatedAt)],
  ]);

  /* ---------------- Footer on every page ---------------- */
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);

    // Text drawn below the bottom margin makes PDFKit spill onto a new page,
    // which would grow the document on every footer we write.
    const restore = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const fy = doc.page.height - 44;
    doc.moveTo(left, fy).lineTo(right, fy).lineWidth(0.5).stroke(LINE);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        `${asset.assetCode ?? ""}  ·  Generated ${ddmmyyyy(new Date())}  ·  Computer generated record, no signature required`,
        left,
        fy + 8,
        { width, align: "left", lineBreak: false }
      );
    doc.text(`Page ${i + 1} of ${range.count}`, left, fy + 8, {
      width,
      align: "right",
      lineBreak: false,
    });

    doc.page.margins.bottom = restore;
  }

  doc.end();
  return done;
}
