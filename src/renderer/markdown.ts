// v1.19: a small, safe markdown renderer for chat bubbles. Builds DOM nodes with textContent only (no HTML parsing),
// raw HTML stays literal text, no images. Bold, italic, inline code, code blocks (with a copy button), lists, links.
// Links are buttons handed to onLink (main checks and confirms); nothing navigates in the app.

export interface MdOptions {
  onLink: (url: string) => void;
  onCopy: (text: string) => void;
}

import { parseBlocks, parseInline } from './markdownParse.js';

function inlineNodes(src: string, o: MdOptions): Node[] {
  return parseInline(src).map((s) => {
    if (s.k === 'text') return document.createTextNode(s.s);
    if (s.k === 'link') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-btn md-link';
      b.textContent = s.s;
      b.title = s.url;
      b.addEventListener('click', (e) => { e.preventDefault(); o.onLink(s.url); });
      return b;
    }
    const el = document.createElement(s.k === 'bold' ? 'strong' : s.k === 'em' ? 'em' : 'code');
    el.textContent = s.s;
    return el;
  });
}

/** Render markdown into a fragment of safe DOM nodes. */
export function renderMarkdown(src: string, o: MdOptions): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const b of parseBlocks(src)) {
    if (b.k === 'code') {
      const wrap = document.createElement('div');
      wrap.className = 'md-code';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'md-copy';
      copy.title = 'Copy code';
      copy.setAttribute('aria-label', 'Copy code');
      const icon = document.createElement('img');
      icon.src = 'assets/cipher-copy-code.svg'; icon.alt = ''; icon.width = 16; icon.height = 16;
      copy.append(icon);
      copy.addEventListener('click', () => o.onCopy(b.text));
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = b.text;
      pre.append(code);
      wrap.append(copy, pre);
      frag.append(wrap);
    } else if (b.k === 'ul' || b.k === 'ol') {
      const list = document.createElement(b.k);
      list.className = 'md-list';
      for (const it of b.items) { const li = document.createElement('li'); li.append(...inlineNodes(it, o)); list.append(li); }
      frag.append(list);
    } else if (b.k === 'h') {
      const p = document.createElement('p');
      p.className = `md-h md-h${b.level}`;
      p.append(...inlineNodes(b.text, o));
      frag.append(p);
    } else if (b.k === 'p') {
      const p = document.createElement('p');
      p.className = 'md-p';
      b.lines.forEach((l, i) => { if (i) p.append(document.createElement('br')); p.append(...inlineNodes(l, o)); });
      frag.append(p);
    }
  }
  return frag;
}
