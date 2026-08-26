import ExcelJS from "exceljs";
import type { DepreciationResult } from "./depreciation";

/** Shape the export needs — a lean asset plus the computed fields. */
interface ExportRow {
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
  serviceRecords?: { serviceCost?: number }[];
  transferHistory?: unknown[];
  warranty?: { provider?: string; expiryDate?: Date | null; document?: { url?: string } | null } | null;
  physicalVerification?: {
    verified?: boolean;
    verifiedOn?: Date | null;
    verifiedBy?: string;
    remarks?: string;
  } | null;
  photo?: { url?: string } | null;
  purchaseInvoice?: { url?: string } | null;
  notes?: string;
  createdAt?: Date | null;
  book?: DepreciationResult;
  warrantyStatus?: string;
}

const DATE_FMT = "dd/mm/yyyy";
const MONEY_FMT = '#,##0.00';

interface ColumnSpec {
  header: string;
  width: number;
  value: (row: ExportRow) => string | number | Date | null;
  format?: string;
}

const COLUMNS: ColumnSpec[] = [
  { header: "FA Code", width: 14, value: (r) => r.assetCode ?? "" },
  { header: "Entity", width: 9, value: (r) => r.entity ?? "" },
  { header: "Product", width: 26, value: (r) => r.product ?? "" },
  { header: "Product Number", width: 20, value: (r) => r.productNumber ?? "" },
  { header: "Brand", width: 14, value: (r) => r.brand ?? "" },
  { header: "Category", width: 14, value: (r) => r.category ?? "" },
  { header: "Status", width: 11, value: (r) => r.status ?? "" },

  { header: "Purchase Date", width: 14, value: (r) => r.purchaseDate ?? null, format: DATE_FMT },
  { header: "Payment Date", width: 14, value: (r) => r.paymentDate ?? null, format: DATE_FMT },
  { header: "Invoice No", width: 16, value: (r) => r.invoiceNumber ?? "" },
  { header: "Vendor", width: 20, value: (r) => r.vendor ?? "" },
  { header: "Purchase Cost", width: 15, value: (r) => r.purchaseCost ?? 0, format: MONEY_FMT },

  { header: "Dep. Method", width: 12, value: (r) => r.depreciation?.method ?? "" },
  { header: "Rate %", width: 9, value: (r) => r.depreciation?.ratePercent ?? 0 },
  { header: "Useful Life (yrs)", width: 15, value: (r) => r.depreciation?.usefulLifeYears ?? 0 },
  { header: "Salvage Value", width: 14, value: (r) => r.depreciation?.salvageValue ?? 0, format: MONEY_FMT },
  {
    header: "Accumulated Dep.",
    width: 17,
    value: (r) => r.book?.accumulatedDepreciation ?? 0,
    format: MONEY_FMT,
  },
  { header: "Book Value", width: 15, value: (r) => r.book?.currentValue ?? 0, format: MONEY_FMT },

  { header: "Assigned To", width: 20, value: (r) => r.assignedEmployee?.name ?? "" },
  { header: "Employee ID", width: 14, value: (r) => r.assignedEmployee?.employeeId ?? "" },
  { header: "Employee Email", width: 24, value: (r) => r.assignedEmployee?.email ?? "" },
  { header: "Department", width: 16, value: (r) => r.department ?? "" },
  { header: "Location", width: 18, value: (r) => r.location ?? "" },

  { header: "Warranty Provider", width: 18, value: (r) => r.warranty?.provider ?? "" },
  { header: "Warranty Expiry", width: 15, value: (r) => r.warranty?.expiryDate ?? null, format: DATE_FMT },
  { header: "Warranty Status", width: 15, value: (r) => r.warrantyStatus ?? "" },

  { header: "Verified", width: 10, value: (r) => (r.physicalVerification?.verified ? "Yes" : "No") },
  {
    header: "Verified On",
    width: 14,
    value: (r) => r.physicalVerification?.verifiedOn ?? null,
    format: DATE_FMT,
  },
  { header: "Verified By", width: 18, value: (r) => r.physicalVerification?.verifiedBy ?? "" },
  { header: "Verification Remarks", width: 26, value: (r) => r.physicalVerification?.remarks ?? "" },

  { header: "Transfers", width: 10, value: (r) => r.transferHistory?.length ?? 0 },
  { header: "Service Entries", width: 14, value: (r) => r.serviceRecords?.length ?? 0 },
  {
    header: "Service Spend",
    width: 15,
    value: (r) => (r.serviceRecords ?? []).reduce((sum, s) => sum + (s.serviceCost ?? 0), 0),
    format: MONEY_FMT,
  },

  { header: "Photo URL", width: 40, value: (r) => r.photo?.url ?? "" },
  { header: "Invoice URL", width: 40, value: (r) => r.purchaseInvoice?.url ?? "" },
  { header: "Warranty Doc URL", width: 40, value: (r) => r.warranty?.document?.url ?? "" },

  { header: "Notes", width: 30, value: (r) => r.notes ?? "" },
  { header: "Created", width: 14, value: (r) => r.createdAt ?? null, format: DATE_FMT },
];

/** Builds a formatted .xlsx workbook of the given assets. */
export async function buildAssetWorkbook(rows: ExportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AssetTrack";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Assets", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width }));

  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF166534" } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = { bottom: { style: "thin", color: { argb: "FF14532D" } } };
  });

  for (const row of rows) {
    sheet.addRow(COLUMNS.map((c) => c.value(row)));
  }

  // Number and date formats have to be applied per column, after the rows exist.
  COLUMNS.forEach((spec, i) => {
    if (!spec.format) return;
    sheet.getColumn(i + 1).numFmt = spec.format;
  });

  // Zebra striping keeps a wide sheet readable.
  for (let r = 2; r <= rows.length + 1; r += 1) {
    if (r % 2 === 0) continue;
    sheet.getRow(r).eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F8F4" } };
    });
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, rows.length + 1), column: COLUMNS.length },
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
