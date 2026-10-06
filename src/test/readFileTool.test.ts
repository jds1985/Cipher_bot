import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeToolCall, MAX_FILE_BYTES, readFileInFolder, resolveInsideFolder } from '../main/readFileTool';

// Layout:
//   base/shared/notes.txt, base/shared/sub/inner.md, base/shared/bin.dat, base/shared/big.txt
//   base/shared/latin1.txt (invalid UTF-8), base/shared/link-out -> base/secret.txt
//   base/shared/dir-link-out -> base/, base/shared/link-in -> notes.txt
//   base/shared-evil/x.txt (sibling with common prefix), base/secret.txt
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-sbx-')));
const shared = path.join(base, 'shared');
fs.mkdirSync(path.join(shared, 'sub'), { recursive: true });
fs.mkdirSync(path.join(base, 'shared-evil'));
fs.writeFileSync(path.join(shared, 'notes.txt'), 'hello from notes ✓\n');
fs.writeFileSync(path.join(shared, 'sub', 'inner.md'), '# inner');
fs.writeFileSync(path.join(shared, 'bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
fs.writeFileSync(path.join(shared, 'big.txt'), 'a'.repeat(MAX_FILE_BYTES + 1));
fs.writeFileSync(path.join(shared, 'exact.txt'), 'b'.repeat(MAX_FILE_BYTES));
fs.writeFileSync(path.join(shared, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
fs.writeFileSync(path.join(base, 'secret.txt'), 'TOP SECRET');
fs.writeFileSync(path.join(base, 'shared-evil', 'x.txt'), 'evil');
fs.symlinkSync(path.join(base, 'secret.txt'), path.join(shared, 'link-out'));
fs.symlinkSync(base, path.join(shared, 'dir-link-out'));
fs.symlinkSync('notes.txt', path.join(shared, 'link-in'));

test('reads text files inside the folder (relative and nested)', async () => {
  assert.equal((await readFileInFolder(shared, 'notes.txt')).content, 'hello from notes ✓\n');
  const r = await readFileInFolder(shared, 'sub/inner.md');
  assert.equal(r.content, '# inner');
  assert.equal(r.relPath, path.join('sub', 'inner.md'));
  assert.equal((await readFileInFolder(shared, './sub/../notes.txt')).relPath, 'notes.txt');
  assert.equal((await readFileInFolder(shared, path.join(shared, 'notes.txt'))).relPath, 'notes.txt');
  assert.equal((await readFileInFolder(shared, 'exact.txt')).content.length, MAX_FILE_BYTES);
});

test('follows symlinks that stay inside the folder', async () => {
  const r = await readFileInFolder(shared, 'link-in');
  assert.equal(r.content, 'hello from notes ✓\n');
  assert.equal(r.relPath, 'notes.txt');
});

test('rejects .. traversal, absolute paths and prefix-sibling escapes', async () => {
  for (const p of ['../secret.txt', 'sub/../../secret.txt', path.join(base, 'secret.txt'), '/etc/passwd', '../shared-evil/x.txt', '..']) {
    await assert.rejects(resolveInsideFolder(shared, p), /outside the shared folder/, p);
  }
});

test('rejects symlinks that point outside the folder', async () => {
  await assert.rejects(readFileInFolder(shared, 'link-out'), /outside the shared folder/);
  await assert.rejects(readFileInFolder(shared, 'dir-link-out/secret.txt'), /outside the shared folder/);
});

test('works when the shared folder itself is reached through a symlink', async () => {
  const alias = path.join(base, 'alias');
  fs.symlinkSync(shared, alias);
  assert.equal((await readFileInFolder(alias, 'notes.txt')).content, 'hello from notes ✓\n');
  await assert.rejects(readFileInFolder(alias, '../secret.txt'), /outside the shared folder/);
});

test('rejects big, binary, non-UTF-8, directories, missing files and bad input', async () => {
  await assert.rejects(readFileInFolder(shared, 'big.txt'), /too large/);
  await assert.rejects(readFileInFolder(shared, 'bin.dat'), /binary/);
  await assert.rejects(readFileInFolder(shared, 'latin1.txt'), /not valid UTF-8/);
  await assert.rejects(readFileInFolder(shared, 'sub'), /Not a regular file/);
  await assert.rejects(readFileInFolder(shared, 'nope.txt'), /File not found/);
  await assert.rejects(readFileInFolder(shared, ''), /path is required/);
  await assert.rejects(readFileInFolder(shared, 42), /path is required/);
  await assert.rejects(readFileInFolder(shared, 'a\0b'), /Invalid path/);
  await assert.rejects(readFileInFolder(null, 'notes.txt'), /No folder/);
  await assert.rejects(readFileInFolder(path.join(base, 'gone'), 'notes.txt'), /no longer exists/);
});

test('executeToolCall never throws and reports errors as tool content', async () => {
  const ok = await executeToolCall({ function: { name: 'read_file', arguments: { path: 'notes.txt' } } }, shared);
  assert.equal(ok.ok, true);
  assert.equal(ok.content, 'hello from notes ✓\n');
  const strArgs = await executeToolCall({ function: { name: 'read_file', arguments: '{"path":"sub/inner.md"}' as never } }, shared);
  assert.equal(strArgs.content, '# inner');
  const denied = await executeToolCall({ function: { name: 'read_file', arguments: { path: '../secret.txt' } } }, shared);
  assert.equal(denied.ok, false);
  assert.match(denied.content, /^Error: Access denied/);
  assert.doesNotMatch(denied.content, /TOP SECRET/);
  const unknown = await executeToolCall({ function: { name: 'run_shell', arguments: {} } }, shared);
  assert.equal(unknown.ok, false);
  assert.match(unknown.content, /unknown tool/);
});

test('rejects FIFOs without blocking', { skip: process.platform === 'win32' }, async () => {
  const { execFileSync } = await import('node:child_process');
  execFileSync('mkfifo', [path.join(shared, 'pipe')]);
  await assert.rejects(readFileInFolder(shared, 'pipe'), /Not a regular file/);
});
