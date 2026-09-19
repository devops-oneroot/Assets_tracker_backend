import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import {
  listVendors,
  getVendor,
  createVendor,
  updateVendor,
  deleteVendor,
  getNextVendorCode,
  listVendorCategories,
} from "../controllers/vendorController";

const router = Router();

// The meta routes come before "/:id" so they are not swallowed by it.
router.get("/meta/next-code", asyncHandler(getNextVendorCode));
router.get("/meta/categories", asyncHandler(listVendorCategories));

router.get("/", asyncHandler(listVendors));
router.post("/", asyncHandler(createVendor));

router.get("/:id", asyncHandler(getVendor));
router.put("/:id", asyncHandler(updateVendor));
router.delete("/:id", asyncHandler(deleteVendor));

export default router;
