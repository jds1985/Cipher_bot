import type { NewBot, NewBotForm } from '../shared/types';
import { normalizeBotColor, normalizeBotShape } from './botIcons';

/**
 * Map the "Create a Cipher bot" form (Name + Job + icon shape and color) to a bot record. The Job becomes the
 * system prompt. Shape and color are whitelist-checked (unknown values become the defaults). File reading starts
 * off; it is turned on later in the bot's settings.
 */
export function toNewBot(input: Partial<NewBotForm> | null | undefined): NewBot {
  return {
    name: String(input?.name ?? ''),
    systemPrompt: String(input?.job ?? '').trim(),
    toolsEnabled: false,
    folderPath: null,
    shape: normalizeBotShape(input?.shape),
    color: normalizeBotColor(input?.color),
  };
}
