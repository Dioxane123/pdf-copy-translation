const youtubeSource = (() => {
  function metadata(videoId, transcript = false) {
    let info;
    const receive = event => {
      try {
        const value = JSON.parse(event.detail);
        if (value.videoId === videoId) info = value;
      } catch { /* Ignore unrelated page events. */ }
    };
    document.addEventListener('pdf-copy-player-info', receive);
    try {
      document.dispatchEvent(new CustomEvent('pdf-copy-read-player', { detail: JSON.stringify({ videoId, transcript }) }));
    } finally { document.removeEventListener('pdf-copy-player-info', receive); }
    return info;
  }

  function captionUrl(value, videoId) {
    try {
      const url = new URL(value, location.origin);
      if (url.protocol !== 'https:' || !['www.youtube.com', 'm.youtube.com', 'youtube.com', 'www.youtube-nocookie.com'].includes(url.host) ||
          url.username || url.password || url.pathname !== '/api/timedtext' || url.searchParams.get('v') !== videoId ||
          url.searchParams.has('tlang')) return null;
      url.searchParams.set('fmt', 'json3');
      return url;
    } catch { return null; }
  }

  function trackEvents(body) {
    if (!body.trim()) return [];
    if (!body.trimStart().startsWith('<')) return JSON.parse(body).events || [];
    const doc = new DOMParser().parseFromString(body, 'application/xml');
    return Array.from(doc.querySelectorAll('transcript > text, timedtext > body > p'), cue => {
      if (cue.localName === 'text') return {
        tStartMs: Number(cue.getAttribute('start')) * 1000, dDurationMs: Number(cue.getAttribute('dur')) * 1000,
        segs: [{ utf8: cue.textContent }],
      };
      const segs = Array.from(cue.childNodes, node => ({
        utf8: node.textContent, tOffsetMs: node.hasAttribute?.('t') ? Number(node.getAttribute('t')) : undefined,
      }));
      return { tStartMs: Number(cue.getAttribute('t')), dDurationMs: Number(cue.getAttribute('d')), segs };
    });
  }

  function transcriptEvents(data) {
    const events = [], stack = [data];
    while (stack.length) {
      const item = stack.pop();
      if (!item || typeof item !== 'object') continue;
      const cue = item.transcriptSegmentRenderer || item.transcriptSegmentViewModel;
      if (cue) {
        const text = cue.snippet?.simpleText ?? cue.snippet?.runs?.map(run => run.text).join('') ?? cue.simpleText ?? cue.snippet?.content;
        let start = Number(cue.startMs);
        if (!Number.isFinite(start) && /^\d+(:[0-5]\d){1,2}$/.test(cue.timestamp)) {
          start = cue.timestamp.split(':').reduce((seconds, part) => 60 * seconds + Number(part), 0) * 1000;
        }
        if (Number.isFinite(start) && typeof text === 'string') events.push({ tStartMs: start, dDurationMs: Number(cue.endMs) - start, segs: [{ utf8: text }] });
      } else stack.push(...Object.values(item).reverse());
    }
    return events;
  }

  async function fetchSource(url, init, signal) {
    const response = await fetch(url, {
      ...init, credentials: 'same-origin', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok) throw new Error('YouTube 字幕请求返回 HTTP ' + response.status + '。');
    return response;
  }

  async function load(videoId, track, observed, attempted, signal) {
    let error;
    const urls = new Set([observed, captionUrl(track?.url, videoId)?.href].filter(Boolean));
    for (const url of urls) {
      attempted.add(url);
      try {
        const response = await fetchSource(url, {}, signal);
        const cues = youtubeCaptions.sentences(trackEvents(await response.text()), track?.language);
        if (cues.length) return cues;
      } catch (err) { error = err; }
      signal.throwIfAborted();
    }
    // Some players only supply a usable timedtext URL after native CC is on.
    // The watch page may already offer its timed transcript before playback.
    const transcript = metadata(videoId, true)?.transcript;
    if (transcript?.params) {
      try {
        const panel = transcript.panelId === 'PAmodern_transcript_view';
        const response = await fetchSource('/youtubei/v1/' + (panel ? 'get_panel' : 'get_transcript') + '?prettyPrint=false', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: transcript.context, params: transcript.params, ...(panel ? { panelId: transcript.panelId } : {}) }),
        }, signal);
        const cues = youtubeCaptions.sentences(transcriptEvents(await response.json()), track?.language);
        if (cues.length) return cues;
      } catch (err) { error = err; }
    }
    signal.throwIfAborted();
    if (!track && !observed && !transcript) throw new Error('此视频暂未提供可预译的字幕。');
    const reason = error?.message?.startsWith('YouTube 字幕请求返回 HTTP') ? error.message : '未能读取 YouTube 字幕。';
    throw new Error(reason + '可开启播放器的 CC 字幕后重试。');
  }

  return { metadata, captionUrl, load };
})();
