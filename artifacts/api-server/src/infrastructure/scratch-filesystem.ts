import { mkdir, statfs } from "node:fs/promises";

/** Repair only a missing scratch leaf, never fabricate a missing disk mount. */
export async function statScratchFilesystem(scratchPath: string) {
  try {
    return await statfs(scratchPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await mkdir(scratchPath);
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    return statfs(scratchPath);
  }
}
