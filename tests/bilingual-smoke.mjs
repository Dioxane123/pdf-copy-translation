import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { delay, launchBrowser, until } from './browser-harness.mjs';

const firstVideo = 'aaaaaaaaaa1', secondVideo = 'bbbbbbbbbb2';
// A real, seekable media clock without autoplay, codecs or an external video.
function installFixture() {
  const player = document.querySelector('#movie_player'), video = document.querySelector('video');
  const wav = new Uint8Array(44 + 180 * 8000);
  const header = new DataView(wav.buffer);
  const tag = (at, text) => wav.set(new TextEncoder().encode(text), at);
  tag(0, 'RIFF'); header.setUint32(4, wav.length - 8, true); tag(8, 'WAVEfmt ');
  header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
  header.setUint32(24, 8000, true); header.setUint32(28, 8000, true);
  header.setUint16(32, 1, true); header.setUint16(34, 8, true); tag(36, 'data'); header.setUint32(40, wav.length - 44, true);
  video.src = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  function response(id) {
    if (id === 'eeeeeeeeee5') return { videoDetails: { videoId: id } };
    return { videoDetails: { videoId: id }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { vssId: '.en', languageCode: 'en', baseUrl: '/api/timedtext?v=' + id + '&lang=en' },
      { vssId: '.fr', languageCode: 'fr', baseUrl: '/api/timedtext?v=' + id + '&lang=fr' },
    ] } } };
  }
  window.ytInitialPlayerResponse = response(new URL(location.href).searchParams.get('v'));
  let active = window.ytInitialPlayerResponse;
  player.getPlayerResponse = () => active;
  player.getVideoData = () => ({ video_id: active.videoDetails.videoId });
  player.getOption = () => ({ languageCode: window.captionLanguage || 'en' });
  window.changeVideo = id => {
    history.pushState(null, '', '/watch?v=' + id);
    active = response(id);
    video.currentTime = 0;
    window.dispatchEvent(new Event('yt-navigate-finish'));
  };
}
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0}#movie_player{position:relative;height:300px;width:800px}p{padding:10px}</style>
<div id="movie_player" class="html5-video-player"><video muted preload="auto"></video><div class="ytp-caption-window-container">Native</div></div>
<p id="paragraph">A <em>web paragraph</em> with a link.</p><textarea>Editable text</textarea>
<script>(${installFixture.toString()})();</script>`;

let hold = null, fail = false, trackReads = 0, transcriptReads = 0, panelReads = 0;
const requests = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const contents = JSON.parse(body).messages[1].content;
  const rows = contents.startsWith('[') ? JSON.parse(contents) : null;
  assert.equal(req.headers.authorization, 'Bearer fixture-key');
  requests.push({ contents, rows });
  const status = fail && rows ? 503 : 200;
  if (rows && hold) await hold;
  const text = rows ? JSON.stringify(rows.map(row => ({ id: row.id, text: '译 ' + row.text })).reverse()) : '段落译文';
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await launchBrowser();
const { send, evaluate, page } = browser;
let release;
function block() { hold = new Promise(resolve => { release = () => { hold = null; resolve(); }; }); }
try {
  const options = await page(browser.origin + '/options.html');
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1';
  await until(() => evaluate(options.session, "document.getElementById('paragraph-enabled').checked"), 'migrated settings');
  assert.equal(await evaluate(options.session, "document.getElementById('youtube-enabled').checked"), false);
  await evaluate(options.session, `(() => {
    const el = id => document.getElementById(id);
    el('provider').value = 'model'; el('provider').dispatchEvent(new Event('change'));
    el('base-url').value = ${JSON.stringify(endpoint)}; el('model').value = 'fixture-model';
    el('api-key').value = 'fixture-key'; el('save-password').value = 'fixture-password';
    el('youtube-enabled').checked = true; document.querySelector('#settings-form button[type=submit]').click();
  })()`);
  await until(() => evaluate(options.session, "document.getElementById('message').textContent.includes('已保存')"), 'save');

  const { session } = await page('about:blank');
  const errors = [];
  browser.onEvent(event => {
    if (event.method !== 'Fetch.requestPaused' || event.sessionId !== session) return;
    const url = new URL(event.params.request.url);
    let body = '', type = 'application/json';
    if (url.pathname === '/watch') { body = html; type = 'text/html; charset=utf-8'; }
    if (url.pathname === '/api/timedtext') {
      trackReads++;
      const id = url.searchParams.get('v'), lang = url.searchParams.get('lang');
      if (![ 'cccccccccc3', 'dddddddddd4' ].includes(id)) body = JSON.stringify({ events: Array.from({ length: 56 }, (_, i) => ({
        tStartMs: i * 3000, dDurationMs: 2500, segs: [{ utf8: (id === firstVideo ? 'First' : 'Next') + ' ' + lang + ' line ' + i + '.' }],
      })) });
    }
    if (url.pathname.endsWith('/get_transcript')) {
      transcriptReads++;
      body = JSON.stringify({ actions: [{ transcriptSegmentRenderer: { startMs: '0', endMs: '2000', snippet: { runs: [{ text: 'Transcript fallback.' }] } } }] });
    }
    if (url.pathname.endsWith('/get_panel')) {
      panelReads++;
      assert.equal(JSON.parse(event.params.request.postData).panelId, 'PAmodern_transcript_view');
      body = JSON.stringify({ content: [ { transcriptSegmentViewModel: { timestamp: '0:00', simpleText: 'Modern transcript.' } },
        { transcriptSegmentViewModel: { timestamp: '0:05', simpleText: 'Second sentence.' } } ] });
    }
    void send('Fetch.fulfillRequest', { requestId: event.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: type }], body: Buffer.from(body).toString('base64') }, session).catch(error => errors.push(error.message));
  });
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://www.youtube.com/*' }] }, session);
  block();
  await send('Page.navigate', { url: 'https://www.youtube.com/watch?v=' + firstVideo }, session);
  const read = expression => evaluate(session, expression);
  const row = selector => read(`document.querySelector(${JSON.stringify(selector)})?.textContent`);
  const line = () => row('.pdf-copy-translated');
  const waitLine = text => until(async () => (await line()) === text, text);
  const batches = () => requests.filter(request => request.rows);
  const seek = time => read('document.querySelector("video").currentTime = ' + time);
  await until(async () => batches().length === 1 && (await row('.pdf-copy-notice span'))?.includes('正在预译'), 'pre-play batch');
  assert.equal(await read("document.querySelector('video').paused"), true);
  assert.equal(await row('.pdf-copy-original'), 'First en line 0.');
  assert.deepEqual(batches()[0].rows.map(row => row.text), Array.from({ length: 15 }, (_, i) => 'First en line ' + i + '.'));
  assert.equal(await read("getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility"), 'hidden');
  console.log('PASS: 45 seconds requested together at entry while paused, with original and loading status');

  const point = async selector => read(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  const key = (type, key, code, vk, modifiers = 0) => send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers }, session);
  const shift = async (combo = false) => {
    await key('keyDown', 'Shift', 'ShiftLeft', 16, 8);
    if (combo) { await key('keyDown', 'A', 'KeyA', 65, 8); await key('keyUp', 'A', 'KeyA', 65, 8); }
    await key('keyUp', 'Shift', 'ShiftLeft', 16);
  };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point('#paragraph em') }, session);
  await shift(true); await delay(120); assert.equal(requests.length, 1);
  await shift();
  await until(() => read("document.querySelector('#paragraph [data-pdf-copy-translation]')?.shadowRoot.textContent.includes('段落译文')"), 'paragraph translation');
  assert.equal(requests.at(-1).contents, 'A web paragraph with a link.');
  assert.equal(await read("document.querySelector('#paragraph [data-pdf-copy-translation]').getBoundingClientRect().top >= document.querySelector('#paragraph em').getBoundingClientRect().bottom"), true);
  await shift(); assert.equal(await read("Boolean(document.querySelector('#paragraph [data-pdf-copy-translation]'))"), false);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point('textarea') }, session);
  await shift(); assert.equal(requests.length, 2);
  release(); await waitLine('译 First en line 0.');
  console.log('PASS: bare Shift on nested text translates and collapses, editors and chords are ignored, subtitle request survives');

  await seek(2.7); await waitLine('');
  await seek(6.2); await waitLine('译 First en line 2.');
  assert.equal(batches().length, 1);
  fail = true;
  await seek(33);
  await until(async () => (await row('.pdf-copy-notice span'))?.includes('HTTP 503'), 'visible prefetch failure');
  assert.equal(await line(), '译 First en line 11.');
  await seek(46);
  assert.equal(await row('.pdf-copy-original'), 'First en line 15.');
  fail = false;
  const button = await point('.pdf-copy-notice button');
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...button, button: 'left', clickCount: 1 }, session);
  await waitLine('译 First en line 15.');
  console.log('PASS: silent gaps, cached seek, advance prefetch, error and retry use the right original');

  block(); const beforeSeek = batches().length;
  await seek(120); await until(() => batches().length > beforeSeek, 'distant seek batch');
  assert.equal(batches().at(-1).rows[0].text, 'First en line 40.');
  await read(`changeVideo(${JSON.stringify(secondVideo)})`);
  await until(() => batches().at(-1).rows[0].text === 'Next en line 0.', 'SPA replacement pre-play batch');
  release(); await waitLine('译 Next en line 0.');
  await delay(350); assert.equal(await line(), '译 Next en line 0.');
  await read("window.captionLanguage='fr'; window.dispatchEvent(new Event('yt-page-data-updated'))");
  await waitLine('译 Next fr line 0.');
  console.log('PASS: distant seek, in-flight SPA navigation and native caption-track changes invalidate old results');

  await read(`window.ytInitialData={currentVideoEndpoint:{watchEndpoint:{videoId:'cccccccccc3'}},engagementPanels:[{getTranscriptEndpoint:{params:'fixture'}}]};
    window.ytcfg={get:()=>({client:{clientName:'WEB',clientVersion:'fixture'}})}; changeVideo('cccccccccc3')`);
  await waitLine('译 Transcript fallback.');
  assert.equal(transcriptReads, 1);
  assert.ok(trackReads >= 3);
  await read(`window.ytInitialData={currentVideoEndpoint:{watchEndpoint:{videoId:'dddddddddd4'}},engagementPanels:[
    {updateEngagementPanelContentCommand:{contentSourcePanelIdentifier:{tag:'PAmodern_transcript_view'},globalConfiguration:{params:'panel-fixture'}}}]};
    changeVideo('dddddddddd4')`);
  await waitLine('译 Modern transcript.');
  await seek(5.3); await waitLine('译 Second sentence.');
  assert.equal(panelReads, 1);
  const beforeMissing = requests.length;
  await read("changeVideo('eeeeeeeeee5')");
  await until(async () => (await row('.pdf-copy-notice span'))?.includes('未提供'), 'no captions hint');
  assert.equal(requests.length, beforeMissing);
  await evaluate(options.session, "document.getElementById('youtube-enabled').checked=false; document.querySelector('#settings-form button[type=submit]').click()");
  await until(() => read("!document.querySelector('[data-pdf-copy-translation=youtube]')"), 'disabled on open tab');
  assert.equal(await read("getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility"), 'visible');
  assert.deepEqual(errors, []);
  assert.deepEqual(browser.events.filter(event => event.method === 'Runtime.exceptionThrown'), []);
  console.log('PASS: both transcript formats, missing captions and disabling on the open page');
} finally {
  release?.();
  await browser.close();
  server.close();
}
