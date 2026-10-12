// v1.18: turn a saved web page (.html / .htm) into readable text for attaching. Pure string work: nothing is
// rendered, no scripts run, and nothing external (images, styles, links) is ever loaded.
import { decodeEntities } from './webSearch';

export const isHtmlPath = (p: string): boolean => /\.html?$/i.test(p);

export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|iframe|object|embed|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<(script|style|noscript|template|iframe|object|embed)\b[^>]*\/?>/gi, ' ');
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|ul|ol|h[1-6]|tr|table|blockquote|pre|header|footer|nav|main)\s*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  return s.split('\n').map((l) => l.replace(/[ \t\f\v\r]+/g, ' ').trim()).filter((l, i, a) => l || (i > 0 && a[i - 1])).join('\n').trim();
}
