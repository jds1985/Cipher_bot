// v1.19: markdown parsing for chat bubbles (pure, no DOM). Rendering is in markdown.ts.

export type Inline = { k: 'text' | 'bold' | 'em' | 'code'; s: string } | { k: 'link'; s: string; url: string };

/** Parse inline markdown into flat spans (no nesting beyond one level; good enough for chat). */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    if (m.index! > last) out.push({ k: 'text', s: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ k: 'code', s: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ k: 'bold', s: (m[2] ?? m[3])! });
    else if (m[4] !== undefined) out.push({ k: 'em', s: m[4] });
    else if (m[5] !== undefined) out.push({ k: 'link', s: m[5], url: m[6] });
    else out.push({ k: 'link', s: m[7], url: m[7] });
    last = m.index! + m[0].length;
  }
  if (last < src.length) out.push({ k: 'text', s: src.slice(last) });
  return out;
}

export type Block =
  | { k: 'p'; lines: string[] }
  | { k: 'code'; lang: string; text: string }
  | { k: 'ul' | 'ol'; items: string[] }
  | { k: 'h'; level: number; text: string };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end)
      out.push({ k: 'code', lang: fence[1], text: body.join('\n') });
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      out.push({ k: 'ul', items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      out.push({ k: 'ol', items });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { out.push({ k: 'h', level: h[1].length, text: h[2] }); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && !/^#{1,3}\s/.test(lines[i])) para.push(lines[i++]);
    out.push({ k: 'p', lines: para });
  }
  return out;
}

