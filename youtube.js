(() => {
  let enabled = false, session, timer, resources, settingsRevision = 0;

  function videoId() {
    const url = new URL(location.href);
    const id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([^/]+)/.exec(url.pathname)?.[1];
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  }
  function startTime() {
    const url = new URL(location.href);
    const value = url.searchParams.get('t') || url.searchParams.get('start') || new URLSearchParams(url.hash.slice(1)).get('t') || '';
    const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/.exec(value);
    return match ? (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000 : 0;
  }
  function current(s) { return s === session && s.id === videoId(); }
  function cancelBatch(s) {
    if (s.job) void webTranslation.cancel('youtube', s.job.requestId);
    s.job = null;
  }
  function clearTrack(s) {
    s.loading?.abort();
    s.loading = null;
    cancelBatch(s);
    s.cues = [];
    s.translations = new Map();
    s.attempted = new Set();
    s.error = '';
    s.failedBatch = null;
  }
  function close() {
    if (!session) return;
    const s = session;
    session = null;
    clearTrack(s);
    s.videoListeners?.abort();
    s.player?.removeAttribute('data-pdf-copy-captions');
    s.overlay?.remove();
  }

  function mount(s, player) {
    if (!s.overlay) {
      s.overlay = document.createElement('div');
      s.overlay.dataset.pdfCopyTranslation = 'youtube';
      s.overlay.setAttribute('translate', 'no');
      s.original = document.createElement('div');
      s.original.className = 'pdf-copy-original';
      s.translated = document.createElement('div');
      s.translated.className = 'pdf-copy-translated';
      s.translated.lang = s.target;
      s.original.dir = s.translated.dir = 'auto';
      s.notice = document.createElement('div');
      s.notice.className = 'pdf-copy-notice';
      s.status = document.createElement('span');
      s.status.setAttribute('role', 'status');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重试';
      retry.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (!event.isTrusted || !current(s)) return;
        s.failedBatch = null;
        s.error = '';
        refresh(true);
      });
      s.retry = retry;
      s.notice.append(s.status, retry);
      s.overlay.append(s.original, s.translated, s.notice);
    }
    if (s.overlay.parentElement !== player) player.append(s.overlay);
  }

  function bindPlayer(s) {
    const player = document.querySelector('ytd-reel-video-renderer[is-active] .html5-video-player') ||
      document.querySelector('#movie_player, .html5-video-player');
    if (s.player !== player) {
      s.player?.removeAttribute('data-pdf-copy-captions');
      s.overlay?.remove();
      s.player = player;
    }
    if (player) mount(s, player);
    const video = player?.querySelector('video.html5-main-video, video');
    if (video === s.video) return;
    s.videoListeners?.abort();
    s.video = video;
    if (!video) return;
    s.videoListeners = new AbortController();
    for (const event of ['timeupdate', 'loadedmetadata', 'seeking', 'seeked', 'ratechange', 'play', 'pause']) {
      video.addEventListener(event, () => tick(s), { signal: s.videoListeners.signal });
    }
  }

  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }
  function paint(s, original, translation, notice, failed = false) {
    if (!s.player || !s.overlay) return;
    s.player.toggleAttribute('data-pdf-copy-captions', Boolean(original));
    setText(s.original, original);
    setText(s.translated, translation);
    setText(s.status, notice);
    if (s.notice.hidden !== !notice) s.notice.hidden = !notice;
    if (s.retry.hidden !== !failed) s.retry.hidden = !failed;
  }

  async function translate(s, batch) {
    const job = { ...batch, requestId: webTranslation.requestId() };
    s.job = job;
    try {
      const texts = s.cues.slice(job.first, job.after).map(cue => cue.text);
      const result = await webTranslation.send('translation-captions', { scope: 'youtube', requestId: job.requestId, texts });
      if (s.job !== job || !current(s)) return;
      result.translations.forEach((text, i) => s.translations.set(job.first + i, text));
    } catch (error) {
      if (s.job !== job || !current(s)) return;
      s.failedBatch = { ...job, message: error.message };
    } finally {
      if (s.job === job) { s.job = null; tick(s); }
    }
  }

  function tick(s) {
    if (!current(s)) return;
    const otherMedia = s.foreignPlayer || s.player?.matches('.ad-showing,.ad-interrupting');
    if (!s.cues.length) { paint(s, '', '', otherMedia ? '' : s.error || '正在读取视频字幕…', Boolean(s.error && !s.live)); return; }
    // Preload the requested video during a pre-roll or a player handoff, using
    // the content timeline even while the <video> element belongs to an ad.
    if (!otherMedia && s.video && (s.video.readyState || s.video.currentTime)) s.contentTime = 1000 * s.video.currentTime;
    const time = s.contentTime ?? s.start;
    const index = youtubeCaptions.cueAtOrAfter(s.cues, time);
    const active = s.cues[index]?.start <= time;
    const batch = youtubeCaptions.nextBatch(s.cues, time, s.translations, s.video?.playbackRate);
    if (batch) {
      const covers = job => job && job.first <= batch.first && batch.first < job.after;
      if (!covers(s.failedBatch) && !covers(s.job)) {
        cancelBatch(s);
        s.failedBatch = null;
        void translate(s, batch);
      }
    }
    const translation = active ? s.translations.get(index) || '' : '';
    if (otherMedia) { paint(s, '', '', ''); return; }
    const error = batch && s.failedBatch?.message;
    const status = error || (s.job ? (translation ? '正在预译后续字幕…' : '正在预译字幕…') : '');
    paint(s, active ? s.cues[index].text : '', translation, status, Boolean(error));
  }

  function probe(s) {
    s.lastProbe = performance.now();
    const info = youtubeSource.metadata(s.id);
    s.foreignPlayer = Boolean(info?.playerVideoId && info.playerVideoId !== s.id);
    s.live = Boolean(info?.live);
    if (s.live) {
      if (s.key !== 'live') clearTrack(s);
      s.key = 'live';
      s.error = '直播尚无未来字幕可供预译。';
      return;
    }
    const track = info?.track;
    const kind = youtubeSource.captionUrl(track?.url, s.id)?.searchParams.get('kind') || '';
    const observed = track ? s.observed.get(track.language + ':' + kind) :
      [...s.observed.values()].at(-1);
    // Allow time for the player and watch-page transcript to arrive on SPA navigation.
    if (!track && (s.cues.length || (!observed && performance.now() - s.opened < 8000))) return;
    const key = track?.key || observed || 'transcript';
    if (s.key !== key) { clearTrack(s); s.key = key; }
    if (s.cues.length || s.loading || (s.error && (!observed || s.attempted.has(observed)))) return;
    s.error = '';
    const controller = new AbortController();
    s.loading = controller;
    youtubeSource.load(s.id, track, observed, s.attempted, controller.signal).then(cues => {
      if (s.loading === controller && current(s)) s.cues = cues;
    }).catch(error => {
      if (s.loading === controller && current(s)) s.error = error.message;
    }).finally(() => {
      if (s.loading === controller) { s.loading = null; tick(s); }
    });
  }

  function refresh(force = false) {
    if (!enabled) return;
    const id = videoId();
    if (session && session.id !== id) close();
    if (!id) return;
    if (!session) {
      session = { id, target: targetLanguage, opened: performance.now(), start: startTime(), observed: new Map(), lastProbe: -Infinity };
      clearTrack(session);
    }
    bindPlayer(session);
    if (force || performance.now() - session.lastProbe >= (session.key ? 2500 : 450)) probe(session);
    tick(session);
  }
  function observeResources(entries) {
    const s = session;
    if (!s) return;
    let changed = false;
    for (const entry of entries.getEntries()) {
      if (!entry.name.includes('/api/timedtext?')) continue;
      const url = youtubeSource.captionUrl(entry.name, s.id);
      if (!url || s.attempted.has(url.href)) continue;
      const key = url.searchParams.get('lang') + ':' + (url.searchParams.get('kind') || '');
      if (s.observed.get(key) === url.href) continue;
      s.observed.set(key, url.href);
      changed = true;
    }
    if (changed) refresh(true);
  }

  let targetLanguage;
  function configure(options) {
    clearInterval(timer);
    resources?.disconnect();
    close();
    enabled = options.youtubeEnabled;
    targetLanguage = options.target;
    if (!enabled) return;
    refresh(true);
    resources = new PerformanceObserver(observeResources);
    resources.observe({ type: 'resource', buffered: true });
    timer = setInterval(refresh, 250);
  }
  for (const event of ['yt-navigate-finish', 'yt-page-data-updated', 'popstate', 'pageshow']) {
    window.addEventListener(event, () => refresh(true), true);
  }
  window.addEventListener('pagehide', () => { clearInterval(timer); resources?.disconnect(); close(); });
  window.addEventListener('pageshow', event => { if (event.persisted && enabled) configure({ youtubeEnabled: true, target: targetLanguage }); });
  webTranslation.onChange(options => { settingsRevision++; configure(options); });
  const revision = settingsRevision;
  webTranslation.options().then(options => { if (settingsRevision === revision) configure(options); }).catch(() => {});
})();
