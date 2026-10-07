import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatAttachBlock, mergeAttachIntoMessage, readFileForAttach } from '../main/attachFile';
import { MAX_FILE_BYTES } from '../main/readFileTool';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-attach-')));
const shared = path.join(base, 'shared');
fs.mkdirSync(path.join(shared, 'sub'), { recursive: true });
fs.writeFileSync(path.join(shared, 'notes.txt'), 'hello attach\n');
fs.writeFileSync(path.join(shared, 'sub', 'inner.md'), '# nested');
fs.writeFileSync(path.join(base, 'secret.txt'), 'OUTSIDE');
fs.writeFileSync(path.join(shared, 'bin.dat'), Buffer.from([0x00, 0x01]));
fs.writeFileSync(path.join(shared, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 1));
fs.symlinkSync(path.join(base, 'secret.txt'), path.join(shared, 'link-out'));

test('readFileForAttach reads inside folder (relative and absolute dialog path)', async () => {
  const a = await readFileForAttach(shared, 'notes.txt');
  assert.equal(a.content, 'hello attach\n');
  assert.match(a.block, /Attached file: notes\.txt/);
  assert.match(a.block, /hello attach/);
  const abs = await readFileForAttach(shared, path.join(shared, 'sub', 'inner.md'));
  assert.equal(abs.relPath, path.join('sub', 'inner.md'));
  assert.match(abs.block, /inner\.md/);
});

test('attach sandbox rejects .., absolute outside, and symlink escape (same as read_file)', async () => {
  for (const p of ['../secret.txt', 'sub/../../secret.txt', path.join(base, 'secret.txt'), '/etc/passwd']) {
    await assert.rejects(readFileForAttach(shared, p), /outside the shared folder/, p);
  }
  await assert.rejects(readFileForAttach(shared, 'link-out'), /outside the shared folder/);
});

test('attach rejects binary, oversized, and missing folder', async () => {
  await assert.rejects(readFileForAttach(shared, 'bin.dat'), /binary/);
  await assert.rejects(readFileForAttach(shared, 'big.txt'), /too large/);
  await assert.rejects(readFileForAttach(null, 'notes.txt'), /Choose a folder/);
});

test('formatAttachBlock and mergeAttachIntoMessage', () => {
  const block = formatAttachBlock('a.txt', 'body');
  assert.equal(mergeAttachIntoMessage('', block), block);
  assert.equal(mergeAttachIntoMessage('hi', null), 'hi');
  assert.equal(mergeAttachIntoMessage('hi', block), `hi\n\n${block}`);
});
