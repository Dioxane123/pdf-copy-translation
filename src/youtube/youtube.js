(() => {
  let options, session, timer, resources, savingSwitch = false, settingsRevision = 0;

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
  function stopRequests(s) {
    s.loading?.abort();
    s.loading = null;
    cancelBatch(s);
  }
  function clearTrack(s) {
    stopRequests(s);
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
    s.view.attach(null);
    clearInterval(timer);
    resources?.disconnect();
    resources = null;
  }

  async function toggle(s) {
    if (savingSwitch || !current(s)) return;
    savingSwitch = true;
    try {
      await webTranslation.send('translation-youtube-enabled', { enabled: !options.youtubeEnabled });
    } catch (error) {
      if (current(s)) s.view.switchError(error.message);
    } finally { savingSwitch = false; }
  }

  function bindPlayer(s) {
    const player = document.querySelector('ytd-reel-video-renderer[is-active] .html5-video-player') ||
      document.querySelector('#movie_player, .html5-video-player');
    if (s.player !== player) {
      s.player = player;
      s.apiCC = undefined;
      s.lastProbe = -Infinity;
    }
    s.view.attach(player);
    const video = player?.querySelector('video.html5-main-video, video');
    if (video === s.video) return;
    s.videoListeners?.abort();
    s.video = video;
    if (!video) return;
    s.videoListeners = new AbortController();
    for (const event of ['timeupdate', 'loadedmetadata', 'seeking', 'seeked', 'ratechange', 'play', 'pause']) {
      video.addEventListener(event, () => tick(s), { signal: s.videoListeners.signal });
    }
    video.textTracks.addEventListener('change', () => refresh(true), { signal: s.videoListeners.signal });
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
    if (!current(s) || !s.active) return;
    const otherMedia = s.foreignPlayer || s.player?.matches('.ad-showing,.ad-interrupting');
    if (!s.cues.length) {
      s.view.paint({ message: otherMedia ? '' : s.error || '正在读取视频字幕…', failed: Boolean(s.error && !s.live) });
      return;
    }
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
    if (otherMedia) { s.view.paint(); return; }
    const error = batch && s.failedBatch?.message;
    const status = error || (s.job ? (translation ? '正在预译后续字幕…' : '正在预译字幕…') : '');
    s.view.paint({ source: active ? s.cues[index].text : '', translated: translation, message: status, failed: Boolean(error), timeline: true });
  }

  function probe(s, info) {
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
    if (!options) return;
    const id = videoId();
    if (session && session.id !== id) close();
    if (!id) return;
    if (!session) {
      const s = { id, opened: performance.now(), start: startTime(), observed: new Map(), lastProbe: -Infinity };
      s.view = createYouTubeCaptionView({
        ccChanged: () => { if (current(s)) refresh(true); },
        toggle: () => toggle(s),
        retry: () => {
          if (!current(s) || !s.active) return;
          s.failedBatch = null;
          s.error = '';
          refresh(true);
        },
      });
      s.view.setLanguage(options.target);
      clearTrack(s);
      session = s;
      timer = setInterval(refresh, 250);
    }
    const s = session;
    bindPlayer(s);
    const native = s.view.nativeCC();
    const due = force || performance.now() - s.lastProbe >= (s.key ? 2500 : 450);
    let info;
    if (s.player && options.youtubeEnabled && native !== false && (due || (native && !s.active))) {
      info = youtubeSource.metadata(s.id);
      s.lastProbe = performance.now();
      s.apiCC = info?.captionsOn;
      s.appearance = info?.appearance;
    }
    const ccOn = native ?? s.apiCC ?? Array.from(s.video?.textTracks || []).some(t => ['captions', 'subtitles'].includes(t.kind) && t.mode === 'showing');
    s.view.setButton(options.youtubeEnabled, ccOn);
    if (!options.youtubeEnabled || !ccOn || !s.player) {
      if (s.active) {
        s.active = false;
        stopRequests(s);
        s.failedBatch = null;
        s.error = '';
        s.view.paint();
        resources?.disconnect();
        resources = null;
      }
      return;
    }
    if (!s.active || due) probe(s, info);
    s.active = true;
    if (!resources) {
      resources = new PerformanceObserver(observeResources);
      resources.observe({ type: 'resource', buffered: true });
    }
    s.view.styleBox(s.appearance);
    tick(s);
  }
  function observeResources(entries) {
    const s = session;
    if (!s?.active) return;
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

  function configure(updated, change) {
    options = updated;
    if (session && change !== 'youtube') {
      clearTrack(session);
      session.view.setLanguage(options.target);
    }
    refresh(true);
  }
  for (const event of ['yt-navigate-finish', 'yt-page-data-updated', 'popstate']) {
    window.addEventListener(event, () => refresh(true), true);
  }
  window.addEventListener('pagehide', close);
  window.addEventListener('pageshow', event => { if (event.persisted) readOptions(true); });
  webTranslation.onChange((updated, change) => { settingsRevision++; configure(updated, change); });
  function readOptions(refresh = false) {
    const revision = settingsRevision;
    webTranslation.options(refresh).then(updated => { if (settingsRevision === revision) configure(updated); }).catch(() => {});
  }
  readOptions();
})();
