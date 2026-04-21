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

const IMAGE_MAGIC_BYTES: Array<{ name: string; offset: number; bytes: number[] }> = [
  { name: "jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { name: "png", offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: "gif87a", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { name: "gif89a", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  { name: "webp (RIFF)", offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  { name: "bmp", offset: 0, bytes: [0x42, 0x4d] },
  { name: "tiff-le", offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] },
  { name: "tiff-be", offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] },
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

  const sigs = kind === "video" ? VIDEO_MAGIC_BYTES : IMAGE_MAGIC_BYTES;
  for (const sig of sigs) {
    if (matches(head, sig)) {
      return { valid: true, detected: sig.name };
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
