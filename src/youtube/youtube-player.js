// YouTube's player objects live in the page world. Expose just the selected
// video's caption metadata, on demand. This script has no extension APIs.
(() => {
  function transcriptInfo(videoId, watch) {
    const page = [watch?.data, document.querySelector('ytd-app')?.data?.response, window.ytInitialData].find(data =>
      data?.currentVideoEndpoint?.watchEndpoint?.videoId === videoId);
    const stack = [page?.contents, page?.engagementPanels];
    let legacy, panel;
    while (stack.length) {
      const item = stack.pop();
      if (!item || typeof item !== 'object') continue;
      const command = item.updateEngagementPanelContentCommand;
      if (command?.contentSourcePanelIdentifier?.tag === 'PAmodern_transcript_view' && command.globalConfiguration?.params) {
        panel = { panelId: 'PAmodern_transcript_view', params: command.globalConfiguration.params };
        break;
      }
      if (item.getTranscriptEndpoint?.params) legacy = { params: item.getTranscriptEndpoint.params };
      stack.push(...Object.values(item));
    }
    const request = panel || legacy;
    const client = window.ytcfg?.get?.('INNERTUBE_CONTEXT')?.client;
    if (!request || !client) return null;
    const { clientName, clientVersion, hl, gl, visitorData } = client;
    return { ...request, context: { client: { clientName, clientVersion, hl, gl, visitorData } } };
  }

  function read(videoId, transcript) {
    const watch = document.querySelector('ytd-watch-flexy[video-id="' + CSS.escape(videoId) + '"]');
    const player = document.querySelector('ytd-reel-video-renderer[is-active] .html5-video-player') ||
      document.querySelector('#movie_player, .html5-video-player');
    const responses = [player?.getPlayerResponse?.(), watch?.playerData, window.ytInitialPlayerResponse]
      .filter(response => response?.videoDetails?.videoId === videoId);
    const response = responses.find(r => r.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) || responses[0];
    const renderer = response?.captions?.playerCaptionsTracklistRenderer;
    const tracks = renderer?.captionTracks || [];
    const playerVideoId = player?.getVideoData?.()?.video_id;
    const selected = playerVideoId === videoId ? player.getOption?.('captions', 'track') : null;
    const audio = renderer?.audioTracks?.[renderer.defaultAudioTrackIndex ?? 0];
    const track = tracks.find(t => t.vssId && t.vssId === selected?.vssId) ||
      tracks.find(t => t.languageCode === selected?.languageCode && t.kind === selected?.kind) ||
      tracks[audio?.defaultCaptionTrackIndex] || tracks[audio?.captionTrackIndices?.[0]] || tracks[0];
    const style = player?.getSubtitlesUserSettings?.();
    return {
      playerVideoId, captionsOn: player?.isSubtitlesOn?.(),
      appearance: style && { color: style.color, background: style.background, backgroundOpacity: style.backgroundOpacity },
      live: Boolean(response?.videoDetails?.isLive || response?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow),
      track: track && { key: track.vssId || track.languageCode + ':' + (track.kind || ''), language: track.languageCode, url: track.baseUrl },
      transcript: transcript ? transcriptInfo(videoId, watch) : null,
    };
  }

  document.addEventListener('pdf-copy-read-player', event => {
    try {
      const { videoId, transcript } = JSON.parse(event.detail);
      if (!/^[\w-]{11}$/.test(videoId)) return;
      const info = read(videoId, transcript);
      document.dispatchEvent(new CustomEvent('pdf-copy-player-info', { detail: JSON.stringify({ videoId, ...info }) }));
    } catch { /* The player can be replaced while YouTube navigates. */ }
  });
})();
