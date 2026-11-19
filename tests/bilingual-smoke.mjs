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
  const cc = () => player.querySelector('.ytp-subtitles-button');
  player.isSubtitlesOn = () => cc()?.getAttribute('aria-pressed') === 'true';
  function switchCC() {
    const on = !player.isSubtitlesOn();
    cc().setAttribute('aria-pressed', String(on));
    player.querySelector('.ytp-caption-window-container').hidden = !on;
  }
  player.addEventListener('click', e => { if (e.target.closest('.ytp-subtitles-button')) switchCC(); });
  document.addEventListener('keydown', e => { if (e.key === 'c') switchCC(); });
  window.changeVideo = id => {
    history.pushState(null, '', '/watch?v=' + id);
    active = response(id);
    video.currentTime = 0;
    window.dispatchEvent(new Event('yt-navigate-finish'));
  };
}
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0}#movie_player{position:relative;height:300px;width:800px}p{padding:10px}
.ytp-right-controls{position:absolute;bottom:0;right:0;text-align:left;line-height:56px}
.ytp-right-controls-left{display:flex;align-items:flex-end}
.ytp-button{width:48px;height:40px;padding:0;border:0;text-align:inherit;line-height:inherit}
.compact .ytp-button{width:36px;height:32px}
.ytp-subtitles-button{display:grid;place-items:center}.ytp-subtitles-button span{line-height:normal}
.ytp-caption-segment{font:italic 600 24px/32px Georgia,serif;color:rgb(195,227,242);background:rgba(15,20,25,.72);text-shadow:1px 1px 2px black}
ytd-comment-view-model,ytd-expander,ytd-comment-renderer{display:block}.clip{overflow:hidden;max-height:20px}
</style>
<div id="movie_player" class="html5-video-player"><video muted preload="auto"></video>
<div class="ytp-caption-window-container" hidden><span class="ytp-caption-segment">Native</span></div>
<div class="ytp-right-controls"><div class="ytp-right-controls-left"><button class="ytp-button">Auto</button>
<button class="ytp-subtitles-button ytp-button" aria-pressed="false"><span>CC</span></button></div></div></div>
<p id="paragraph">A <em>web paragraph</em> with a link.</p><textarea>Editable text</textarea>
<ytd-comment-view-model id="comment"><div>Comment author</div><ytd-expander><div class="clip">
<yt-attributed-string slot="content"><span>Useful <a id="mention" href="#speaker">@speaker</a>!<br>More text <img alt="🙂"></span></yt-attributed-string>
</div><button>Read more</button></ytd-expander><button id="like">Like</button></ytd-comment-view-model>
<div id="replies"></div>
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
  const options = await page(browser.origin + '/src/ui/options.html');
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1';
  await until(() => evaluate(options.session, "document.getElementById('paragraph-enabled').checked"), 'migrated settings');
  assert.equal(await evaluate(options.session, "document.getElementById('youtube-enabled').checked"), true);
  const legacy = await evaluate(options.session, `(async()=>{
    await chrome.storage.local.set({translationSettings:{provider:'google',target:'zh-CN',youtubeEnabled:false}});
    return chrome.runtime.sendMessage({target:'background',type:'translation-settings'});
  })()`);
  assert.equal(legacy.settings.youtubeEnabled, false);
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
  const point = async selector => read(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  const click = async selector => {
    const position = await point(selector);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...position, button: 'left', clickCount: 1 }, session);
  };
  const toggle = '.pdf-copy-caption-toggle', nativeCC = '.ytp-subtitles-button';
  const overlayHidden = () => read("document.querySelector('[data-pdf-copy-translation=youtube]').hidden");
  const pressed = selector => read(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-pressed')`);
  await until(async () => await pressed(toggle) === 'true', 'translation on by default');
  assert.ok(await read("document.querySelector('.ytp-right-controls-left').firstElementChild.matches('.pdf-copy-caption-toggle')"));
  const layouts = await read(`(async () => {
    const button = document.querySelector('.pdf-copy-caption-toggle');
    const icon = button.querySelector('img');
    await icon.decode();
    const cc = document.querySelector('.ytp-subtitles-button');
    const bar = button.parentElement;
    function measure() {
      const b = button.getBoundingClientRect(), i = icon.getBoundingClientRect();
      const c = cc.getBoundingClientRect(), glyph = cc.firstElementChild.getBoundingClientRect();
      return {
        dx: i.x + i.width / 2 - (b.x + b.width / 2),
        dy: i.y + i.height / 2 - (glyph.y + glyph.height / 2),
        sameSlot: b.width === c.width && b.height === c.height,
        size: i.width, square: i.width === i.height,
        hit: document.elementFromPoint(i.x + i.width / 2, i.y + i.height / 2) === button,
      };
    }
    const normal = measure();
    bar.classList.add('compact');
    const compact = measure();
    bar.classList.remove('compact');
    return [normal, compact];
  })()`);
  for (const layout of layouts) {
    assert.ok(Math.abs(layout.dx) <= 0.5 && Math.abs(layout.dy) <= 0.5, JSON.stringify(layout));
    assert.ok(layout.sameSlot && layout.square && layout.hit);
  }
  assert.ok(layouts[1].size > 0 && layouts[1].size < layouts[0].size);
  console.log('PASS: packaged icon loads, scales and stays centered with CC in both toolbar sizes');
  assert.equal(await pressed(nativeCC), 'false');
  assert.equal(await overlayHidden(), true);
  await delay(350);
  assert.equal(trackReads, 0);
  assert.equal(batches().length, 0);
  await click(nativeCC);
  await until(async () => batches().length === 1 && (await row('.pdf-copy-notice span'))?.includes('正在预译'), 'pre-play batch');
  assert.equal(await read("document.querySelector('video').paused"), true);
  assert.equal(await row('.pdf-copy-original'), 'First en line 0.');
  assert.deepEqual(batches()[0].rows.map(row => row.text), Array.from({ length: 15 }, (_, i) => 'First en line ' + i + '.'));
  assert.equal(await read("getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility"), 'hidden');
  console.log('PASS: 45 seconds requested together at entry while paused, with original and loading status');

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

  const hoverShift = async selector => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point(selector) }, session);
    await shift();
  };
  const commentHost = '#comment > [data-pdf-copy-translation=paragraph]';
  await hoverShift('#mention');
  await until(() => read(`document.querySelector('${commentHost}')?.shadowRoot.textContent.includes('段落译文')`), 'whole comment outside clipped expander');
  assert.equal(requests.at(-1).contents, 'Useful @speaker!\nMore text 🙂');
  assert.equal(await read(`document.querySelector('${commentHost}').previousElementSibling.localName`), 'ytd-expander');
  await read("document.querySelector('#like').textContent='Like 2'; document.querySelector('#replies').innerHTML='<ytd-comment-renderer><yt-formatted-string id=content-text>A <b>new reply</b>.</yt-formatted-string></ytd-comment-renderer>'");
  await hoverShift('#replies b');
  await until(() => read("document.querySelector('#replies [data-pdf-copy-translation]')?.shadowRoot.textContent.includes('段落译文')"), 'dynamically loaded reply');
  assert.equal(requests.at(-1).contents, 'A new reply.');
  await hoverShift('#replies b');
  assert.equal(await read("!!document.querySelector('#replies [data-pdf-copy-translation]')"), false);
  const beforeLike = requests.length;
  await hoverShift('#like'); assert.equal(requests.length, beforeLike);
  console.log('PASS: comments and replies translate individually, including inline mentions, line breaks and emoji');

  const stylesMatch = () => read(`(() => {
    const a=document.querySelector('.pdf-copy-original'), b=document.querySelector('.pdf-copy-translated'), n=document.querySelector('.ytp-caption-segment');
    const sa=getComputedStyle(a), sb=getComputedStyle(b), sn=getComputedStyle(n);
    return a.parentElement===b.parentElement && a.nextElementSibling===b && sa.color===sb.color && sb.color===sn.color &&
      sa.font===sb.font && sb.fontSize===sn.fontSize && sb.fontFamily===sn.fontFamily && getComputedStyle(a.parentElement).backgroundColor===sn.backgroundColor;
  })()`);
  await until(stylesMatch, 'native font, colors and shared caption box');
  await read("document.querySelector('.ytp-caption-segment').style.cssText='font-size:29px;color:orange;'");
  await until(stylesMatch, 'native caption style changes');
  await read("const bar=document.querySelector('.ytp-right-controls'); bar.replaceWith(bar.cloneNode(true))");
  await delay(350);
  assert.equal(await read("document.querySelectorAll('.pdf-copy-caption-toggle').length"), 1);
  await click(toggle); await until(overlayHidden, 'translation off');
  assert.equal(await pressed(nativeCC), 'true');
  assert.equal(await pressed(toggle), 'false');
  assert.equal(await read("getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility"), 'visible');
  await until(() => evaluate(options.session, "!document.getElementById('youtube-enabled').checked"), 'toolbar updates open settings');
  assert.ok(await read(`!!document.querySelector('${commentHost}')`));
  await key('keyDown', 'c', 'KeyC', 67); await key('keyUp', 'c', 'KeyC', 67);
  assert.equal(await pressed(nativeCC), 'false');
  await click(toggle); await until(async () => await pressed(toggle) === 'true', 'toggle on with CC off');
  assert.equal(await pressed(nativeCC), 'false');
  await seek(100); await delay(400);
  assert.equal(await overlayHidden(), true);
  assert.equal(batches().length, 1);
  await seek(0); await click(nativeCC); await waitLine('译 First en line 0.');
  assert.equal(batches().length, 1);
  await read("document.querySelector('#comment [slot=content]').textContent='A recycled comment.'");
  await until(() => read(`!document.querySelector('${commentHost}')`), 'recycled comment removes stale translation');
  console.log('PASS: independent CC and translation controls, native C shortcut, cached resume, and matching typography');

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
  await click('.pdf-copy-notice button');
  await waitLine('译 First en line 15.');
  console.log('PASS: silent gaps, cached seek, advance prefetch, error and retry use the right original');

  block(); const beforeSeek = batches().length;
  await seek(120); await until(() => batches().length > beforeSeek, 'distant seek batch');
  assert.equal(batches().at(-1).rows[0].text, 'First en line 40.');
  await click(nativeCC); await until(overlayHidden, 'CC off cancels pending translation');
  release(); await delay(250);
  assert.equal(await overlayHidden(), true);
  assert.equal(await line(), '');
  const beforeResume = batches().length;
  block(); await click(nativeCC);
  await until(() => batches().length > beforeResume, 'CC on resumes at current time');
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
  await read("window.cc=document.querySelector('.ytp-subtitles-button'); cc.remove(); window.apiCC=false; document.querySelector('#movie_player').isSubtitlesOn=()=>window.apiCC; window.dispatchEvent(new Event('yt-page-data-updated'))");
  await until(overlayHidden, 'player API reports CC off without a native button');
  await read("window.apiCC=true; window.dispatchEvent(new Event('yt-page-data-updated'))");
  await waitLine('译 Second sentence.');
  const beforeMissing = requests.length;
  await read("changeVideo('eeeeeeeeee5')");
  await until(async () => (await row('.pdf-copy-notice span'))?.includes('未提供'), 'no captions hint');
  assert.equal(requests.length, beforeMissing);
  await evaluate(options.session, "document.getElementById('youtube-enabled').checked=false; document.querySelector('#settings-form button[type=submit]').click()");
  await until(overlayHidden, 'disabled on open tab');
  assert.equal(await pressed(toggle), 'false');
  assert.equal(await read("getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility"), 'visible');
  await send('Page.reload', {}, session);
  await until(async () => await pressed(toggle) === 'false', 'saved off preference survives reload, toggle still available');
  assert.deepEqual(errors, []);
  assert.deepEqual(browser.events.filter(event => event.method === 'Runtime.exceptionThrown'), []);
  console.log('PASS: both transcript formats, missing captions and disabling on the open page');
} finally {
  release?.();
  await browser.close();
  server.close();
}
