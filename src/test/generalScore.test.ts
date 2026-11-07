import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const script = path.join(__dirname, '..', '..', 'scripts', 'score_general_v1.py');
const raw = path.join(__dirname, '..', '..', 'scripts', 'fixtures', 'general-v1-fbbe.min.json');

test('general-v1 raw export: identical passes, one full answer, hotel template on eight prompts', () => {
  let out = '';
  try {
    out = execFileSync('python3', [script, raw], { encoding: 'utf8' });
  } catch (err) {
    out = String((err as { stdout?: string }).stdout || '') + String((err as { stderr?: string }).stderr || '');
    assert.fail(out);
  }
  assert.match(out, /trials 40 unique 20 identical_pairs 20 errors 0/);
  assert.match(out, /full=1/);
  assert.match(out, /wrong=12/);
  assert.match(out, /partial=4/);
  assert.match(out, /instruction_miss=3/);
  assert.match(out, /hotel_template=8/);
  assert.match(out, /g01 full/);
  assert.match(out, /g02 wrong hotel_template/);
  assert.match(out, /g04 wrong/);
  assert.match(out, /g15 partial paragraph_echo/);
});
