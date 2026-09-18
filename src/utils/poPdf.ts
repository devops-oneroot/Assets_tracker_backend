import { existsSync, readFileSync } from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { rupeesInWords } from "./amountInWords";
import type { PurchaseOrderApi } from "../models/PurchaseOrder";

/**
 * The printed purchase order.
 *
 * This deliberately reproduces the ruled, boxed layout the club already issues —
 * header panel with buyer, supplier and delivery blocks, a bordered item grid,
 * the totals ladder, terms, and the signatory line — so a PO out of the
 * dashboard is interchangeable with one out of the old spreadsheet.
 */

const INK = "#000000";
const MUTED = "#444444";
const RULE = "#000000";
const SHADE = "#e8e8e8";

const MARGIN = 32;
const DASH = "";

/** Column widths of the item grid, as fractions of the table width. */
const COLS = {
  sno: 0.06,
  description: 0.44,
  qty: 0.08,
  price: 0.16,
  unit: 0.09,
  amount: 0.17,
} as const;

/** Printed size of the company logo in the letterhead, in points. */
const LOGO_SIZE = 54;

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

function ddmmyyyy(value?: Date | string | null): string {
  if (!value) return DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return [
    String(d.getDate()).padStart(2, "0"),
    String(d.getMonth() + 1).padStart(2, "0"),
    d.getFullYear(),
  ].join("-");
}

