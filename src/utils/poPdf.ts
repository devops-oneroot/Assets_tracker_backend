import { existsSync, readFileSync } from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { rupeesInWords } from "./amountInWords";
import type { PurchaseOrderApi } from "../models/PurchaseOrder";

/**
 * The printed purchase order.
 *
 * Reproduces a formal procurement-document layout: a running header/footer
 * strip on every page, a letterhead, a purchasing-document info table, a
 * three-way vendor/ship-to/bill-to address table, a bordered item grid with a
 * per-line tax column, the totals ladder, terms, and a two-party
 * release/acceptance signature block.
 */

const INK = "#000000";
const MUTED = "#444444";
const RULE = "#000000";
const SHADE = "#e8e8e8";

const MARGIN = 32;
const DASH = "";

/** Reserved bands, outside the margin box, for the running header/footer strip. */
const STRIP_H = 14;

/** Column widths of the item grid, as fractions of the table width. */
const COLS = {
  sno: 0.05,
  description: 0.27,
  hsn: 0.09,
  qty: 0.07,
  uom: 0.06,
  netPrice: 0.13,
  tax: 0.07,
  netValue: 0.26,
} as const;

/** Printed size of the company logo in the letterhead, in points. */
const LOGO_SIZE = 46;

/**
 * Where the company logos live: backend/assets/logos/<ENTITY>.png.
 *
 * Resolved relative to this file rather than the working directory, so it
 * finds them whether running from src/ under tsx or from dist/ after a build.
 * The cwd form is a fallback for hosts that run the server from elsewhere.
 */
