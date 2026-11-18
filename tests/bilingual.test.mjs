import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInThisContext } from 'node:vm';
import { DEFAULT_TRANSLATION, translateCaptions, validateSettings } from '../translation.mjs';

const source = readFileSync(new URL('../youtube-captions.js', import.meta.url), 'utf8');
const { sentences, cueAtOrAfter, nextBatch } = runInThisContext(source + '\nyoutubeCaptions');
const event = (tStartMs, dDurationMs, text) => ({ tStartMs, dDurationMs, segs: [{ utf8: text }] });
const json = data => new Response(JSON.stringify(data));

test('existing PDF settings survive and automatic YouTube requests are opt-in', () => {
  const legacy = validateSettings({ enabled: true, provider: 'google', target: 'ja' });
  assert.deepEqual([legacy.enabled, legacy.paragraphEnabled, legacy.youtubeEnabled, legacy.target], [true, true, false, 'ja']);
  assert.equal(validateSettings({ ...legacy, enabled: false, youtubeEnabled: true }).youtubeEnabled, true);
});

test('sentences span caption rows, split within rows and retain ASR word timestamps', () => {
  const cues = sentences([
    { tStartMs: 1000, dDurationMs: 5000, segs: [{ utf8: 'This is one.' }, { utf8: ' The second', tOffsetMs: 1500 }] },
    event(3300, 1000, '\n'), event(4000, 2000, 'continues.'),
    event(9000, 1000, 'After silence.'),
  ], 'en');
  assert.deepEqual(cues, [
    { start: 1000, end: 2500, text: 'This is one.' },
    { start: 2500, end: 6000, text: 'The second continues.' },
    { start: 9000, end: 10000, text: 'After silence.' },
  ]);
  assert.equal(cueAtOrAfter(cues, 2499), 0);
  assert.equal(cueAtOrAfter(cues, 2500), 1);
  assert.equal(cueAtOrAfter(cues, 6500), 2);
  assert.equal(cueAtOrAfter(cues, 10000), 3);
});

test('CJK sentences and manual cues with several sentences keep readable text and timing', () => {
  const cues = sentences([event(0, 6000, '雨停了。我们出去'), event(6000, 2000, '走走！')], 'zh');
  assert.deepEqual(cues.map(cue => cue.text), ['雨停了。', '我们出去走走！']);
  assert.equal(cues[1].start, cues[0].end);
  assert.equal(cues[1].end, 8000);
  const manual = sentences([event(4200, 4000, 'Come here. Sit down!')], 'en');
  assert.equal(manual[0].start, 4200);
  assert.equal(manual[1].end, 8200);
  assert.ok(manual[1].start >= manual[0].end);
  const rounded = sentences([event(2000, 0, 'Hi!'), event(2000, 0, 'Yes?'), event(4000, 0, 'Okay.')], 'en');
  assert.deepEqual(rounded.map(c => c.text), ['Hi!', 'Yes?', 'Okay.']);
});

test('long unpunctuated ASR remains bounded without losing or duplicating words', () => {
  const words = Array.from({ length: 160 }, (_, i) => 'word' + i);
  const rows = words.map((word, i) => event(i * 400, 450, word));
  const cues = sentences(rows, 'en');
  assert.ok(cues.length > 5);
  assert.equal(cues.map(cue => cue.text).join(' '), words.join(' '));
  for (const [i, cue] of cues.entries()) {
    assert.ok(cue.end > cue.start && cue.end - cue.start <= 9000);
    if (i) assert.ok(cue.start >= cues[i - 1].end);
  }
});

test('titles before names stay together and timed ASR pauses break unpunctuated speech', () => {
  const manual = sentences([event(0, 4000, 'Meet Dr. Smith. Hello again!')], 'en');
  assert.deepEqual(manual.map(c => c.text), ['Meet Dr. Smith.', 'Hello again!']);
  const words = sentences([{ tStartMs: 0, dDurationMs: 5000,
    segs: [{ utf8: 'finish up' }, { utf8: ' moving on', tOffsetMs: 3500 }] }], 'en');
  assert.deepEqual(words.map(c => c.text), ['finish up', 'moving on']);
  assert.equal(words[1].start, 3500);
  assert.ok(words[0].end < 2000);
});

test('45-second batches prefetch before the buffer runs out, skip cached cues and follow seeks', () => {
  const cues = Array.from({ length: 75 }, (_, i) => ({ start: i * 2000, end: i * 2000 + 1800, text: 'Line.' }));
  const cache = new Map();
  const first = nextBatch(cues, 0, cache);
  assert.deepEqual(first, { first: 0, after: 23 });
  for (let i = first.first; i < first.after; i++) cache.set(i, '译');
  assert.equal(nextBatch(cues, 0, cache), null);
  assert.deepEqual(nextBatch(cues, 32000, cache), { first: 23, after: 46 });
  assert.deepEqual(nextBatch(cues, 129000, cache), { first: 64, after: 75 });
  assert.equal(nextBatch(cues, 150000, cache), null);
  assert.deepEqual(nextBatch(cues.map(c => ({ ...c, start: c.start + 90000, end: c.end + 90000 })), 0, new Map()), first);
});

test('Google sends one POST with a separate q per caption and checks every translation', async () => {
  const texts = ['First.', 'Second?'], settings = { ...DEFAULT_TRANSLATION, target: 'ja' };
  let count = 0;
  const fetchImpl = async (url, init) => {
    count++;
    assert.equal(new URL(url).searchParams.get('tl'), 'ja');
    assert.deepEqual(new URLSearchParams(init.body).getAll('q'), texts);
    assert.equal(init.credentials, 'omit');
    return json([['一。', 'en'], ['二？', 'en']]);
  };
  assert.deepEqual(await translateCaptions({ texts, settings, fetchImpl }), ['一。', '二？']);
  assert.equal(count, 1);
  await assert.rejects(translateCaptions({ texts, settings, fetchImpl: () => json([['一。', 'en']]) }), /逐句对应/);
});

test('one model request retains the shared preset and matches output by ID even if reordered', async () => {
  const settings = validateSettings({ ...DEFAULT_TRANSLATION, provider: 'model', model: 'alias', baseUrl: 'https://example.org/v1',
    target: 'fr', modelPreset: 'deepseek', deepseekOptions: { thinking: 'disabled' }, maxOutputTokens: 800 });
  const texts = ['First.', 'Second?'];
  const options = { texts, settings, apiKey: 'test-only' };
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://example.org/v1/chat/completions');
    const request = JSON.parse(init.body);
    assert.deepEqual(request.thinking, { type: 'disabled' });
    assert.equal(request.max_tokens, 800);
    assert.ok(request.messages[0].content.includes('法语'));
    assert.deepEqual(JSON.parse(request.messages[1].content), texts.map((text, id) => ({ id, text })));
    return json({ choices: [{ message: { content: '[{"id":1,"text":"Deux ?"},{"id":0,"text":"Un."}]' } }] });
  };
  assert.deepEqual(await translateCaptions({ ...options, fetchImpl }), ['Un.', 'Deux ?']);
  for (const content of ['[]', 'oops', '[{"id":0,"text":"A"},{"id":0,"text":"B"}]', '[{"id":1,"text":" "},{"id":0,"text":"B"}]']) {
    await assert.rejects(translateCaptions({ ...options, fetchImpl: () => json({ choices: [{ message: { content } }] }) }), /逐句对应/);
  }
  await assert.rejects(translateCaptions({ ...options, apiKey: null }), /已锁定/);
});
