/* Helix-specific shim around the SDK loader.
 *
 * The actual loader pipeline lives in @helix/editors-format-loader. This file
 * wires the Helix Drive API (drive-fetcher.ts) into the SDK's BlobFetcher
 * interface and re-exports the result types so the rest of apps/web keeps
 * importing from `@/features/_open/universal-loader` unchanged.
 */

import {
  BlobNotFoundError,
  loadBlobForEditor,
  type BlobFetcher,
  type LoadOptions,
  type LoaderResult,
} from "@helix/editors-format-loader";
import { DriveBlobNotFoundError, fetchDriveBlob } from "./drive-fetcher.js";

export type { LoaderResult, LoadOptions } from "@helix/editors-format-loader";

const HELIX_DRIVE_FETCHER: BlobFetcher = {
  async fetchBlob(objectId) {
    try {
      return await fetchDriveBlob(objectId);
    } catch (err) {
      if (err instanceof DriveBlobNotFoundError) throw new BlobNotFoundError(objectId);
      throw err;
    }
  },
};

export async function loadDriveObjectForEditor(
  objectId: string,
  options: LoadOptions = {},
): Promise<LoaderResult> {
  return loadBlobForEditor(HELIX_DRIVE_FETCHER, objectId, options);
}
