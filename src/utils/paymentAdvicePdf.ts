import { existsSync, readFileSync } from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { rupeesInWords } from "./amountInWords";
import { computeAdviceTotals } from "../models/PurchaseOrder";
import type { PaymentAdviceDoc, PurchaseOrderApi } from "../models/PurchaseOrder";

/**
 * The printed payment advice summary - the sheet that goes up for signature
 * before a vendor's invoice is paid.
 *
 * Reproduces the form in use: letterhead, a side-by-side supplier/project
 * block, the order and invoice particulars, the supply/tax values split into
 * what was billed previously and what this invoice adds, the deduction ladder
 * down to what is actually payable, and the three-way certification strip.
 *
 * Kept separate from poPdf.ts rather than sharing its drawing helpers: that
 * file prints a document already in use and signed, and a cosmetic dedup is
 * not worth the risk of disturbing it.
 */

const INK = "#000000";
const MUTED = "#444444";
const RULE = "#000000";
const SHADE = "#e8e8e8";

const MARGIN = 32;
const DASH = "";
const LOGO_SIZE = 44;

function logoPath(entity: string): string | null {
  const file = `${entity.toUpperCase()}.png`;
  const candidates = [
    path.resolve(__dirname, "..", "..", "assets", "logos", file),
    path.resolve(process.cwd(), "assets", "logos", file),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const logoCache = new Map<string, Buffer | null>();

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

/** "01-10-2026" - the day-first style this form prints. */
function printDate(value?: Date | string | null): string {
  if (!value) return DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}

/** Indian grouping with paise, as a payment sheet prints money. */
function amount(value?: number | null): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return DASH;
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A zero deduction prints as a dash, the way the hand-filled form leaves it. */
function deduction(value?: number | null): string {
  const n = Number(value ?? 0);
  return !Number.isFinite(n) || n === 0 ? "-" : amount(n);
}

export async function buildPaymentAdvicePdf(
  po: PurchaseOrderApi,
  advice: PaymentAdviceDoc
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  const left = MARGIN;
  const right = doc.page.width - MARGIN;
  const width = right - left;
  let y = MARGIN;

  const totals = computeAdviceTotals(advice);

  /* ---------------- Drawing helpers ---------------- */

  const rule = (x1: number, y1: number, x2: number, y2: number, w = 0.8): void => {
    doc.lineWidth(w).strokeColor(RULE).moveTo(x1, y1).lineTo(x2, y2).stroke();
  };

  const box = (x: number, top: number, w: number, h: number, lw = 0.8): void => {
    doc.lineWidth(lw).strokeColor(RULE).rect(x, top, w, h).stroke();
  };

  const shade = (x: number, top: number, w: number, h: number): void => {
    doc.rect(x, top, w, h).fillColor(SHADE).fill();
  };

  interface TextOpts {
    bold?: boolean;
    italic?: boolean;
    size?: number;
    align?: "left" | "center" | "right";
    color?: string;
    pad?: number;
  }

  const fontFor = (o: TextOpts): string =>
    o.bold ? "Helvetica-Bold" : o.italic ? "Helvetica-Oblique" : "Helvetica";

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
      .fontSize(opts.size ?? 8)
      .fillColor(opts.color ?? INK)
      .text(text, x + pad, top, { width: w - pad * 2, align: opts.align ?? "left" });
  };

  const measure = (text: string, w: number, opts: TextOpts = {}): number => {
    doc.font(fontFor(opts)).fontSize(opts.size ?? 8);
    return doc.heightOfString(text, { width: w - (opts.pad ?? 4) * 2 });
  };

  const MIN_ROW = 16;

  /* ---------------- Letterhead ---------------- */

  const logo = loadLogo(po.entity);
  const buyerName = (po.buyer.name || po.entity).toUpperCase();
  const headTextW = width - (logo ? LOGO_SIZE + 12 : 0);

  const headH = Math.max(
    measure(buyerName, headTextW, { bold: true, size: 11 }) +
      (po.buyer.address ? measure(po.buyer.address, headTextW, { size: 7.5 }) + 2 : 0),
    logo ? LOGO_SIZE : 0,
    26
  );

  box(left, y, width, headH);
  cellText(buyerName, left, y + 4, headTextW, { bold: true, size: 11 });
  if (po.buyer.address) {
    cellText(
      po.buyer.address,
      left,
      y + 4 + measure(buyerName, headTextW, { bold: true, size: 11 }),
      headTextW,
      { size: 7.5 }
    );
  }
  if (logo) {
    try {
      doc.image(logo, right - LOGO_SIZE - 6, y + (headH - LOGO_SIZE) / 2, {
        fit: [LOGO_SIZE, LOGO_SIZE],
        align: "center",
        valign: "center",
      });
    } catch {
      // A corrupt logo prints as no logo - never a failed document.
    }
  }
  y += headH;

  /* ---------------- Title ---------------- */

  const TITLE_H = 20;
  shade(left, y, width, TITLE_H);
  box(left, y, width, TITLE_H);
  cellText("PAYMENT ADVICE SUMMARY", left, y + 6, width, { bold: true, size: 10, align: "center" });
  y += TITLE_H;

  /* ---------------- Supplier / project block ---------------- */

  // Two label+value pairs side by side: supplier on the left, site on the right.
  const halfW = width / 2;
  const labelW = halfW * 0.32;
  const valueW = halfW - labelW;
  const xSupLabel = left;
  const xSupValue = left + labelW;
  const xPrjLabel = left + halfW;
  const xPrjValue = xPrjLabel + labelW;

  const partyRow = (
    leftLabel: string,
    leftValue: string,
    rightLabel: string,
    rightValue: string
  ): void => {
    const h = Math.max(
      MIN_ROW,
      measure(leftValue || " ", valueW) + 6,
      measure(rightValue || " ", valueW) + 6
    );
    box(left, y, width, h);
    for (const vx of [xSupValue, xPrjLabel, xPrjValue]) rule(vx, y, vx, y + h);

    cellText(leftLabel, xSupLabel, y + 3, labelW, { bold: true, size: 7.5 });
    cellText(leftValue, xSupValue, y + 3, valueW, { size: 7.5 });
    cellText(rightLabel, xPrjLabel, y + 3, labelW, { bold: true, size: 7.5 });
    cellText(rightValue, xPrjValue, y + 3, valueW, { size: 7.5 });
    y += h;
  };

  partyRow("Supplier Name", advice.supplierName, "PROJECT", advice.projectName);
  partyRow("Address", advice.supplierAddress, "Address", advice.projectAddress);
  partyRow("GSTIN", advice.supplierGstNumber, "GSTIN", advice.projectGstNumber);
  partyRow("PAN", advice.supplierPan, "PAN", advice.projectPan);

  /* ---------------- Order and invoice particulars ---------------- */

  /** A row of label/value pairs, each pair taking an equal share of the width. */
  const pairRow = (pairs: [string, string][]): void => {
    const cellW = width / pairs.length;
    const pLabelW = cellW * 0.42;
    const pValueW = cellW - pLabelW;

    // Both sides can wrap - "Original PO/WO Value" is taller than its figure.
    const h = Math.max(
      MIN_ROW,
      ...pairs.map(([l]) => measure(l || " ", pLabelW, { bold: true, size: 7.5 }) + 6),
      ...pairs.map(([, v]) => measure(v || " ", pValueW, { size: 7.5 }) + 6)
    );
    box(left, y, width, h);

    pairs.forEach(([label, value], i) => {
      const x = left + cellW * i;
      if (i > 0) rule(x, y, x, y + h);
      rule(x + pLabelW, y, x + pLabelW, y + h);
      cellText(label, x, y + 3, pLabelW, { bold: true, size: 7.5 });
      cellText(value, x + pLabelW, y + 3, pValueW, { size: 7.5 });
    });
    y += h;
  };

  pairRow([
    ["PO/WO No:", po.poNumber],
    ["PO/WO Date:", printDate(po.poDate)],
    ["Credit Period:", advice.creditPeriod],
  ]);
  pairRow([
    ["Nature Of Supply", advice.natureOfSupply],
    ["Inv No:", advice.invoiceNumber],
    ["Inv Date:", printDate(advice.invoiceDate)],
  ]);
  pairRow([
    ["Payment Terms", advice.paymentTerms],
    ["Inv Recd Date:", printDate(advice.invoiceReceivedDate)],
    ["Pmt. due date:", printDate(advice.paymentDueDate)],
  ]);
  pairRow([
    ["Original PO/WO Value", amount(advice.originalPoValue)],
    ["Amended PO/WO Value", advice.amendedPoValue ? amount(advice.amendedPoValue) : ""],
    ["Final PO/WO Value", amount(advice.finalPoValue)],
  ]);

  /* ---------------- Supply values ---------------- */

  // Description | Bill Date | Previous Value | Bill Date | Present Value
  const sCols = [0.3, 0.14, 0.2, 0.14, 0.22];
  const sx: number[] = [];
  {
    let acc = left;
    for (const frac of sCols) {
      sx.push(acc);
      acc += width * frac;
    }
  }
  const sw = sCols.map((f) => width * f);

  const supplyRow = (cells: string[], opts: TextOpts = {}, h = MIN_ROW): void => {
    box(left, y, width, h);
    for (let i = 1; i < sx.length; i += 1) rule(sx[i]!, y, sx[i]!, y + h);
    cells.forEach((text, i) => {
      cellText(text, sx[i]!, y + 3, sw[i]!, {
        size: 7.5,
        align: i === 0 ? "left" : "right",
        ...opts,
      });
    });
    y += h;
  };

  const headH2 = 24;
  shade(left, y, width, headH2);
  box(left, y, width, headH2);
  for (let i = 1; i < sx.length; i += 1) rule(sx[i]!, y, sx[i]!, y + headH2);
  ["Description", "Bill Date", "Previous Value Of Supply", "Bill Date", "Present Value of Supply"].forEach(
    (t, i) => cellText(t, sx[i]!, y + 5, sw[i]!, { bold: true, size: 7.5, align: "center" })
  );
  y += headH2;

  supplyRow([
    "Value of Supply",
    printDate(advice.previousBillDate),
    advice.previousValueOfSupply ? amount(advice.previousValueOfSupply) : "-",
    printDate(advice.presentBillDate),
    amount(advice.presentValueOfSupply),
  ]);
  supplyRow([
    "Value of Tax",
    "",
    advice.previousValueOfSupply ? "" : "-",
    "",
    advice.valueOfTax ? amount(advice.valueOfTax) : "-",
  ]);
  supplyRow(
    ["Total Invoice Value", "", "-", "", amount(totals.totalInvoiceValue)],
    { bold: true }
  );
  supplyRow([
    "% of Supply",
    "",
    "",
    "",
    advice.percentOfSupply ? `${advice.percentOfSupply}` : "",
  ]);

  /* ---------------- Payment details ---------------- */

  const pLabelW = width * 0.62;
  const pAmountW = width - pLabelW;

  const payRow = (label: string, value: string, bold = false): void => {
    const h = MIN_ROW;
    box(left, y, width, h);
    rule(left + pLabelW, y, left + pLabelW, y + h);
    cellText(label, left, y + 3, pLabelW, { size: 7.5, bold });
    cellText(value, left + pLabelW, y + 3, pAmountW, { size: 7.5, align: "right", bold });
    y += h;
  };

  shade(left, y, width, MIN_ROW);
  box(left, y, width, MIN_ROW);
  rule(left + pLabelW, y, left + pLabelW, y + MIN_ROW);
  cellText("Payment Details", left, y + 3, pLabelW, { bold: true, size: 8, align: "center" });
  cellText("Amount", left + pLabelW, y + 3, pAmountW, { bold: true, size: 8, align: "center" });
  y += MIN_ROW;

  payRow("Total Bill Value", amount(totals.totalBillValue));
  payRow("Less : TDS", deduction(advice.tds));
  payRow("Less : Advance Paid", deduction(advice.advancePaid));
  payRow("Less : Debits if any", deduction(advice.debits));
  payRow("Less : Retention", deduction(advice.retention));
  payRow("Less : Hold/Other", deduction(advice.holdOther));
  payRow("Total Deductions", deduction(totals.totalDeductions), true);
  payRow("Balance Payable", amount(totals.balancePayable), true);

  // Amount in words spans the full width, as on the form.
  {
    const words = `INR ${rupeesInWords(totals.balancePayable)}`;
    const h = Math.max(MIN_ROW, measure(words, width * 0.62) + 6);
    box(left, y, width, h);
    rule(left + width * 0.28, y, left + width * 0.28, y + h);
    cellText("Amount in Words", left, y + 3, width * 0.28, { size: 7.5 });
    cellText(words, left + width * 0.28, y + 3, width * 0.72, { bold: true, size: 8, align: "center" });
    y += h;
  }

  payRow("Payment Recommend", advice.paymentRecommend);

  /* ---------------- Certification ---------------- */

  y += 10;
  const CERT_HEAD = 22;
  const CERT_BODY = 54;
  const certW = width / 3;

  shade(left, y, width, CERT_HEAD);
  box(left, y, width, CERT_HEAD);
  cellText("Payment Certified By", left, y + 6, width, { bold: true, size: 8.5, align: "center" });
  y += CERT_HEAD;

  const roles = [
    ["Accounts - Prepared By", advice.preparedBy],
    ["Finance Head - Checked / Verified By", advice.checkedBy],
    ["Managing Director - Approved By", advice.approvedBy],
  ];

  box(left, y, width, CERT_BODY);
  roles.forEach(([role, name], i) => {
    const x = left + certW * i;
    if (i > 0) rule(x, y, x, y + CERT_BODY);
    cellText(role ?? "", x, y + 4, certW, { bold: true, size: 7, align: "center" });
    // The name sits at the foot of the box, leaving the space above it to sign.
    cellText(name ?? "", x, y + CERT_BODY - 12, certW, { size: 7.5, align: "center", color: MUTED });
  });
  y += CERT_BODY;

  doc.end();
  return done;
}
