// Cipher's policy text, shown read-only on the Policy screen (Settings → Policy).
// This is the ONE place to edit it. Every sentence must stay true to the code; see the v1.9 PR for the
// sentence-to-code table. To add your contact details, replace the text of POLICY_CONTACT below.

/** The contact line. Replace "[to be added]" with your contact details. */
export const POLICY_CONTACT = 'Contact: [to be added]';

export interface PolicySection {
  heading: string;
  paragraphs: readonly string[];
}

export const POLICY_TITLE = 'Policy';

export const POLICY_SECTIONS: readonly PolicySection[] = [
  {
    heading: 'Your chats and files stay on this computer, with two exceptions',
    paragraphs: [
      'Cipher Bot keeps your chats and files on this computer, with two exceptions. ' +
        '1) Phone link: if you turn it on, your chats travel between this computer and your phone over your local network as plain HTTP, which is not encrypted. ' +
        '2) Model download: on first launch (or whenever the model is missing), Ollama downloads the model from its online registry. Cipher Bot only asks Ollama for the model by name; your chats are not part of that request.',
      'Your Cipher bots, chats, rooms, routines and settings (except the app lock; see Lock) are saved in one database file, cipher.db, in Cipher Bot\'s user data folder on this computer ' +
        '(usually ~/.config/Cipher on Linux, %APPDATA%\\Cipher on Windows, ~/Library/Application Support/Cipher on macOS). ' +
        'The file is not encrypted: anyone who can open your user account\'s files can read it.',
      'Exported chats and copied messages go only where you put them: a file you choose in the Save dialog, or your clipboard.',
    ],
  },
  {
    heading: 'Files',
    paragraphs: [
      'Cipher Bot reads files only from the folders you choose for a Cipher bot: its read folder and, if you add one, a second folder. With Read files on, that bot can read text files in those folders when it needs to. With Attach, the file you pick from that folder is added to your message.',
      'File contents go to the model on this computer and are saved in that chat\'s history in the database. An attached file\'s text is part of your message, so if Phone link is on, it shows on the phone too.',
      'Second folder: from the plus menu ("Attach second folder…") you can give a Cipher bot one more folder on this computer, separate from its read folder. ' +
        'The folder is on this computer and Cipher Bot never uploads or syncs it; only its location is saved, in cipher.db. That bot can read text files in it only when Read files is on, with the same limits as the read folder, and what it reads is handled like any file it reads (see above). ' +
        'It is not a cloud drive, and there is no email and no login. "Remove second folder" removes it from the bot; your files are not touched.',
      'Rooms, Phone link and routines never read files.',
    ],
  },
  {
    heading: 'The model',
    paragraphs: [
      'Replies come from a model running in Ollama on this computer. Cipher Bot talks to Ollama only at 127.0.0.1 (this computer).',
      'Ollama is separate software that you install. Cipher Bot can\'t control what Ollama does on its own.',
    ],
  },
  {
    heading: 'Phone link',
    paragraphs: [
      'The phone is a window to this desktop. It shows your chats and sends your messages; every reply is made and saved here, on this computer.',
      'Phone link is off each time Cipher Bot starts, until you turn it on in Settings. It keeps running while Cipher Bot is in the tray (but while Cipher Bot is locked it refuses every request; see Lock), and stops when you stop it or quit Cipher Bot.',
      'It is meant for a phone on the same local network; no Cipher Bot server or cloud service is involved. While it is on, Cipher Bot listens on port 17865 on this computer\'s network connections, so any device that can reach this computer can open the pairing page, but only a paired phone can see or send chats. ' +
        'A phone pairs with a code shown on this desktop; each code works once and expires after about 12 minutes. A paired phone stays paired until you stop Phone link or quit Cipher Bot.',
      'Phone link uses plain HTTP, so chats sent between this computer and the phone are not encrypted on your local network. Use it only on a network you trust.',
    ],
  },
  {
    heading: 'Online switch',
    paragraphs: [
      'Online is off unless you turn it on. Turning it on does not enable any feature yet; Cipher Bot works the same either way.',
      'Online off does not mean Cipher Bot never touches the network. The model download and the "Get the engine" button (which opens ollama.com/download in your web browser) happen regardless of the switch, and Phone link uses your local network when you turn it on.',
      'Apart from those, Cipher Bot\'s own code connects only to Ollama on this computer, and the Cipher Bot window is blocked from loading anything from the internet.',
    ],
  },
  {
    heading: 'Routines',
    paragraphs: [
      'A routine sends a saved message to one Cipher bot every day at the time you pick. It runs only on this computer, and only while Cipher Bot is open or in the tray, not after you quit Cipher Bot. If Cipher Bot isn\'t running at that time, or that bot\'s chat is busy replying for the whole minute, that day\'s run is skipped.',
      'Routines don\'t use the internet: the message goes to the model on this computer, like any chat. Routines run with file reading off.',
      'When a routine finishes or fails, Cipher Bot shows a desktop notification (if your system supports them) with the bot\'s name and "finished" or "failed" only; the routine\'s message and the reply are not in it. It goes through your computer\'s own notification system, not the internet, and may stay in that system\'s notification history. There is no notification if that bot\'s chat is already open in front of you, or if you stop the routine.',
    ],
  },
  {
    heading: 'Lock',
    paragraphs: [
      'The app lock is off unless you turn it on in Settings → Lock. When it is on, Cipher Bot locks each time it starts and as soon as its window is closed to the tray, and asks for your passphrase before showing anything again. After 5 wrong tries in a row, Cipher Bot makes you wait before you can try again (the wait resets if Cipher Bot is restarted).',
      'Your passphrase never leaves this computer and is never saved. Cipher Bot keeps only a salted scrypt hash of it, in a small file, lock.json, in Cipher Bot\'s user data folder, separate from cipher.db. There is no account.',
      'The lock does not encrypt anything. It stops someone using the Cipher Bot window and Phone link, but cipher.db and any backup files stay readable by anyone with access to your user account\'s files.',
      'While Cipher Bot is locked, including while it sits locked in the tray, Phone link refuses every request, pairing included, and closes open phone connections; only its page loads, to show "Cipher Bot is locked on the desktop" on the phone. Routines keep running while locked, and their notification (bot name only) still shows. A reply that is still being written when Cipher Bot locks finishes and is saved, but can\'t be read until you unlock.',
      'There is no recovery: Cipher Bot can\'t reset a forgotten passphrase. If you forget it, quit Cipher Bot and delete lock.json from Cipher Bot\'s user data folder. That removes the lock and keeps your chats. Anyone who can change your user account\'s files can do the same, which is another reason the lock is not protection for the files themselves.',
    ],
  },
  {
    heading: 'Backup and restore',
    paragraphs: [
      'Back up (Settings → Backup) saves a copy of cipher.db to a file you choose on this computer. Restore (Settings → Restore) replaces the current database with a backup file you choose. Nothing is uploaded.',
      'A backup is not encrypted and contains all your Cipher bots, chats, rooms, routines and settings. It does not include the lock: restoring never changes whether Cipher Bot is locked or what the passphrase is.',
      'Before restoring, Cipher Bot saves a copy of the current database next to it (cipher.db.before-restore-<date>-<time>), then restarts. Restore turns Online off.',
    ],
  },
  {
    heading: 'Accounts and tracking',
    paragraphs: [
      'Cipher Bot has no account or sign-in. It has no telemetry, analytics, crash reporting or auto-updater, and it does not turn on Electron\'s crash reporter.',
    ],
  },
];
