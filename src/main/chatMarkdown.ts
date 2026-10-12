// v1.21: the open chat as Markdown for the clipboard. Your messages and the bot's replies only (tool notes, search
// result cards and page blocks are summarized in one line each). Nothing leaves the computer; it goes to the clipboard.
import type { Message, RoomMessage } from '../shared/types';

export function chatMarkdown(botName: string, messages: readonly Message[]): string {
  const out: string[] = [`# Chat with ${botName}`, ''];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push('**You:**');
      if (m.quote) out.push(...m.quote.split('\n').map((l) => `> ${l}`), '');
      if (m.image) out.push(`*[Image: ${m.image.startsWith('pasted:') ? 'pasted screenshot' : m.image.split(/[\\/]/).pop()}]*`, '');
      out.push(m.content, '');
    } else if (m.role === 'assistant') {
      if (!m.content.trim()) continue;
      out.push(`**${botName}:**`, m.content, '');
    } else if (m.toolName === 'web_search' && m.search) {
      out.push(`*Web search: ${m.search.query}*`, ...m.search.results.map((r) => `- [${r.title.replace(/[[\]]/g, '')}](${r.url})`), '');
    } else if (m.toolName === 'calculator') {
      out.push(`*Calculator: ${m.content}*`, '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** v1.22: a room as Markdown, the same way as a bot's chat (who said what, in order). */
export function roomMarkdown(roomName: string, messages: readonly RoomMessage[], nameOf: (botId: number | null) => string | null): string {
  const out: string[] = [`# Room: ${roomName}`, ''];
  for (const m of messages) {
    if (!m.content.trim()) continue;
    out.push(m.role === 'user' ? '**You:**' : `**${nameOf(m.botId) ?? 'Cipher bot'}:**`, m.content, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
