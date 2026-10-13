// v1.23: per-bot tool switches. They live in cipher.db (bots table) and only main changes them, through the desktop
// window's bot settings (IPC bots:setTools). The phone has no route for them and a bot's reply cannot touch them.
// The engine checks them when offering tools and again right before running one (chatEngine.allowed()).
import type { Bot, ToolSwitches } from '../shared/types';

export const TOOL_NAMES = ['read_file', 'web_search', 'calculator', 'checklist_add', 'write_file', 'draft_file'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export const isToolName = (v: unknown): v is ToolName => typeof v === 'string' && (TOOL_NAMES as readonly string[]).includes(v);

/** Switch key for each tool. Files (read_file) is the v1.3+ "Read files" switch (bots.tools_enabled). */
export const TOOL_SWITCH: Record<ToolName, keyof ToolSwitches> = {
  read_file: 'files', web_search: 'search', calculator: 'calculator', checklist_add: 'checklist', write_file: 'write',
  // v1.25: a draft is a write that waits for the user, so it uses the Write file switch.
  draft_file: 'write',
};
export const TOOL_LABELS: Record<ToolName, string> = {
  read_file: 'File reading', web_search: 'Web search', calculator: 'The calculator', checklist_add: 'The checklist', write_file: 'Writing files',
  draft_file: 'Drafting files',
};

/** Defaults for new bots and for the v13 migration of existing bots: everything off except files. */
export const DEFAULT_TOOL_SWITCHES: Readonly<ToolSwitches> = Object.freeze({ files: true, search: false, calculator: false, checklist: false, write: false });

export function toolSwitches(b: Pick<Bot, 'toolsEnabled'> & { tools?: ToolSwitches }): ToolSwitches {
  return b.tools ?? { ...DEFAULT_TOOL_SWITCHES, files: b.toolsEnabled };
}

/** Validate a partial update from the settings window: only the five known keys, booleans only. */
export function parseToolUpdate(raw: unknown): Partial<ToolSwitches> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid tool settings.');
  const out: Partial<ToolSwitches> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!['files', 'search', 'calculator', 'checklist', 'write'].includes(k)) throw new Error(`Unknown tool: ${k}`);
    if (typeof v !== 'boolean') throw new Error('Tool switches are on or off.');
    out[k as keyof ToolSwitches] = v;
  }
  return out;
}
