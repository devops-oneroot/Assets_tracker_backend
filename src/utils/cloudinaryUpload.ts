import { cloudinary } from "../config/cloudinary";
import { env } from "../config/env";
import type { UploadApiResponse } from "cloudinary";

export interface StoredFile {
  url: string;
  publicId: string;
  fileName: string;
  format: string;
  bytes: number;
  resourceType: string;
  uploadedAt: Date;
}

const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
]);

/** Streams a multer in-memory buffer straight to Cloudinary. */
export function uploadBuffer(
  file: Express.Multer.File,
  subFolder: string
): Promise<StoredFile> {
  return new Promise((resolve, reject) => {
    const isImage = IMAGE_MIMES.has(file.mimetype);
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `${env.cloudinary.folder}/${subFolder}`,
        resource_type: isImage ? "image" : "auto",
        // upload_stream has no filename of its own, so pass the original through
        // to keep names recognisable in the Cloudinary media library.
        use_filename: true,
        filename_override: file.originalname,
        unique_filename: true,
        overwrite: false,
      },
      (error, result?: UploadApiResponse) => {
        if (error) return reject(new Error(`Cloudinary upload failed: ${error.message}`));
        if (!result) return reject(new Error("Cloudinary returned no result"));
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          fileName: file.originalname,
          format: result.format ?? "",
          bytes: result.bytes ?? file.size,
          resourceType: result.resource_type ?? "image",
          uploadedAt: new Date(),
        });
      }
    );
    stream.end(file.buffer);
  });
}

/** Best-effort delete — a failure here must never break the request. */
export async function destroyFile(
  publicId?: string | null,
  resourceType = "image"
): Promise<void> {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType === "raw" ? "raw" : resourceType === "video" ? "video" : "image",
    });
  } catch (err) {
    console.warn("[cloudinary] failed to delete", publicId, (err as Error).message);
  }
}
