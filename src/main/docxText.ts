// v1.23: read a .docx's text, in main only, under the Attach folder rules. No dependency: a minimal ZIP reader
// (Node's zlib inflateRaw) finds word/document.xml and a small tag scanner keeps the text. No XML parser runs, so no
// DTD, external entity or network resolution can happen; a document that declares a DOCTYPE or ENTITY is refused.
// Zip-bomb guards: at most MAX_DOCX_ENTRIES entries, declared sizes capped, and inflation stops at MAX_DOCX_XML bytes.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { resolveInsideFolder, ToolError } from './readFileTool';

export const MAX_DOCX_BYTES = 10 * 1024 * 1024;
/** Largest unpacked word/document.xml. */
export const MAX_DOCX_XML = 20 * 1024 * 1024;
/** Most entries in the archive's central directory. */
export const MAX_DOCX_ENTRIES = 2000;
/** Largest total declared unpacked size of all entries. */
export const MAX_DOCX_TOTAL = 200 * 1024 * 1024;
export const MAX_DOCX_TEXT = 200_000;

export const isDocxPath = (p: string): boolean => path.extname(p).toLowerCase() === '.docx';

interface Entry { name: string; method: number; flags: number; compSize: number; size: number; localOffset: number }

/** List the central directory, with the zip-bomb and format guards. */
export function zipEntries(buf: Buffer): Entry[] {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ToolError('That file is not a .docx (no ZIP directory).');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ToolError('ZIP64 .docx files are not supported.');
  if (count > MAX_DOCX_ENTRIES) throw new ToolError(`That .docx has too many parts (over ${MAX_DOCX_ENTRIES}).`);
  if (cdOffset + cdSize > buf.length) throw new ToolError('That .docx is damaged.');
  const out: Entry[] = [];
  let p = cdOffset, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ToolError('That .docx is damaged.');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    total += size;
    if (total > MAX_DOCX_TOTAL) throw new ToolError('That .docx unpacks to too much data.');
    out.push({ name, method, flags, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Unpack one entry, never beyond MAX_DOCX_XML bytes. */
export function readEntry(buf: Buffer, e: Entry): Buffer {
  if (e.flags & 1) throw new ToolError('Encrypted .docx files cannot be read.');
  if (e.size > MAX_DOCX_XML) throw new ToolError('That .docx is too large once unpacked.');
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new ToolError('That .docx is damaged.');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compSize);
  if (data.length !== e.compSize) throw new ToolError('That .docx is damaged.');
  if (e.method === 0) return data;
  if (e.method !== 8) throw new ToolError('That .docx uses an unsupported compression.');
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: MAX_DOCX_XML });
  } catch (err) {
    if (err instanceof RangeError || (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new ToolError('That .docx is too large once unpacked.');
    throw new ToolError('That .docx is damaged.');
  }
}

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]+);/g, (m, g: string) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
    }
    return ENT[g] ?? m; // only the five XML entities; nothing is looked up anywhere
  });
}

/** word/document.xml → plain text: paragraphs become lines, tabs and breaks are kept. */
export function documentXmlToText(xml: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ToolError('That .docx declares a DTD, which Cipher Bot does not read.');
  const out: string[] = [];
  let inText = false;
  const re = /<(\/?)w:(p|t|tab|br|cr)\b[^>]*?(\/?)>|<[^>]*>|([^<]+)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const [, close, tag, selfClose, text] = m;
    if (text !== undefined) { if (inText) out.push(decode(text)); continue; }
    if (!tag) continue;
    if (tag === 't') inText = !close && !selfClose;
    else if (tag === 'p' && close) out.push('\n');
    else if (tag === 'tab' && !close) out.push('\t');
    else if ((tag === 'br' || tag === 'cr') && !close) out.push('\n');
  }
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

export function docxBytesToText(buf: Buffer): string {
  if (buf.length > MAX_DOCX_BYTES) throw new ToolError('That .docx is larger than 10 MB.');
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new ToolError('That file is not a .docx.');
  const entry = zipEntries(buf).find((e) => e.name === 'word/document.xml');
  if (!entry) throw new ToolError('That file is not a Word document (.docx).');
  let text = documentXmlToText(readEntry(buf, entry).toString('utf8'));
  if (!text) throw new ToolError('No text found in this .docx.');
  if (text.length > MAX_DOCX_TEXT) text = `${text.slice(0, MAX_DOCX_TEXT)}\n\n[Only the first ${MAX_DOCX_TEXT} characters are included.]`;
  return text;
}

export async function readDocxInFolder(root: string | null, requested: unknown): Promise<{ relPath: string; content: string }> {
  if (!root) throw new ToolError('Choose a folder for this Cipher bot before attaching a file.');
  const real = await resolveInsideFolder(root, requested);
  if (!isDocxPath(real)) throw new ToolError('Not a .docx file.');
  const st = await fs.stat(real);
  if (!st.isFile()) throw new ToolError('Not a regular file.');
  if (st.size > MAX_DOCX_BYTES) throw new ToolError('That .docx is larger than 10 MB.');
  const content = docxBytesToText(await fs.readFile(real));
  return { relPath: path.relative(await fs.realpath(root), real) || path.basename(real), content };
}
