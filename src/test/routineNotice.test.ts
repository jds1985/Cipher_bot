import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  RoutineNotifier, routineNoticeContent, routineOutcome, shouldShowRoutineNotice,
  type NoticeWindowState, type NotificationLike, type RoutineNotifierDeps,
} from '../main/routineNotice';

const shown: NoticeWindowState = { visible: true, focused: true, minimized: false };

test('when to show: hidden in the tray, minimized, unfocused or another chat open → show; watching that chat → skip', () => {
  assert.equal(shouldShowRoutineNotice(null, null, 1), true, 'no window at all');
  assert.equal(shouldShowRoutineNotice({ ...shown, visible: false }, 1, 1), true, 'hidden in the tray');
  assert.equal(shouldShowRoutineNotice({ ...shown, minimized: true }, 1, 1), true, 'minimized');
  assert.equal(shouldShowRoutineNotice({ ...shown, focused: false }, 1, 1), true, 'another app in front');
  assert.equal(shouldShowRoutineNotice(shown, 2, 1), true, 'another bot\'s chat open');
  assert.equal(shouldShowRoutineNotice(shown, null, 1), true, 'a room or settings open');
  assert.equal(shouldShowRoutineNotice(shown, 1, 1), false, 'that bot\'s chat open in the focused window');
});

test('outcome: finished, failed, or none when the turn was stopped (Stop or quitting)', () => {
  assert.equal(routineOutcome({ aborted: false, failed: false }), 'finished');
  assert.equal(routineOutcome({ aborted: false, failed: true }), 'failed');
  assert.equal(routineOutcome({ aborted: true, failed: false }), null);
  assert.equal(routineOutcome({ aborted: true, failed: true }), null);
});

test('text: title "Cipher", body names the bot and finished/failed only', () => {
  assert.deepEqual(routineNoticeContent('finished', 'Planner Pro'), { title: 'Cipher', body: 'Routine finished: Planner Pro' });
  assert.deepEqual(routineNoticeContent('failed', 'Planner Pro'), { title: 'Cipher', body: 'Routine failed: Planner Pro' });
  assert.equal(routineNoticeContent('finished', null).body, 'Routine finished: Cipher bot');
  assert.equal(routineNoticeContent('finished', '  Multi\n line  ').body, 'Routine finished: Multi line');
  assert.ok(routineNoticeContent('finished', 'x'.repeat(200)).body.length <= 'Routine finished: '.length + 60);
});

class FakeNotification implements NotificationLike {
  handlers: Record<string, (() => void)[]> = {};
  shownCount = 0;
  constructor(public opts: { title: string; body: string }) {}
  on(event: 'click' | 'close', listener: () => void) { (this.handlers[event] ??= []).push(listener); return this; }
  show() { this.shownCount++; }
  fire(event: 'click' | 'close') { for (const h of this.handlers[event] ?? []) h(); }
}

function setup(over: Partial<RoutineNotifierDeps> = {}) {
  const created: FakeNotification[] = [];
  const opened: number[] = [];
  const deps: RoutineNotifierDeps = {
    isSupported: () => true,
    create: (o) => { const n = new FakeNotification(o); created.push(n); return n; },
    windowState: () => ({ ...shown, visible: false }),
    openBotId: () => 7,
    botName: (id) => (id === 7 ? 'Planner Pro' : null),
    openBotChat: (id) => { opened.push(id); },
    ...over,
  };
  return { notifier: new RoutineNotifier(deps), created, opened };
}

test('notifier: shows the notice while hidden; clicking it opens that bot\'s chat', () => {
  const { notifier, created, opened } = setup();
  assert.equal(notifier.notify(7, 'finished'), true);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].opts, { title: 'Cipher', body: 'Routine finished: Planner Pro' });
  assert.equal(created[0].shownCount, 1);
  assert.equal(notifier.liveCount, 1, 'kept referenced so the click still works');
  created[0].fire('click');
  assert.deepEqual(opened, [7], 'click target is that bot\'s chat');
  assert.equal(notifier.liveCount, 0);
  assert.equal(notifier.notify(7, 'failed'), true);
  assert.equal(created[1].opts.body, 'Routine failed: Planner Pro');
  created[1].fire('close');
  assert.equal(notifier.liveCount, 0);
});

