import type { NewBot, NewBotForm } from '../shared/types';

/**
 * Map the "Create a Cipher bot" form (Name + Job) to a bot record. The Job becomes the system prompt.
 * File reading starts off; it is turned on later in the bot's settings.
 */
export function toNewBot(input: Partial<NewBotForm> | null | undefined): NewBot {
  return {
    name: String(input?.name ?? ''),
    systemPrompt: String(input?.job ?? '').trim(),
    toolsEnabled: false,
    folderPath: null,
  };
}
