import type { NewBot, NewBotForm } from '../shared/types';
import { normalizeBotColor, normalizeBotShape, type BotColor, type BotShape } from './botIcons';

/** Longest Cipher bot name. */
export const MAX_BOT_NAME = 80;
/** Longest job (system prompt). */
export const MAX_BOT_JOB = 20000;

/** The fields the user sets on a Cipher bot (create and edit): name, job (system prompt), icon shape and color. */
export interface BotProfile {
  name: string;
  systemPrompt: string;
  shape: BotShape;
  color: BotColor;
}

/**
 * The one validator for a bot's name, job, shape and color, used by both create and edit (CipherDb.createBot and
 * CipherDb.updateBot). The name is trimmed and must be 1–80 characters; the job is at most 20000 characters;
 * shape and color are whitelist-checked (anything unknown becomes the default). Throws a plain-language Error.
 */
export function validateBotProfile(input: { name?: unknown; systemPrompt?: unknown; shape?: unknown; color?: unknown }): BotProfile {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('Please give your Cipher bot a name.');
  if (name.length > MAX_BOT_NAME) throw new Error(`Cipher bot names must be ${MAX_BOT_NAME} characters or fewer.`);
  const systemPrompt = String(input.systemPrompt ?? '');
  if (systemPrompt.length > MAX_BOT_JOB) throw new Error(`The job description is too long (max ${MAX_BOT_JOB} characters).`);
  return { name, systemPrompt, shape: normalizeBotShape(input.shape), color: normalizeBotColor(input.color) };
}

/**
 * Map the Cipher bot form (Name + Job + icon shape and color) to the bot's profile fields, as typed. The Job
 * becomes the system prompt. Shared by create and edit; validation happens in validateBotProfile.
 */
export function formToProfile(input: Partial<NewBotForm> | null | undefined): { name: string; systemPrompt: string; shape: BotShape; color: BotColor } {
  return {
    name: String(input?.name ?? ''),
    systemPrompt: String(input?.job ?? '').trim(),
    shape: normalizeBotShape(input?.shape),
    color: normalizeBotColor(input?.color),
  };
}

/**
 * Map the "Create a Cipher bot" form (Name + Job + icon shape and color) to a bot record. The Job becomes the
 * system prompt. Shape and color are whitelist-checked (unknown values become the defaults). File reading starts
 * off; it is turned on later in the bot's settings.
 */
export function toNewBot(input: Partial<NewBotForm> | null | undefined): NewBot {
  const p = formToProfile(input);
  return { name: p.name, systemPrompt: p.systemPrompt, toolsEnabled: false, folderPath: null, shape: p.shape, color: p.color };
}
