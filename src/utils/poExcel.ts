import ExcelJS from "exceljs";
import type { PurchaseOrderApi } from "../models/PurchaseOrder";

const DATE_FMT = "dd/mm/yyyy";
const MONEY_FMT = "#,##0.00";

interface ColumnSpec {
  header: string;
  width: number;
  value: (po: PurchaseOrderApi) => string | number | Date | null;
  format?: string;
}

const ORDER_COLUMNS: ColumnSpec[] = [
  { header: "PO Number", width: 16, value: (p) => p.poNumber },
  { header: "Entity", width: 9, value: (p) => p.entity },
  { header: "PO Date", width: 13, value: (p) => p.poDate, format: DATE_FMT },
  { header: "Status", width: 16, value: (p) => String(p.status) },
  { header: "Supplier", width: 28, value: (p) => p.supplier.name },
  { header: "Supplier GST", width: 20, value: (p) => p.supplier.gstNumber },
  { header: "Supplier Contact", width: 18, value: (p) => p.supplier.contactPerson },
  { header: "Supplier Phone", width: 15, value: (p) => p.supplier.phone },
  { header: "Supplier Email", width: 24, value: (p) => p.supplier.email },
  { header: "Supplier Ref", width: 20, value: (p) => p.supplierRef },
  { header: "Other Reference", width: 18, value: (p) => p.otherReference },
  { header: "Deliver To", width: 24, value: (p) => p.deliverTo.name },
  { header: "Expected Delivery", width: 16, value: (p) => p.expectedDate, format: DATE_FMT },
  { header: "Department", width: 16, value: (p) => p.department },
  { header: "Requested By", width: 18, value: (p) => p.requestedBy },
  { header: "Approved By", width: 18, value: (p) => p.approvedBy },
  { header: "Line Items", width: 11, value: (p) => p.totals.itemCount },
  { header: "Sub Total", width: 14, value: (p) => p.totals.subTotal, format: MONEY_FMT },
  { header: "Discount", width: 13, value: (p) => p.totals.discount, format: MONEY_FMT },
  { header: "Taxable Amount", width: 15, value: (p) => p.totals.taxableAmount, format: MONEY_FMT },
  { header: "GST %", width: 8, value: (p) => p.gstPercent },
  { header: "GST Amount", width: 14, value: (p) => p.totals.gstAmount, format: MONEY_FMT },
  { header: "Grand Total", width: 15, value: (p) => p.totals.grandTotal, format: MONEY_FMT },
  { header: "Attachments", width: 12, value: (p) => p.attachments.length },
  { header: "Notes", width: 30, value: (p) => p.notes },
  { header: "Created", width: 13, value: (p) => p.createdAt, format: DATE_FMT },
];

/** One row per priced line, so spend can be sliced by what was actually bought. */
const ITEM_COLUMNS: { header: string; width: number; format?: string }[] = [
  { header: "PO Number", width: 16 },
  { header: "Entity", width: 9 },
  { header: "PO Date", width: 13, format: DATE_FMT },
  { header: "Supplier", width: 28 },
  { header: "S.No", width: 7 },
  { header: "Item", width: 30 },
  { header: "Description", width: 34 },
  { header: "HSN/SAC", width: 12 },
  { header: "Qty", width: 9 },
  { header: "Unit", width: 9 },
  { header: "Price", width: 14, format: MONEY_FMT },
  { header: "Amount", width: 15, format: MONEY_FMT },
];

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF166534" } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = { bottom: { style: "thin", color: { argb: "FF14532D" } } };
  });
}

function zebra(sheet: ExcelJS.Worksheet, rows: number): void {
  for (let r = 2; r <= rows + 1; r += 1) {
    if (r % 2 === 0) continue;
    sheet.getRow(r).eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F8F4" } };
    });
  }
}

/**
 * Builds the .xlsx export: one sheet of orders, one of their individual lines.
 *
 * The second sheet is what makes the export worth having — a purchase register
 * answers "what did we spend with whom", but only the line detail answers "what
 * did we actually buy".
 */
export async function buildPurchaseOrderWorkbook(
  orders: PurchaseOrderApi[]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AssetTrack";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Purchase Orders", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = ORDER_COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  for (const po of orders) sheet.addRow(ORDER_COLUMNS.map((c) => c.value(po)));
  ORDER_COLUMNS.forEach((spec, i) => {
    if (spec.format) sheet.getColumn(i + 1).numFmt = spec.format;
  });
  styleHeader(sheet);
  zebra(sheet, orders.length);
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, orders.length + 1), column: ORDER_COLUMNS.length },
  };

  const lines = workbook.addWorksheet("Line Items", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  lines.columns = ITEM_COLUMNS.map((c) => ({ header: c.header, width: c.width }));

  let lineCount = 0;
  for (const po of orders) {
    for (const item of po.items) {
      if (item.kind === "heading") continue;
      lines.addRow([
        po.poNumber,
        po.entity,
        po.poDate,
        po.supplier.name,
        item.label,
        item.name,
        item.description,
        item.hsnCode,
        item.quantity,
        item.unit,
        item.price,
        item.amount,
      ]);
      lineCount += 1;
    }
  }
  ITEM_COLUMNS.forEach((spec, i) => {
    if (spec.format) lines.getColumn(i + 1).numFmt = spec.format;
  });
  styleHeader(lines);
  zebra(lines, lineCount);
  lines.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, lineCount + 1), column: ITEM_COLUMNS.length },
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
