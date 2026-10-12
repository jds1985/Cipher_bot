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
    heading: 'Your chats and files stay on this computer, with four exceptions',
    paragraphs: [
      'Cipher Bot keeps your chats and files on this computer, with four exceptions. ' +
        '1) Phone link: if you turn it on, your chats travel between this computer and your phone over your local network as plain HTTP, which is not encrypted. ' +
        '2) Model download: on first launch (or whenever the model is missing), Ollama downloads the model from its online registry. Cipher Bot only asks Ollama for the model by name; your chats are not part of that request. ' +
        '3) Web search: only when Online is on, and only after you press Search on the query your Cipher bot shows, that query goes to DuckDuckGo; and only after you choose Open as text on a search result and confirm its address, that one page is downloaded from its site. ' +
        '4) Update check: only when Online is on, about once a day, Cipher Bot asks GitHub (api.github.com) for the latest Cipher Bot release; and only after you choose Download and confirm, that release\'s file is downloaded from GitHub. Nothing else from your chats or files is sent.',
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
      'Images: you can drop a PNG, JPEG, GIF or WebP image (up to 5 MB) from a Cipher bot\'s read folder into its chat, under the same folder rules as Attach. Only its location in that folder is saved with your message; the picture is read from this computer each time it is shown, and never loaded from the internet. The model on this computer gets the file name, not the picture.',
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
      'Online is off unless you turn it on. When it is on, the only new things are web search, opening a search result as text (see Web search) and the update check (see Updates). When it is off, none of these happens, and turning it off stops any search, page download, update check or update download that is on the way and closes any search question on screen, on the desktop and the phone. Only the desktop can turn Online on or off.',
      'Online off does not mean Cipher Bot never touches the network. The model download and the "Get the engine" button (which opens ollama.com/download in your web browser) happen regardless of the switch, and Phone link uses your local network when you turn it on.',
      'Apart from those, web search and the update check, Cipher Bot\'s own code connects only to Ollama on this computer, and the Cipher Bot window is blocked from loading anything from the internet.',
    ],
  },
  {
    heading: 'Memory notes',
    paragraphs: [
      'Each Cipher bot can have a memory note you write in its settings (Edit bot). It is sent to that bot\'s local model with every chat, on this computer, and is saved in cipher.db. Emptying the note deletes it from the database file. Backups include memory notes; restoring one brings them back.',
    ],
  },
  {
    heading: 'Calculator',
    paragraphs: [
      'Cipher bots have a calculator tool for arithmetic. It runs on this computer with its own small parser: it never runs code and has no network access.',
    ],
  },
  {
    heading: 'Web search',
    paragraphs: [
      'When Online is on, a Cipher bot may ask to search the web. It shows you the exact search words first, with Search and Cancel. Nothing is sent unless you press Search; Cancel (or no answer) means no search, and the bot answers without one.',
      'When you press Search, the search words and your computer\'s IP address go to DuckDuckGo (html.duckduckgo.com), which runs the search. That is the only address Cipher Bot\'s own code contacts for search; no account, no API key, no cookies. DuckDuckGo\'s own privacy policy applies to what it receives.',
      'The results (titles, links and short snippets) are saved in that chat on this computer. A result link opens in your web browser only when you click it, and only while Online is on.',
      'Settings shows when the last search was made, and your search history: the search words and times of searches you confirmed, kept only in cipher.db on this computer. Clear search history deletes them for good (the rows are erased from the database file, not just hidden). The search words also stay in the chat, where you can delete them with the chat or by selecting messages.',
      'On Phone link, a search shows the same Search / Cancel card on the phone; only a paired phone can answer it, and only while Cipher Bot is unlocked. The phone can never turn Online on or off. Locking Cipher Bot or turning Online off closes the card everywhere. Routines, rooms and a locked Cipher Bot never search.',
      'Open as text (search results only): Cipher Bot first shows you the page\'s full address and asks. If you confirm, it downloads that one page from its site, so the site sees your computer\'s IP address, like any visit. Only http and https pages on the public internet are opened (never this computer or your local network, checked again on every redirect), only HTML or plain text, at most 1 MB. Cipher Bot keeps only the page\'s text, in the chat: nothing on the page runs, and its images, styles and links are never loaded. Turning Online off stops a download that is on the way.',
      'Links in your Cipher bot\'s replies are shown as text you can click. They open in your web browser only after you confirm the address, only while Online is on, and only for links that came from your search results; nothing opens inside Cipher Bot.',
      'Dropping a saved web page (.html or .htm) onto a chat attaches its readable text only, using the same folder rules as Attach: its scripts never run, and its links and images are never loaded. This happens on this computer and does not need Online.',
    ],
  },
  {
    heading: 'Updates',
    paragraphs: [
      'Only while Online is on, Cipher Bot checks for a newer release at most once a day: it sends one request to GitHub (api.github.com) for the latest release of jds1985/Cipher_bot. GitHub sees your computer\'s IP address, like any visit; nothing from your chats or files is in the request. The time of the last check is saved in cipher.db. With Online off, nothing is sent, not even at startup.',
      'If a newer version exists, Settings shows it. Nothing is downloaded until you choose Download and confirm. Then only that release\'s .deb file is downloaded, from github.com and GitHub\'s own release download server (any other address is refused), its size and, when GitHub lists one, its checksum are checked, and it is saved to your Downloads folder. Cipher Bot never installs it; you open it yourself. Turning Online off stops a check or download that is on the way. The phone can\'t start a check or a download.',
    ],
  },
  {
    heading: 'Quotes, pins, mute and the debug log',
    paragraphs: [
      'Quoting a message saves a copy of the quoted text (up to 500 characters) with your reply, and pinning marks a message; both are kept in cipher.db on this computer. Mute only stops tray notifications for that bot or room.',
      'Export debug log (Settings) saves a text file you choose on this computer: versions, switches, counts and recent error lines, with folder paths and addresses\' queries removed. It never includes your passphrase hash or lock.json, pairing codes, memory notes, search words or folder paths. Chats are included only if you tick "Include chat content". Nothing is sent anywhere.',
    ],
  },
  {
    heading: 'Routines',
    paragraphs: [
      'A routine sends a saved message to one Cipher bot every day at the time you pick. It runs only on this computer, and only while Cipher Bot is open or in the tray, not after you quit Cipher Bot. If Cipher Bot isn\'t running at that time, or that bot\'s chat is busy replying for the whole minute, that day\'s run is skipped.',
      'Routines don\'t use the internet: the message goes to the model on this computer, like any chat. Routines run with file reading off.',
      'When a routine finishes or fails, Cipher Bot shows a desktop notification (if your system supports them) with the bot\'s name and "finished" or "failed" only; the routine\'s message and the reply are not in it. It goes through your computer\'s own notification system, not the internet, and may stay in that system\'s notification history. There is no notification if that bot\'s chat is already open in front of you, if you stop the routine, or if you muted that bot (plus menu → Mute notices). Rooms have no notifications.',
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
      'A backup is not encrypted and contains all your Cipher bots (with their memory notes), chats, rooms, routines, search history and settings. It does not include the lock: restoring never changes whether Cipher Bot is locked or what the passphrase is.',
      'Before restoring, Cipher Bot saves a copy of the current database next to it (cipher.db.before-restore-<date>-<time>), then restarts. Restore turns Online off.',
    ],
  },
  {
    heading: 'Accounts and tracking',
    paragraphs: [
      'Cipher Bot has no account or sign-in. It has no telemetry, analytics, crash reporting or auto-updater (the update check below only tells you about a new release and never installs anything), and it does not turn on Electron\'s crash reporter.',
    ],
  },
];
