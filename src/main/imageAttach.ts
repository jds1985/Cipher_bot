// v1.20: images dropped into a chat. Same folder rules as Attach (resolveInsideFolder: inside the bot's read folder,
// symlinks resolved, nothing outside), a size limit, and the bytes must really be PNG/JPEG/GIF/WebP (no SVG: it can
// carry scripts). The window shows an image only as a data: URL built here from those local bytes; never from a URL.
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInsideFolder, ToolError } from './readFileTool';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export const isImagePath = (p: string): boolean => Object.prototype.hasOwnProperty.call(MIME, path.extname(p).toLowerCase());

/** Sniff the real type from the first bytes; null if it is not one of the four allowed formats. */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Read and check one image inside the folder. Returns its path relative to the folder, its type and bytes. */
export async function readImageInFolder(folder: string | null, requested: unknown): Promise<{ relPath: string; mime: string; bytes: Buffer }> {
  if (!folder) throw new ToolError('Choose a folder for this Cipher bot before attaching a file.');
  const real = await resolveInsideFolder(folder, requested);
  if (!isImagePath(real)) throw new ToolError('Only PNG, JPEG, GIF and WebP images can be shown.');
  const st = await fs.stat(real);
  if (!st.isFile()) throw new ToolError('That is not a file.');
  if (st.size > MAX_IMAGE_BYTES) throw new ToolError('That image is larger than 5 MB.');
  const bytes = await fs.readFile(real);
  if (bytes.length > MAX_IMAGE_BYTES) throw new ToolError('That image is larger than 5 MB.');
  const mime = sniffImage(bytes);
  if (!mime) throw new ToolError('That file is not a PNG, JPEG, GIF or WebP image.');
  return { relPath: path.relative(await fs.realpath(folder), real), mime, bytes };
}

export const toDataUrl = (mime: string, bytes: Buffer): string => `data:${mime};base64,${bytes.toString('base64')}`;

/** The drop handler: same result shape as Attach, plus a data: preview. */
export async function attachImageFromPath(bot: { folderPath: string | null } | null, filePath: unknown):
  Promise<{ ok: true; relPath: string; dataUrl: string } | { ok: false; error: string; needFolder?: boolean }> {
  if (!bot) return { ok: false, error: 'Cipher bot not found.' };
  if (!bot.folderPath) return { ok: false, error: 'Choose a folder for this Cipher bot before attaching a file.', needFolder: true };
  try {
    const img = await readImageInFolder(bot.folderPath, filePath);
    return { ok: true, relPath: img.relPath, dataUrl: toDataUrl(img.mime, img.bytes) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not attach the image.' };
  }
}
