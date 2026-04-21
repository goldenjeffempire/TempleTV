import { open, unlink } from "node:fs/promises";

const VIDEO_MAGIC_BYTES: Array<{ name: string; offset: number; bytes: number[] }> = [
  { name: "mp4/mov (ftyp)", offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  { name: "matroska/webm (EBML)", offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { name: "avi (RIFF)", offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  { name: "flv", offset: 0, bytes: [0x46, 0x4c, 0x56, 0x01] },
  { name: "mpeg-ps", offset: 0, bytes: [0x00, 0x00, 0x01, 0xba] },
  { name: "mpeg-ts", offset: 0, bytes: [0x47] },
  { name: "ogg", offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53] },
  { name: "3gp (ftyp)", offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
];

// IMPORTANT: Image signatures must be unambiguous. WebP is *not* matched
// by RIFF alone — that would also match AVI (`RIFF....AVI `) and let an
// attacker pass an AVI through a thumbnail (image-only) endpoint. WebP is
// matched by checking the `WEBP` brand at offset 8 in addition to the RIFF
// magic, which is exactly how the WebP container is defined.
const IMAGE_SIGNATURE_PREDICATES: Array<{ name: string; matches: (buf: Buffer) => boolean }> = [
  { name: "jpeg", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    name: "png",
    matches: (b) =>
      b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    name: "gif",
    matches: (b) =>
      b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
  },
  {
    name: "webp",
    matches: (b) =>
      b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  { name: "bmp", matches: (b) => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d },
  {
    name: "tiff-le",
    matches: (b) => b.length >= 4 && b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00,
  },
  {
    name: "tiff-be",
    matches: (b) => b.length >= 4 && b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a,
  },
  // ISO-BMFF brands for HEIC / HEIF (modern iOS photo format)
  {
    name: "heic",
    matches: (b) => {
      if (b.length < 12 || b[4] !== 0x66 || b[5] !== 0x74 || b[6] !== 0x79 || b[7] !== 0x70) return false;
      const brand = b.slice(8, 12).toString("ascii");
      return ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand);
    },
  },
  {
    name: "avif",
    matches: (b) => {
      if (b.length < 12 || b[4] !== 0x66 || b[5] !== 0x74 || b[6] !== 0x79 || b[7] !== 0x70) return false;
      const brand = b.slice(8, 12).toString("ascii");
      return brand === "avif" || brand === "avis";
    },
  },
];

function matches(buf: Buffer, sig: { offset: number; bytes: number[] }): boolean {
  if (buf.length < sig.offset + sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    if (buf[sig.offset + i] !== sig.bytes[i]) return false;
  }
  return true;
}

async function readHead(filePath: string, length = 32): Promise<Buffer> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

/**
 * Validate that an uploaded file's magic bytes match the declared kind.
 * Deletes the file if validation fails. Returns true if valid.
 */
export async function validateUploadedFileMagicBytes(
  filePath: string,
  kind: "video" | "image",
): Promise<{ valid: boolean; detected: string | null }> {
  let head: Buffer;
  try {
    head = await readHead(filePath);
  } catch {
    return { valid: false, detected: null };
  }

  if (kind === "image") {
    for (const sig of IMAGE_SIGNATURE_PREDICATES) {
      if (sig.matches(head)) {
        return { valid: true, detected: sig.name };
      }
    }
  } else {
    for (const sig of VIDEO_MAGIC_BYTES) {
      if (matches(head, sig)) {
        return { valid: true, detected: sig.name };
      }
    }
  }

  // Cleanup invalid upload to avoid disk filling with garbage
  try {
    await unlink(filePath);
  } catch {
    /* swallow */
  }

  return { valid: false, detected: null };
}