test('notifier: skips when watching that chat, when stopped, and does nothing (no crash) when unsupported or failing', () => {
  const watching = setup({ windowState: () => shown, openBotId: () => 7 });
  assert.equal(watching.notifier.notify(7, 'finished'), false);
  assert.equal(watching.created.length, 0);
  // Same focused window, but another bot's chat open: show.
  assert.equal(setup({ windowState: () => shown, openBotId: () => 3 }).notifier.notify(7, 'finished'), true);
  const stopped = setup();
  assert.equal(stopped.notifier.notify(7, null), false);
  assert.equal(stopped.created.length, 0);
  const unsupported = setup({ isSupported: () => false });
  assert.equal(unsupported.notifier.notify(7, 'finished'), false);
  assert.equal(unsupported.created.length, 0);
  const broken = setup({ create: () => { throw new Error('no notification service'); } });
  assert.doesNotThrow(() => broken.notifier.notify(7, 'finished'));
  assert.equal(broken.notifier.notify(7, 'finished'), false);
});

test('notifier never sees the prompt or the reply: it only gets the bot id and outcome', () => {
  // The routine prompt and reply never reach the notice: notify() takes (botId, outcome) and the body comes from the name.
  assert.equal(RoutineNotifier.prototype.notify.length, 2);
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.ts'), 'utf8');
  const calls = src.match(/routineNotifier\?\.notify\([^\n]*\)/g) ?? [];
  assert.deepEqual(calls, ['routineNotifier?.notify(botId, routineOutcome({ aborted: controller.signal.aborted, failed }))']);
  // Electron's built-in Notification (OS service), with the existing app icon; nothing else is sent anywhere.
  assert.match(src, /import \{[^}]*\bNotification\b[^}]*\} from 'electron'/);
  assert.match(src, /isSupported: \(\) => Notification\.isSupported\(\)/);
  assert.match(src, /new Notification\(\{ title, body, \.\.\.\(icon\.isEmpty\(\) \? \{\} : \{ icon \}\) \}\)/);
  assert.match(src, /const icon = nativeImage\.createFromPath\(appIconPath\(\)\);/);
  assert.match(src, /openBotChat: \(botId\) => void openBotChatInWindow\(botId\)/);
  assert.match(src, /async function openBotChatInWindow\(botId: number\): Promise<void> \{\s*await showWindow\(\);/);
  assert.match(src, /webContents\.send\('routine:openBot', botId\)/);
  // No notice while quitting.
  assert.match(src, /if \(!quitting\) routineNotifier\?\.notify/);
  const notice = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'routineNotice.ts'), 'utf8');
  assert.doesNotMatch(notice, /fetch\(|http|require\(|from 'electron'/, 'pure module, no network');
});

test('renderer: reports which bot chat is on screen, and a notice click opens that bot\'s chat', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer.ts'), 'utf8');
  assert.match(src, /reportOpenBot\(view === 'chat' && state\.roomId === null \? state\.botId : null\);/);
  assert.match(src, /api\.onOpenBot\(\(botId\) => \{\s*if \(!initDone\) \{ pendingOpenBot = botId; return; \}\s*if \(state\.bots\.some\(\(b\) => b\.id === botId\)\) void selectBot\(botId\);/);
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'preload', 'preload.ts'), 'utf8');
  assert.match(preload, /reportOpenBot: \(botId\) => ipcRenderer\.send\('ui:openBot', botId\)/);
  assert.match(preload, /ipcRenderer\.on\('routine:openBot', listener\)/);
});
