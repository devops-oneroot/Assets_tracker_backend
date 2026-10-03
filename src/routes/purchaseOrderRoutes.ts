import { Router } from "express";
import { poUpload, pdfExtractUpload } from "../middleware/upload";
import { asyncHandler } from "../middleware/errorHandler";
import {
  listPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  setPurchaseOrderStatus,
  deletePurchaseOrder,
  getPurchaseOrderPdf,
  emailPurchaseOrder,
  exportPurchaseOrders,
  getPoFilterOptions,
  getPoStats,
  getNextPoNumber,
  extractPurchaseOrderPdf,
  addPaymentAdvice,
  updatePaymentAdvice,
  deletePaymentAdvice,
  getPaymentAdvicePdf,
} from "../controllers/purchaseOrderController";

const router = Router();

// Export and meta routes come before "/:id" so they are not swallowed by it.
router.get("/export", asyncHandler(exportPurchaseOrders));
router.get("/meta/options", asyncHandler(getPoFilterOptions));
router.get("/meta/next-number", asyncHandler(getNextPoNumber));
router.get("/meta/stats", asyncHandler(getPoStats));
router.post("/meta/extract-pdf", pdfExtractUpload, asyncHandler(extractPurchaseOrderPdf));

router.get("/", asyncHandler(listPurchaseOrders));
router.post("/", poUpload, asyncHandler(createPurchaseOrder));

router.get("/:id", asyncHandler(getPurchaseOrder));
router.put("/:id", poUpload, asyncHandler(updatePurchaseOrder));
router.patch("/:id/status", asyncHandler(setPurchaseOrderStatus));
router.delete("/:id", asyncHandler(deletePurchaseOrder));

router.get("/:id/pdf", asyncHandler(getPurchaseOrderPdf));
router.post("/:id/email", asyncHandler(emailPurchaseOrder));

router.post("/:id/payment-advices", asyncHandler(addPaymentAdvice));
router.put("/:id/payment-advices/:adviceId", asyncHandler(updatePaymentAdvice));
router.delete("/:id/payment-advices/:adviceId", asyncHandler(deletePaymentAdvice));
router.get("/:id/payment-advices/:adviceId/pdf", asyncHandler(getPaymentAdvicePdf));

export default router;