/**
 * Indian grouping, and no trailing ".00".
 *
 * The built-in PDF fonts have no rupee glyph, so figures are printed bare and
 * the currency is named in the words line and the column headings instead.
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
  const bottom = doc.page.height - MARGIN;

  let y = MARGIN;

  /* ---------------- Drawing helpers ---------------- */

  const rule = (x1: number, y1: number, x2: number, y2: number, w = 0.8): void => {
    doc.lineWidth(w).strokeColor(RULE).moveTo(x1, y1).lineTo(x2, y2).stroke();
  };

  const box = (x: number, top: number, w: number, h: number, lw = 0.8): void => {
    doc.lineWidth(lw).strokeColor(RULE).rect(x, top, w, h).stroke();
  };

  interface TextOpts {
    bold?: boolean;
    size?: number;
    align?: "left" | "center" | "right";
    color?: string;
    pad?: number;
  }

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
      .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(opts.size ?? 8.5)
      .fillColor(opts.color ?? INK)
      .text(text, x + pad, top, { width: w - pad * 2, align: opts.align ?? "left" });
  };

  /** How tall the given text will be at the given width. */
  const measure = (text: string, w: number, opts: TextOpts = {}): number => {
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.size ?? 8.5);
    return doc.heightOfString(text, { width: w - (opts.pad ?? 4) * 2 });
  };

  /* ---------------- Letterhead ---------------- */
  /*
   * The buying company's logo sits top-left, the way a printed letterhead
   * would carry it. The title stays centred on the page so the document reads
   * the same whether or not a logo is on file for the company.
   */

  const logo = loadLogo(po.entity);
  const bandH = logo ? LOGO_SIZE : 20;

  if (logo) {
    try {
      doc.image(logo, left, y, { fit: [LOGO_SIZE, LOGO_SIZE], align: "center", valign: "center" });
    } catch {
      // A corrupt image is treated the same as no image.
    }
  }

  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor(INK)
    .text("PURCHASE ORDER", left, y + (bandH - 13) / 2, { width, align: "center" });

  y += bandH + 6;

  /* ---------------- Header panel ---------------- */
  /*
   * Two columns inside one outer box: the buyer and supplier on the left, the
   * order's own references and the delivery address on the right.
   */

  const colW = width / 2;
  const leftX = left;
  const rightX = left + colW;

  const buyerLines = [po.buyer.name, po.buyer.address].filter(Boolean).join("\n");
  const buyerGst = po.buyer.gstNumber ? `GSTN- ${po.buyer.gstNumber}` : "";
  const supplierLines = [
    po.supplier.name,
    po.supplier.address,
    po.supplier.contactPerson ? `Contact: ${po.supplier.contactPerson}` : "",
    [po.supplier.phone, po.supplier.email].filter(Boolean).join("  |  "),
    po.supplier.gstNumber ? `GST No : ${po.supplier.gstNumber}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const deliverLines = [po.deliverTo.name, po.deliverTo.address].filter(Boolean).join("\n");
  const deliverGst = po.deliverTo.gstNumber ? `GSTN- ${po.deliverTo.gstNumber}` : "";

  // The right column is a fixed ladder of reference rows; the left column is
  // free text. The panel takes whichever side is taller.
  const REF_ROW = 15;
  const refRows: [string, string][] = [
    ["PO No :", po.poNumber],
    ["Dated", ddmmyyyy(po.poDate)],
    ["Supplier's Ref.", po.supplierRef],
    ["Other Reference(s)", po.otherReference],
  ];

  const leftHeight =
    6 +
    measure(buyerLines, colW, { bold: true, size: 9 }) +
    (buyerGst ? measure(buyerGst, colW, { bold: true }) + 4 : 0) +
    12 +
    measure("Supplier", colW, { bold: true }) +
    measure(supplierLines, colW) +
    10;

  const rightHeight =
    refRows.length * REF_ROW +
    16 +
    measure(deliverLines, colW, { size: 8.5 }) +
    (deliverGst ? measure(deliverGst, colW, { bold: true }) + 4 : 0) +
    12;

  const panelH = Math.max(leftHeight, rightHeight, 130);

  box(left, y, width, panelH);
  rule(rightX, y, rightX, y + panelH);

  /* Left column */
  let ly = y + 5;
  cellText(buyerLines, leftX, ly, colW, { bold: true, size: 9 });
  ly += measure(buyerLines, colW, { bold: true, size: 9 }) + 3;
  if (buyerGst) {
    cellText(buyerGst, leftX, ly, colW, { bold: true });
    ly += measure(buyerGst, colW, { bold: true }) + 3;
  }

  rule(leftX, ly, rightX, ly, 0.5);
  ly += 3;
  cellText("Supplier", leftX, ly, colW, { bold: true });
  ly += measure("Supplier", colW, { bold: true }) + 1;
  cellText(supplierLines, leftX, ly, colW);

  /* Right column: reference ladder, then the delivery address */
  let ry = y;
  const labelW = colW * 0.42;
  for (const [label, value] of refRows) {
    rule(rightX, ry + REF_ROW, right, ry + REF_ROW, 0.5);
    rule(rightX + labelW, ry, rightX + labelW, ry + REF_ROW, 0.5);
    cellText(label, rightX, ry + 4, labelW, { bold: true });
    cellText(value || DASH, rightX + labelW, ry + 4, colW - labelW, { bold: true });
    ry += REF_ROW;
  }

  ry += 3;
  cellText("Place Of Delivery :-", rightX, ry, colW, { bold: true });
  ry += 11;
  cellText(deliverLines, rightX, ry, colW);
  ry += measure(deliverLines, colW) + 3;
  if (deliverGst) {
    // Shaded the way the existing orders highlight the delivery GSTN.
    const h = measure(deliverGst, colW, { bold: true }) + 4;
    doc.rect(rightX + 1, ry - 1, colW - 2, h).fill(SHADE);
    cellText(deliverGst, rightX, ry + 1, colW, { bold: true });
  }

  y += panelH;

  /* ---------------- Item grid ---------------- */

  const w = {
    sno: width * COLS.sno,
    description: width * COLS.description,
    qty: width * COLS.qty,
    price: width * COLS.price,
    unit: width * COLS.unit,
    amount: width * COLS.amount,
  };
  const x = {
    sno: left,
    description: left + w.sno,
    qty: left + w.sno + w.description,
    price: left + w.sno + w.description + w.qty,
    unit: left + w.sno + w.description + w.qty + w.price,
    amount: right - w.amount,
  };

  const HEAD_H = 26;

  const drawGridHead = (): void => {
    box(left, y, width, HEAD_H);
    cellText("S.No", x.sno, y + 9, w.sno, { bold: true, align: "center", size: 8 });
    cellText("Product Name and Description", x.description, y + 9, w.description, {
      bold: true,
      align: "center",
    });
    cellText("Qty", x.qty, y + 9, w.qty, { bold: true, align: "center" });
    cellText("Price", x.price, y + 9, w.price, { bold: true, align: "center" });
    cellText("UNIT", x.unit, y + 9, w.unit, { bold: true, align: "center", size: 8 });
    cellText("Total Amount", x.amount, y + 5, w.amount, {
      bold: true,
      align: "center",
      size: 8,
    });
    for (const vx of [x.description, x.qty, x.price, x.unit, x.amount]) {
      rule(vx, y, vx, y + HEAD_H);
    }
    y += HEAD_H;
  };

  drawGridHead();

  const MIN_ROW = 16;

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
      doc.addPage();
      y = MARGIN;
      drawGridHead();
    }

    box(left, y, width, rowH);
    for (const vx of [x.description, x.qty, x.price, x.unit, x.amount]) {
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
      cellText(amount(item.quantity), x.qty, y + 4, w.qty, { align: "center" });
      cellText(amount(item.price), x.price, y + 4, w.price, { align: "center" });
      cellText(item.unit || DASH, x.unit, y + 4, w.unit, { align: "center" });
      cellText(amount(item.amount), x.amount, y + 4, w.amount, { align: "right" });
    }

    y += rowH;
  }

  /* ---------------- Totals ladder ---------------- */

  const TOTAL_ROW = 17;
  // The label spans everything left of the amount column, as on the original.
  const labelSpan = width - w.amount;

  const totalRow = (label: string, value: string, bold = false): void => {
    if (y + TOTAL_ROW > bottom - 60) {
      doc.addPage();
      y = MARGIN;
    }
    box(left, y, width, TOTAL_ROW);
    rule(x.amount, y, x.amount, y + TOTAL_ROW);
    cellText(label, left, y + 5, labelSpan, { bold: true, align: "right", pad: 8 });
    cellText(value, x.amount, y + 5, w.amount, { bold, align: "right" });
    y += TOTAL_ROW;
  };

  const t = po.totals;

  totalRow("Total", amount(t.subTotal));
  if (t.discount > 0) totalRow("Less Discount", `-${amount(t.discount)}`);
  totalRow("Total Amount", amount(t.taxableAmount));

  if (po.gstMode === "CGST+SGST") {
    totalRow(`CGST @${po.gstPercent / 2}%`, amount(t.cgstAmount));
    totalRow(`SGST @${po.gstPercent / 2}%`, amount(t.sgstAmount));
  } else if (po.gstMode === "IGST") {
    totalRow(`IGST @${po.gstPercent}%`, amount(t.igstAmount));
  } else {
    totalRow(`GST @${po.gstPercent}%`, amount(t.gstAmount));
  }

  totalRow("SUB TOTAL In rupees", amount(t.grandTotal), true);

  /* ---------------- Amount in words ---------------- */

  const words = rupeesInWords(t.grandTotal);
  const wordsH = measure(words, width, { bold: true }) + 8;
  box(left, y, width, wordsH);
  cellText(`Amount in words: ${words}`, left, y + 4, width, { bold: true, pad: 6 });
  y += wordsH + 12;

  /* ---------------- Terms ---------------- */

  const terms = po.terms.filter(Boolean);
  if (terms.length) {
    const block =
      measure("Terms and conditions:", width, { bold: true }) +
      terms.reduce((sum, term, i) => sum + measure(`${i + 1}   ${term}`, width) + 2, 0) +
      10;

    if (y + block > bottom - 70) {
      doc.addPage();
      y = MARGIN;
    }

    cellText("Terms and conditions:", left, y, width, { bold: true, pad: 0 });
    y += measure("Terms and conditions:", width, { bold: true }) + 2;

    terms.forEach((term, i) => {
      const line = `${i + 1}    ${term}`;
      cellText(line, left, y, width, { pad: 0, size: 8.5 });
      y += measure(line, width, { size: 8.5 }) + 2;
    });
    y += 8;
  }

  if (po.notes.trim()) {
    const note = `Note: ${po.notes.trim()}`;
    if (y + measure(note, width) > bottom - 70) {
      doc.addPage();
      y = MARGIN;
    }
    cellText(note, left, y, width, { pad: 0, color: MUTED });
    y += measure(note, width) + 10;
  }

  /* ---------------- Signatory ---------------- */

  if (y > bottom - 80) {
    doc.addPage();
    y = MARGIN;
  }

  y = Math.max(y + 10, bottom - 80);
  cellText(`For ${po.buyer.name || po.entity}`, left, y, width / 2, { bold: true, pad: 0 });
  y += 44;
  cellText("Authorised signatory", left, y, width / 2, { pad: 0 });

  if (po.approvedBy) {
    cellText(`Approved by: ${po.approvedBy}`, x.amount - w.price, y, w.price + w.amount, {
      align: "right",
      color: MUTED,
      pad: 0,
    });
  }

  /* ---------------- Page numbers ---------------- */

  const range = doc.bufferedPageRange();
  if (range.count > 1) {
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      doc
        .font("Helvetica")
        .fontSize(7.5)
        .fillColor(MUTED)
        .text(
          `PO ${po.poNumber}  ·  Page ${i + 1} of ${range.count}`,
          left,
          doc.page.height - MARGIN + 8,
          { width, align: "center", lineBreak: false }
        );
    }
  }

  doc.end();
  return done;
}
