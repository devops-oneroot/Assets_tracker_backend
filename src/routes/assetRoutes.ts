import { Router } from "express";
import { assetUpload, upload } from "../middleware/upload";
import { asyncHandler } from "../middleware/errorHandler";
import {
  listAssets,
  getAsset,
  createAsset,
  updateAsset,
  deleteAsset,
  addServiceRecord,
  addTransfer,
  verifyAsset,
  exportAssets,
  getAssetInvoice,
  getFilterOptions,
  getStats,
} from "../controllers/assetController";

const router = Router();

// Export and meta routes come before "/:id" so they are not swallowed by it.
router.get("/export", asyncHandler(exportAssets));
router.get("/meta/options", asyncHandler(getFilterOptions));
router.get("/meta/stats", asyncHandler(getStats));

router.get("/", asyncHandler(listAssets));
router.post("/", assetUpload, asyncHandler(createAsset));

router.get("/:id", asyncHandler(getAsset));
router.put("/:id", assetUpload, asyncHandler(updateAsset));
router.delete("/:id", asyncHandler(deleteAsset));

router.get("/:id/invoice", asyncHandler(getAssetInvoice));

router.post(
  "/:id/service",
  upload.fields([{ name: "photo", maxCount: 1 }]),
  asyncHandler(addServiceRecord)
);
router.post("/:id/transfer", upload.none(), asyncHandler(addTransfer));
router.post(
  "/:id/verify",
  upload.fields([{ name: "verificationPhoto", maxCount: 1 }]),
  asyncHandler(verifyAsset)
);

export default router;
