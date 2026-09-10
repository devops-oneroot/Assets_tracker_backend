import { Router } from "express";
import { poUpload } from "../middleware/upload";
import { asyncHandler } from "../middleware/errorHandler";
import {
  listPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  setPurchaseOrderStatus,
  deletePurchaseOrder,
  getPurchaseOrderPdf,
  exportPurchaseOrders,
  getPoFilterOptions,
  getPoStats,
  getNextPoNumber,
} from "../controllers/purchaseOrderController";

const router = Router();

// Export and meta routes come before "/:id" so they are not swallowed by it.
router.get("/export", asyncHandler(exportPurchaseOrders));
router.get("/meta/options", asyncHandler(getPoFilterOptions));
router.get("/meta/next-number", asyncHandler(getNextPoNumber));
router.get("/meta/stats", asyncHandler(getPoStats));

router.get("/", asyncHandler(listPurchaseOrders));
router.post("/", poUpload, asyncHandler(createPurchaseOrder));

router.get("/:id", asyncHandler(getPurchaseOrder));
router.put("/:id", poUpload, asyncHandler(updatePurchaseOrder));
router.patch("/:id/status", asyncHandler(setPurchaseOrderStatus));
router.delete("/:id", asyncHandler(deletePurchaseOrder));

router.get("/:id/pdf", asyncHandler(getPurchaseOrderPdf));

export default router;