function logoPath(entity: string): string | null {
  const file = `${entity.toUpperCase()}.png`;
  const candidates = [
    path.resolve(__dirname, "..", "..", "assets", "logos", file),
    path.resolve(process.cwd(), "assets", "logos", file),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const logoCache = new Map<string, Buffer | null>();

/**
 * The logo bytes for a company, read once and kept.
 *
 * A missing or unreadable file gives null and the document prints without a
 * logo — a purchase order must never fail to generate over its letterhead.
 */
function loadLogo(entity: string): Buffer | null {
  if (!logoCache.has(entity)) {
    const found = logoPath(entity);
    let bytes: Buffer | null = null;
    if (found) {
      try {
        bytes = readFileSync(found);
      } catch {
        bytes = null;
      }
    }
    logoCache.set(entity, bytes);
  }
  return logoCache.get(entity) ?? null;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "13-Aug-2026" — the date style this document prints throughout. */
function printDate(value?: Date | string | null): string {
  if (!value) return DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return `${String(d.getDate()).padStart(2, "0")}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

/**
 * Indian grouping, and no trailing ".00".
 *
 * The built-in PDF fonts have no rupee glyph, so figures are printed bare and
 * the currency is named in the header and the words line instead.
 */
function amount(value?: number | null): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return DASH;
  return n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export async function buildPurchaseOrderPdf(po: PurchaseOrderApi): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  const left = MARGIN;
  const right = doc.page.width - MARGIN;
  const width = right - left;
  const contentTop = MARGIN + STRIP_H;
  const bottom = doc.page.height - MARGIN - STRIP_H;

  let y = contentTop;

  /* ---------------- Drawing helpers ---------------- */

  const rule = (x1: number, y1: number, x2: number, y2: number, w = 0.8): void => {
    doc.lineWidth(w).strokeColor(RULE).moveTo(x1, y1).lineTo(x2, y2).stroke();
  };

  const box = (x: number, top: number, w: number, h: number, lw = 0.8): void => {
    doc.lineWidth(lw).strokeColor(RULE).rect(x, top, w, h).stroke();
  };

  interface TextOpts {
    bold?: boolean;
    italic?: boolean;
    size?: number;
    align?: "left" | "center" | "right";
    color?: string;
    pad?: number;
  }

  const fontFor = (opts: TextOpts): string =>
    opts.bold ? "Helvetica-Bold" : opts.italic ? "Helvetica-Oblique" : "Helvetica";

  /** Draws text inside a cell, clipped to its width. */
  const cellText = (
    text: string,
    x: number,
    top: number,
    w: number,
    opts: TextOpts = {}
  ): void => {
    const pad = opts.pad ?? 4;
    doc
      .font(fontFor(opts))
      .fontSize(opts.size ?? 8.5)
      .fillColor(opts.color ?? INK)
      .text(text, x + pad, top, { width: w - pad * 2, align: opts.align ?? "left" });
  };

  /** How tall the given text will be at the given width. */
  const measure = (text: string, w: number, opts: TextOpts = {}): number => {
    doc.font(fontFor(opts)).fontSize(opts.size ?? 8.5);
    return doc.heightOfString(text, { width: w - (opts.pad ?? 4) * 2 });
  };

  const newPage = (): void => {
    doc.addPage();
    y = contentTop;
  };

  /** A small caption above a boxed section, the way the sample labels each block. */
  const sectionCaption = (text: string): void => {
    cellText(text, left, y, width, { bold: true, size: 8, pad: 0, color: MUTED });
    y += measure(text, width, { bold: true, size: 8, pad: 0 }) + 3;
  };

  /* ---------------- Letterhead ---------------- */

  const logo = loadLogo(po.entity);
  const buyerName = po.buyer.name || po.entity;

  const buyerBlockW = width * 0.62;
  const titleBlockW = width - buyerBlockW;
  const titleX = left + buyerBlockW;

  const buyerTextX = logo ? left + LOGO_SIZE + 10 : left;
  const buyerTextW = buyerBlockW - (logo ? LOGO_SIZE + 10 : 0);

  const buyerBlockH =
    measure(buyerName, buyerTextW, { bold: true, size: 12 }) +
    (po.buyer.address ? measure(po.buyer.address, buyerTextW, { size: 7.5 }) + 2 : 0) +
    (po.buyer.gstNumber ? measure(`GSTIN: ${po.buyer.gstNumber}`, buyerTextW, { size: 7.5 }) + 2 : 0);

  const bandH = Math.max(logo ? LOGO_SIZE : 0, buyerBlockH, 30);

  if (logo) {
    try {
      doc.image(logo, left, y, { fit: [LOGO_SIZE, LOGO_SIZE], align: "center", valign: "center" });
    } catch {
      // A corrupt image is treated the same as no image.
    }
  }

  let by = y;
  cellText(buyerName, buyerTextX, by, buyerTextW, { bold: true, size: 12, pad: 0 });
  by += measure(buyerName, buyerTextW, { bold: true, size: 12, pad: 0 }) + 2;
  if (po.buyer.address) {
    cellText(po.buyer.address, buyerTextX, by, buyerTextW, { size: 7.5, pad: 0, color: MUTED });
    by += measure(po.buyer.address, buyerTextW, { size: 7.5, pad: 0 }) + 2;
  }
  if (po.buyer.gstNumber) {
    cellText(`GSTIN: ${po.buyer.gstNumber}`, buyerTextX, by, buyerTextW, {
      bold: true,
      size: 7.5,
      pad: 0,
    });
  }

  cellText("PURCHASE ORDER", titleX, y + 2, titleBlockW, { bold: true, size: 14, align: "right", pad: 0 });
  cellText("System-generated procurement document", titleX, y + 19, titleBlockW, {
    italic: true,
    size: 7.5,
    align: "right",
    pad: 0,
    color: MUTED,
  });

  y += bandH + 6;
  rule(left, y, right, y, 1);
  y += 8;

  /* ---------------- Purchasing document info ---------------- */

  const infoRows: [string, string, string, string][] = [
    ["PO Number", po.poNumber || DASH, "Document Date", printDate(po.poDate)],
    ["Vendor Code", po.vendorCode || DASH, "Currency", po.currency || "INR"],
    ["Quotation Reference", po.supplierRef || DASH, "Payment Terms", po.paymentTerms || DASH],
    ["Other Reference(s)", po.otherReference || DASH, "Project", po.project || DASH],
    ["Completion Date", printDate(po.expectedDate), "Purchasing Group", po.purchasingGroup || DASH],
    ["Department", po.department || DASH, "Document Status", (po.status || DASH).toString().toUpperCase()],
  ];

  const INFO_ROW = 17;
  const infoColW = width / 2;
  const infoLabelW = infoColW * 0.42;
  const infoValueW = infoColW - infoLabelW;

  // A long quotation reference or project name wraps rather than clip, so each
  // row grows to fit whichever of its two values is taller.
  const infoRowH = infoRows.map(([, v1, , v2]) =>
    Math.max(
      INFO_ROW,
      measure(v1, infoValueW, { size: 7.8 }) + 8,
      measure(v2, infoValueW, { size: 7.8 }) + 8
    )
  );
  const infoH = infoRowH.reduce((a, b) => a + b, 0);

  box(left, y, width, infoH);
  rule(left + infoColW, y, left + infoColW, y + infoH, 0.5);
  rule(left + infoLabelW, y, left + infoLabelW, y + infoH, 0.5);
  rule(left + infoColW + infoLabelW, y, left + infoColW + infoLabelW, y + infoH, 0.5);

  let infoY = y;
  infoRows.forEach(([l1, v1, l2, v2], i) => {
    const h = infoRowH[i]!;
    if (i > 0) rule(left, infoY, right, infoY, 0.5);
    cellText(l1, left, infoY + 4, infoLabelW, { bold: true, size: 7.8 });
    cellText(v1, left + infoLabelW, infoY + 4, infoValueW, { size: 7.8 });
    cellText(l2, left + infoColW, infoY + 4, infoLabelW, { bold: true, size: 7.8 });
    cellText(v2, left + infoColW + infoLabelW, infoY + 4, infoValueW, { size: 7.8 });
    infoY += h;
  });

  y += infoH + 10;

  /* ---------------- Partner / address data ---------------- */

  sectionCaption("PARTNER / ADDRESS DATA");

  const supplierLines = [
    po.supplier.name || DASH,
    po.supplier.address,
    po.supplier.gstNumber ? `GSTIN: ${po.supplier.gstNumber}` : "",
    po.supplier.contactPerson ? `Contact: ${po.supplier.contactPerson}` : "",
    [po.supplier.phone, po.supplier.email].filter(Boolean).join("  |  "),
  ]
    .filter(Boolean)
    .join("\n");

  const shipLines = [
    po.deliverTo.name || DASH,
    po.deliverTo.address,
    po.deliverTo.gstNumber ? `GSTIN: ${po.deliverTo.gstNumber}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const billLines = [
    po.buyer.name || DASH,
    po.buyer.address,
    po.buyer.gstNumber ? `GSTIN: ${po.buyer.gstNumber}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const partnerLabelW = width * 0.14;
  const partnerValueW = width - partnerLabelW;
  const partnerRows: [string, string][] = [
    ["VENDOR", supplierLines],
    ["SHIP-TO", shipLines],
    ["BILL-TO", billLines],
  ];
  const rowHeights = partnerRows.map(([, text]) =>
    Math.max(measure(text, partnerValueW) + 8, 20)
  );
  const partnerH = rowHeights.reduce((a, b) => a + b, 0);

  box(left, y, width, partnerH);
  rule(left + partnerLabelW, y, left + partnerLabelW, y + partnerH, 0.5);

  let py = y;
  partnerRows.forEach(([label, text], i) => {
    const h = rowHeights[i]!;
    if (i > 0) rule(left, py, right, py, 0.5);
    doc.rect(left + 1, py + 1, partnerLabelW - 2, h - 2).fill(SHADE);
    cellText(label, left, py + 4, partnerLabelW, { bold: true, size: 8 });
    cellText(text, left + partnerLabelW, py + 4, partnerValueW, { size: 8 });
    py += h;
  });

  y += partnerH + 12;

  /* ---------------- Item grid ---------------- */

  sectionCaption("ITEM DETAILS");

  const w = {
    sno: width * COLS.sno,
    description: width * COLS.description,
    hsn: width * COLS.hsn,
    qty: width * COLS.qty,
    uom: width * COLS.uom,
    netPrice: width * COLS.netPrice,
    tax: width * COLS.tax,
    netValue: width * COLS.netValue,
  };
  const x = {
    sno: left,
    description: left + w.sno,
    hsn: left + w.sno + w.description,
    qty: left + w.sno + w.description + w.hsn,
    uom: left + w.sno + w.description + w.hsn + w.qty,
    netPrice: left + w.sno + w.description + w.hsn + w.qty + w.uom,
    tax: left + w.sno + w.description + w.hsn + w.qty + w.uom + w.netPrice,
    netValue: right - w.netValue,
  };

  const HEAD_H = 24;

  const drawGridHead = (): void => {
    box(left, y, width, HEAD_H);
    cellText("Item", x.sno, y + 8, w.sno, { bold: true, align: "center", size: 7.5 });
    cellText("Short Text / Description", x.description, y + 8, w.description, {
      bold: true,
      align: "center",
      size: 7.5,
    });
    cellText("HSN/SAC", x.hsn, y + 8, w.hsn, { bold: true, align: "center", size: 7.5 });
    cellText("Qty", x.qty, y + 8, w.qty, { bold: true, align: "center", size: 7.5 });
    cellText("UoM", x.uom, y + 8, w.uom, { bold: true, align: "center", size: 7.5 });
    cellText("Net Price", x.netPrice, y + 8, w.netPrice, { bold: true, align: "center", size: 7.5 });
    cellText("Tax", x.tax, y + 8, w.tax, { bold: true, align: "center", size: 7.5 });
    cellText("Net Value", x.netValue, y + 8, w.netValue, { bold: true, align: "center", size: 7.5 });
    for (const vx of [x.description, x.hsn, x.qty, x.uom, x.netPrice, x.tax, x.netValue]) {
      rule(vx, y, vx, y + HEAD_H);
    }
    y += HEAD_H;
  };

  drawGridHead();

  const MIN_ROW = 16;
  const taxLabel = `${po.gstPercent}%`;

  for (const item of po.items) {
    const heading = item.kind === "heading";
    // A heading prints its name alone, in bold and underlined the way the
    // existing orders mark a group; a priced line prints its name and, after a
    // dash, its description.
    const body = heading
      ? item.name
      : [item.name, item.description].filter(Boolean).join(item.name ? " - " : "");
    const text = body || DASH;

    // Sub-rows sit slightly in from the group heading above them.
    const indent = item.kind === "sub" ? 8 : 0;
    const textW = w.description - indent;

    const rowH = Math.max(MIN_ROW, measure(text, textW, { bold: heading }) + 7);

    // Start a new page rather than let a row straddle the fold.
    if (y + rowH > bottom - 120) {
      newPage();
      drawGridHead();
    }

    box(left, y, width, rowH);
    for (const vx of [x.description, x.hsn, x.qty, x.uom, x.netPrice, x.tax, x.netValue]) {
      rule(vx, y, vx, y + rowH);
    }

    const textY = y + (rowH - measure(text, textW, { bold: heading })) / 2;
    cellText(item.label, x.sno, y + 4, w.sno, { align: "center", bold: heading });
    cellText(text, x.description + indent, textY, textW, { bold: heading });

    if (heading && item.name) {
      // Underline the group name, as on the printed originals.
      const tw = Math.min(
        doc.font("Helvetica-Bold").fontSize(8.5).widthOfString(item.name),
        textW - 8
      );
      rule(x.description + 4, textY + 11, x.description + 4 + tw, textY + 11, 0.5);
    }

    if (!heading) {
      cellText(item.hsnCode || DASH, x.hsn, y + 4, w.hsn, { align: "center" });
      cellText(amount(item.quantity), x.qty, y + 4, w.qty, { align: "center" });
      cellText(item.unit || DASH, x.uom, y + 4, w.uom, { align: "center" });
      cellText(amount(item.price), x.netPrice, y + 4, w.netPrice, { align: "right" });
      cellText(taxLabel, x.tax, y + 4, w.tax, { align: "center" });
      cellText(amount(item.amount), x.netValue, y + 4, w.netValue, { align: "right" });
    }

    y += rowH;
  }

  /* ---------------- Totals ladder ---------------- */

  const TOTAL_ROW = 17;
  // The label spans everything left of the value column, as on the original.
  const labelSpan = width - w.netValue;

  const totalRow = (label: string, value: string, bold = false): void => {
    if (y + TOTAL_ROW > bottom - 60) {
      newPage();
    }
    box(left, y, width, TOTAL_ROW);
    rule(x.netValue, y, x.netValue, y + TOTAL_ROW);
    cellText(label, left, y + 5, labelSpan, { bold: true, align: "right", pad: 8 });
    cellText(value, x.netValue, y + 5, w.netValue, { bold, align: "right" });
    y += TOTAL_ROW;
  };

  const t = po.totals;

  if (t.discount > 0) {
    totalRow("Gross Total", amount(t.subTotal));
    totalRow("Less Discount", `-${amount(t.discount)}`);
  }
  totalRow("Subtotal / Net PO Value", amount(t.taxableAmount));

  if (po.gstMode === "CGST+SGST") {
    totalRow(`CGST @${po.gstPercent / 2}%`, amount(t.cgstAmount));
    totalRow(`SGST @${po.gstPercent / 2}%`, amount(t.sgstAmount));
  } else if (po.gstMode === "IGST") {
    totalRow(`IGST @${po.gstPercent}%`, amount(t.igstAmount));
  } else {
    totalRow(`GST @${po.gstPercent}%`, amount(t.gstAmount));
  }

  totalRow("TOTAL PO VALUE", amount(t.grandTotal), true);

  /* ---------------- Amount in words ---------------- */

  if ((po.currency || "INR").toUpperCase() === "INR") {
    const words = rupeesInWords(t.grandTotal);
    const wordsH = measure(words, width, { bold: true }) + 8;
    if (y + wordsH > bottom - 40) newPage();
    box(left, y, width, wordsH);
    cellText(`Amount in words: ${words}`, left, y + 4, width, { bold: true, pad: 6 });
    y += wordsH + 12;
  } else {
    y += 8;
  }

  /* ---------------- Terms ---------------- */

  const terms = po.terms.filter(Boolean);
  if (terms.length) {
    const block =
      measure("TERMS & CONDITIONS", width, { bold: true, size: 8 }) +
      terms.reduce((sum, term, i) => sum + measure(`${i + 1}   ${term}`, width) + 2, 0) +
      10;

    if (y + block > bottom - 70) {
      newPage();
    }

    cellText("TERMS & CONDITIONS", left, y, width, { bold: true, pad: 0, size: 8, color: MUTED });
    y += measure("TERMS & CONDITIONS", width, { bold: true, size: 8 }) + 3;

    terms.forEach((term, i) => {
      const line = `${i + 1}    ${term}`;
      cellText(line, left, y, width, { pad: 0, size: 8.5 });
      y += measure(line, width, { size: 8.5 }) + 2;
    });
    y += 8;
  }

  if (po.notes.trim()) {
    const note = `Note: ${po.notes.trim()}`;
    if (y + measure(note, width) > bottom - 90) {
      newPage();
    }
    cellText(note, left, y, width, { pad: 0, color: MUTED });
    y += measure(note, width) + 10;
  }

  /* ---------------- Release / acceptance ---------------- */

  const HEAD_ROW = 18;
  const signH = HEAD_ROW + 46;
  if (y + signH + 14 > bottom) {
    newPage();
  }

  sectionCaption("RELEASE / ACCEPTANCE");

  const signColW = width / 2;
  box(left, y, width, signH);
  rule(left + signColW, y, left + signColW, y + signH);

  rule(left, y + HEAD_ROW, right, y + HEAD_ROW, 0.5);
  doc.rect(left + 1, y + 1, width - 2, HEAD_ROW - 2).fill(SHADE);
  cellText(`FOR ${po.buyer.name || po.entity}`, left, y + 5, signColW, { bold: true, size: 8 });
  cellText(`ACCEPTED — FOR ${po.supplier.name || "SUPPLIER"}`, left + signColW, y + 5, signColW, {
    bold: true,
    size: 8,
  });

  // The left side is auto-generated rather than wet-signed: who raised it and
  // when this copy was printed. The right side leaves Name/Date blank for the
  // vendor to fill in, with how the acceptance was actually obtained noted
  // underneath the box.
  const approvalNote = po.approvedBy
    ? `Approved by ${po.approvedBy} via email confirmation`
    : "Approved by email confirmation";

  let sy = y + HEAD_ROW + 10;
  cellText(`Name: ${po.requestedBy || DASH}`, left, sy, signColW, { size: 8 });
  cellText("Name:", left + signColW, sy, signColW, { size: 8, color: MUTED });
  sy += 18;
  cellText(`Date: ${printDate(new Date())}`, left, sy, signColW, {
    size: 8,
    color: MUTED,
  });
  cellText("Date:", left + signColW, sy, signColW, { size: 8, color: MUTED });

  y += signH + 10;

  cellText(approvalNote, left + signColW, y, signColW, {
    italic: true,
    size: 7.5,
    color: MUTED,
    pad: 0,
  });

  /* ---------------- Running header / footer strip ---------------- */

  const stampParts = [
    `PO No. ${po.poNumber || DASH}`,
    po.buyer.name || po.entity,
    po.vendorCode ? `Vendor Code: ${po.vendorCode}` : "",
    `Currency: ${po.currency || "INR"}`,
  ].filter(Boolean);
  const stampLeft = stampParts.join("  |  ");
  const printed = printDate(new Date());

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);

    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor(MUTED)
      .text(stampLeft, left, MARGIN - 2, { width: width * 0.7, lineBreak: false });
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor(MUTED)
      .text(`Printed: ${printed}  |  Page ${i + 1}`, left, MARGIN - 2, {
        width,
        align: "right",
        lineBreak: false,
      });

    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor(MUTED)
      .text(stampLeft, left, doc.page.height - MARGIN - STRIP_H + 4, {
        width: width * 0.7,
        lineBreak: false,
      });
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor(MUTED)
      .text(
        `Printed: ${printed}  |  Page ${i + 1} of ${range.count}`,
        left,
        doc.page.height - MARGIN - STRIP_H + 4,
        { width, align: "right", lineBreak: false }
      );
  }

  doc.end();
  return done;
}
