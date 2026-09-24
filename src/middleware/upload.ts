import multer from "multer";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Service rows are dynamic, so their photo fields are pre-declared up to this many. */
export const MAX_SERVICE_PHOTOS = 20;

/** How many invoice / warranty files one asset may carry, per field. */
export const MAX_DOCS = 10;

const ALLOWED = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_SERVICE_PHOTOS + MAX_DOCS * 2 + 6 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

/** The file inputs the asset form can submit. */
export const SERVICE_PHOTO_FIELD = (index: number) => `servicePhoto_${index}`;

export const assetUpload = upload.fields([
  { name: "photo", maxCount: 1 },
  { name: "purchaseInvoice", maxCount: MAX_DOCS },
  { name: "warrantyDocument", maxCount: MAX_DOCS },
  { name: "verificationPhoto", maxCount: 1 },
  ...Array.from({ length: MAX_SERVICE_PHOTOS }, (_, i) => ({
    name: SERVICE_PHOTO_FIELD(i),
    maxCount: 1,
  })),
]);

/** The file inputs a purchase order can submit: quotes, proposals, signed copies. */
export const poUpload = upload.fields([{ name: "attachment", maxCount: MAX_DOCS }]);

/** The single PDF "Import from PDF" reads a vendor quotation or an old PO from. */
export const pdfExtractUpload = upload.single("pdf");

export type UploadedFiles = Record<string, Express.Multer.File[] | undefined>;
