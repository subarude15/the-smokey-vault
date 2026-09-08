/**
 * Pure helpers for Gallery multi-select upload state.
 * Upload still goes through the existing single-file POST /api/gallery/upload path.
 */

export type GalleryUploadStatus = "pending" | "rejected" | "uploading" | "success" | "failed";

export type PendingGalleryUpload = {
  id: string;
  file: File;
  status: GalleryUploadStatus;
  error?: string;
};

export type GalleryUploadCounts = {
  total: number;
  pending: number;
  rejected: number;
  uploading: number;
  success: number;
  failed: number;
  /** Files eligible to send on the next upload/retry pass. */
  uploadable: number;
  remaining: number;
};

export function fileIdentity(file: Pick<File, "name" | "size" | "lastModified">): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

export function createPendingId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export function validateGalleryFileSize(file: Pick<File, "size">, maxBytes: number): string | undefined {
  if (file.size > maxBytes) {
    return `That file is ${megabytes(file.size)}. The limit is ${megabytes(maxBytes)}.`;
  }
  return undefined;
}

export function isVideoFile(file: Pick<File, "type" | "name">): boolean {
  if (file.type.startsWith("video/")) return true;
  return /\.(mp4|webm|mov|m4v)$/i.test(file.name);
}

/**
 * Merge newly picked files into the batch.
 * - Oversized files stay as rejected rows (valid picks are kept).
 * - Exact same name/size/lastModified is not added twice in one modal session.
 */
export function mergeGallerySelections(
  existing: PendingGalleryUpload[],
  incoming: Iterable<File>,
  maxBytes: number,
  makeId: () => string = createPendingId
): PendingGalleryUpload[] {
  const known = new Set(existing.map((item) => fileIdentity(item.file)));
  const next = [...existing];

  for (const file of incoming) {
    const key = fileIdentity(file);
    if (known.has(key)) continue;
    known.add(key);
    const error = validateGalleryFileSize(file, maxBytes);
    next.push({
      id: makeId(),
      file,
      status: error ? "rejected" : "pending",
      ...(error ? { error } : {})
    });
  }

  return next;
}

/** Pending and rejected items may be removed before / after a batch; in-flight and success stay. */
export function canRemoveGalleryUpload(item: PendingGalleryUpload): boolean {
  return item.status === "pending" || item.status === "rejected" || item.status === "failed";
}

export function removeGalleryUpload(items: PendingGalleryUpload[], id: string): PendingGalleryUpload[] {
  return items.filter((item) => item.id !== id || !canRemoveGalleryUpload(item));
}

export function summarizeGalleryUploads(items: PendingGalleryUpload[]): GalleryUploadCounts {
  const counts: GalleryUploadCounts = {
    total: items.length,
    pending: 0,
    rejected: 0,
    uploading: 0,
    success: 0,
    failed: 0,
    uploadable: 0,
    remaining: 0
  };

  for (const item of items) {
    switch (item.status) {
      case "pending":
        counts.pending += 1;
        break;
      case "rejected":
        counts.rejected += 1;
        break;
      case "uploading":
        counts.uploading += 1;
        break;
      case "success":
        counts.success += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      default: {
        const _exhaustive: never = item.status;
        void _exhaustive;
        break;
      }
    }
  }

  counts.uploadable = counts.pending;
  counts.remaining = counts.pending + counts.uploading;
  return counts;
}

export function galleryUploadsReadyToSend(items: PendingGalleryUpload[]): PendingGalleryUpload[] {
  return items.filter((item) => item.status === "pending");
}

/** Reset failed rows to pending so Retry failed only re-sends those. */
export function prepareGalleryUploadRetry(items: PendingGalleryUpload[]): PendingGalleryUpload[] {
  return items.map((item) => (
    item.status === "failed"
      ? { id: item.id, file: item.file, status: "pending" as const }
      : item
  ));
}

export function setGalleryUploadStatus(
  items: PendingGalleryUpload[],
  id: string,
  status: GalleryUploadStatus,
  error?: string
): PendingGalleryUpload[] {
  return items.map((item) => {
    if (item.id !== id) return item;
    if (error) return { ...item, status, error };
    const { error: _drop, ...rest } = item;
    return { ...rest, status };
  });
}

export function formatGalleryBatchSuccessMessage(successCount: number): string {
  if (successCount <= 0) return "Added to the gallery";
  if (successCount === 1) return "Added 1 memory to the gallery";
  return `Added ${successCount} memories to the gallery`;
}

export function formatGalleryBatchPartialMessage(successCount: number, failedCount: number): string {
  return `${successCount} added · ${failedCount} failed`;
}

export function formatGalleryUploadProgress(doneOrCurrent: number, total: number): string {
  return `Uploading ${doneOrCurrent} of ${total}`;
}

export function formatGalleryUploadSummary(counts: GalleryUploadCounts): string {
  const parts: string[] = [];
  if (counts.success) parts.push(`${counts.success} uploaded`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.remaining) parts.push(`${counts.remaining} remaining`);
  if (counts.rejected) parts.push(`${counts.rejected} skipped`);
  return parts.join(" · ");
}
