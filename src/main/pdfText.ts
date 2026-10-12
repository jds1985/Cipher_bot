// v1.21: read a PDF's text, in main, from the bot's folder (same rules as Attach / read_file). No network.
// Parser: pdfjs-dist (Mozilla's PDF.js), legacy Node build, pinned. Chosen because it is the most widely used and
// fuzzed pure-JS PDF parser, has no install scripts, and works fully offline: we pass the bytes, preload its worker
// module from the local package (so no worker is ever fetched from a URL), and turn off everything that could load
// or run anything: isEvalSupported false (no code generated from font data), no font faces, no system fonts, no standard
// font or CMap URLs (never fetched; text that needs a CMap may come out incomplete), no XFA, no streaming/range
// requests. PDF.js never runs a PDF's own JavaScript in this mode (no scripting sandbox is created).
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInsideFolder, ToolError } from './readFileTool';

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 50;
export const MAX_PDF_TEXT = 200_000;
export const PDF_TIMEOUT_MS = 20_000;

export const isPdfPath = (p: string): boolean => path.extname(p).toLowerCase() === '.pdf';

type PdfJs = {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
};
type PdfDoc = { numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }> }> };

let lib: PdfJs | null = null;
function pdfjs(): PdfJs {
  if (!lib) {
    // Local worker module, so PDF.js uses it in-process instead of loading a worker from a URL.
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = require('pdfjs-dist/legacy/build/pdf.worker.mjs');
    lib = require('pdfjs-dist/legacy/build/pdf.mjs') as PdfJs;
  }
  return lib;
}

/** The options every PDF is opened with (exported for the test). */
export const PDF_OPTIONS = Object.freeze({
  isEvalSupported: false, disableFontFace: true, useSystemFonts: false, enableXfa: false,
  disableAutoFetch: true, disableStream: true, disableRange: true, stopAtErrors: false, verbosity: 0,
  standardFontDataUrl: undefined, cMapUrl: undefined, wasmUrl: undefined, iccUrl: undefined,
});

/** Text of a PDF given as bytes, page by page, capped. */
export async function pdfBytesToText(bytes: Uint8Array): Promise<{ text: string; pages: number; truncated: boolean }> {
  if (bytes.length > MAX_PDF_BYTES) throw new ToolError('That PDF is larger than 10 MB.');
  if (Buffer.from(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new ToolError('That file is not a PDF.');
  const task = pdfjs().getDocument({ ...PDF_OPTIONS, data: new Uint8Array(bytes) });
  let timer: NodeJS.Timeout | undefined;
  try {
    const run = (async () => {
      const doc = await task.promise;
      const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
      const parts: string[] = [];
      let size = 0;
      let truncated = doc.numPages > MAX_PDF_PAGES;
      for (let i = 1; i <= pages; i++) {
        const content = await (await doc.getPage(i)).getTextContent();
        const t = content.items.map((it) => (it.str ?? '') + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim();
        const block = `[Page ${i}]\n${t}`;
        if (size + block.length > MAX_PDF_TEXT) { parts.push(block.slice(0, Math.max(0, MAX_PDF_TEXT - size))); truncated = true; break; }
        parts.push(block); size += block.length + 2;
      }
      let text = parts.join('\n\n');
      if (truncated) text += `\n\n[Only the first ${pages} of ${doc.numPages} pages or ${MAX_PDF_TEXT} characters are included.]`;
      if (!text.replace(/\[Page \d+\]/g, '').trim()) throw new ToolError('No text found in this PDF (it may be scanned images).');
      return { text, pages: doc.numPages, truncated };
    })();
    const timeout = new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new ToolError('Reading this PDF took too long.')), PDF_TIMEOUT_MS); });
    return await Promise.race([run, timeout]);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError('Could not read this PDF.');
  } finally {
    if (timer) clearTimeout(timer);
    await task.destroy().catch(() => undefined);
  }
}

/** A PDF inside the folder (Attach rules: containment, symlinks resolved, regular file, size cap) → its text. */
export async function readPdfInFolder(root: string | null, requested: unknown): Promise<{ relPath: string; content: string }> {
  if (!root) throw new ToolError('Choose a folder for this Cipher bot before attaching a file.');
  const real = await resolveInsideFolder(root, requested);
  if (!isPdfPath(real)) throw new ToolError('Not a PDF.');
  const st = await fs.stat(real);
  if (!st.isFile()) throw new ToolError('Not a regular file.');
  if (st.size > MAX_PDF_BYTES) throw new ToolError('That PDF is larger than 10 MB.');
  const bytes = await fs.readFile(real);
  const { text } = await pdfBytesToText(bytes);
  return { relPath: path.relative(await fs.realpath(root), real) || path.basename(real), content: text };
}
