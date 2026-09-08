import { spawn } from "node:child_process";
import { access, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import sharp from "sharp";

/** Deterministic poster sibling for a Gallery video filename (e.g. abc.mp4 → abc.poster.webp). */
export function galleryPosterFilename(videoFilename: string): string {
  const base = basename(videoFilename);
  if (!base || base !== videoFilename || base.includes("..") || base.includes("/") || base.includes("\\")) {
    throw new Error("Invalid gallery video filename for poster");
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  if (!stem || stem.includes("..")) {
    throw new Error("Invalid gallery video filename for poster");
  }
  return `${stem}.poster.webp`;
}

export function isGalleryPosterFilename(filename: string): boolean {
  return filename.endsWith(".poster.webp");
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

async function extractFrameJpeg(videoPath: string, outJpeg: string, seekSeconds: number): Promise<void> {
  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(seekSeconds),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-y",
    outJpeg,
  ]);
}

/**
 * Extract a near-start frame, resize, and write a WebP poster next to Gallery media.
 * Returns true when a poster file was written. Failures are soft — callers should keep the video.
 */
export async function generateGalleryVideoPoster(opts: {
  galleryDir: string;
  videoFilename: string;
  log?: (message: string) => void;
}): Promise<boolean> {
  const { galleryDir, videoFilename, log } = opts;
  let posterName: string;
  try {
    posterName = galleryPosterFilename(videoFilename);
  } catch {
    log?.("gallery poster: refused unsafe video filename");
    return false;
  }

  const videoPath = join(galleryDir, videoFilename);
  const posterPath = join(galleryDir, posterName);

  try {
    await access(videoPath);
  } catch {
    log?.("gallery poster: video file missing");
    return false;
  }

  const tmpJpeg = join(tmpdir(), `sv-gallery-frame-${randomBytes(8).toString("hex")}.jpg`);
  try {
    let extracted = false;
    for (const seek of [1, 0.5, 0]) {
      try {
        await extractFrameJpeg(videoPath, tmpJpeg, seek);
        extracted = true;
        break;
      } catch {
        // try earlier seek / frame 0
      }
    }
    if (!extracted) {
      log?.("gallery poster: ffmpeg frame extract failed");
      return false;
    }

    const webp = await sharp(tmpJpeg)
      .rotate()
      .resize({
        width: 960,
        height: 960,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 72 })
      .toBuffer();

    await writeFile(posterPath, webp, { mode: 0o644 });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`gallery poster: generation failed (${msg.slice(0, 160)})`);
    try {
      await unlink(posterPath);
    } catch {
      // ignore
    }
    return false;
  } finally {
    try {
      await unlink(tmpJpeg);
    } catch {
      // ignore
    }
  }
}

export async function ensureGalleryVideoPoster(opts: {
  galleryDir: string;
  videoFilename: string;
  log?: (message: string) => void;
}): Promise<boolean> {
  const posterName = galleryPosterFilename(opts.videoFilename);
  const posterPath = join(opts.galleryDir, posterName);
  try {
    await access(posterPath);
    return true;
  } catch {
    // missing — generate
  }
  return generateGalleryVideoPoster(opts);
}
