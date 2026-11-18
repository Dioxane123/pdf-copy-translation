const youtubeCaptions = (() => {
  const windowMs = 45000;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

  function timedPieces(events) {
    const rows = events.filter(row => Number.isFinite(row?.tStartMs) && row.tStartMs >= 0 &&
      Array.isArray(row.segs) && row.segs.some(seg => typeof seg?.utf8 === 'string' && seg.utf8.trim()))
      .sort((a, b) => a.tStartMs - b.tStartMs);
    const pieces = [];
    for (let i = 0; i < rows.length; i++) {
      const start = rows[i].tStartMs;
      let { dDurationMs, segs } = rows[i];
      if (rows[i + 1]?.tStartMs === start) {
        // Transcript panels can round two different utterances to the same second.
        const lines = new Set();
        const first = i;
        while (rows[i + 1]?.tStartMs === start) i++;
        for (const row of rows.slice(first, i + 1)) {
          lines.add(row.segs.map(seg => seg?.utf8 || '').join('').trim());
          dDurationMs = Math.max(dDurationMs || 0, row.dDurationMs || 0);
        }
        segs = [{ utf8: [...lines].join(' ') }];
      }
      const next = rows[i + 1]?.tStartMs ?? Infinity;
      // The modern transcript panel supplies starts only. Use the next timestamp
      // for normal speech and avoid holding the last line across a long silence.
      const duration = dDurationMs > 0 ? dDurationMs : Number.isFinite(next) ? Math.min(next - start, 9000) : 4000;
      const end = Math.min(next, start + duration);
      const spans = [];
      for (const seg of segs) {
        if (typeof seg?.utf8 !== 'string' || !seg.utf8) continue;
        const previous = spans.at(-1);
        const offset = Number.isFinite(seg.tOffsetMs) ? Math.max(0, seg.tOffsetMs) : previous?.offset ?? 0;
        if (previous && previous.offset >= offset) previous.text += seg.utf8;
        else spans.push({ offset, text: seg.utf8 });
      }
      for (let j = 0; j < spans.length; j++) {
        const from = start + spans[j].offset;
        let to = Math.min(end, start + (spans[j + 1]?.offset ?? Infinity));
        const text = spans[j].text.replace(/\s+/gu, ' ');
        if (spans.length > 1) {
          // A word offset marks its onset. A several-second gap after a short
          // word is a speech pause, even when the ASR display window overlaps it.
          const spoken = Math.max(450, text.trim().length * (cjk.test(text) ? 230 : 70));
          if (to - from - spoken >= 1200) to = from + spoken;
        }
        if (to > from) pieces.push({ start: from, end: to, text, newRow: j === 0 });
      }
    }
    return pieces;
  }

  function spanAt(spans, offset, end) {
    let lo = 0, hi = spans.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (end ? spans[mid].last < offset : spans[mid].last <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  function timeAt(spans, offset, end) {
    const span = spans[spanAt(spans, offset, end)];
    const fraction = Math.min(1, Math.max(0, (offset - span.first) / (span.last - span.first)));
    return Math.round(span.start + fraction * (span.end - span.start));
  }

  function segmentRun(run, segmenter, cues) {
    let text = '';
    const spans = [];
    for (const piece of run) {
      const last = text.slice(-1), first = piece.text[0];
      if (piece.newRow && last && !/[\s([{“‘]/u.test(last) && !/[\s.,;:!?，。！？、）)\]}]/u.test(first) &&
          !((cjk.test(last) || /[。！？、，」』]/u.test(last)) && cjk.test(first))) text += ' ';
      const firstIndex = text.length;
      text += piece.text;
      if (piece.text.trim()) spans.push({ ...piece, first: firstIndex + (piece.text.startsWith(' ') ? 1 : 0),
        last: text.length - (piece.text.endsWith(' ') ? 1 : 0) });
    }
    let sentenceStart = 0;
    for (const sentence of segmenter.segment(text)) {
      const next = sentence.index + sentence.segment.length;
      if (/(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\.\s*$/iu.test(sentence.segment) && /\p{Lu}/u.test(text.charAt(next))) continue;
      const stop = sentence.index + sentence.segment.trimEnd().length;
      const limit = cjk.test(sentence.segment) ? 54 : 132;
      let from = sentenceStart;
      sentenceStart = next;
      while (from < stop) {
        while (from < stop && /\s/u.test(text[from])) from++;
        if (from >= stop) break;
        const start = timeAt(spans, from, false);
        let cut = Math.min(from + limit, stop);
        while (cut > from + 1 && timeAt(spans, cut, true) - start > 9000) cut--;
        if (cut < stop) {
          // Prefer a clause or a caption boundary in long, unpunctuated speech.
          const excerpt = text.slice(from, cut);
          const clause = [...excerpt.matchAll(/[,;:，；、：]\s*/gu)].at(-1);
          const word = [...excerpt.matchAll(/\s+/gu)].at(-1);
          let boundary = spanAt(spans, cut, true);
          while (boundary >= 0 && spans[boundary].first > from + excerpt.length / 2 &&
                 (!spans[boundary].newRow || spans[boundary].first > cut)) boundary--;
          if (clause && clause.index >= excerpt.length / 2) cut = from + clause.index + clause[0].length;
          else if (boundary >= 0 && spans[boundary].first > from + excerpt.length / 2) cut = spans[boundary].first;
          else if (word?.index > 0 && !cjk.test(text[cut - 1])) cut = from + word.index + word[0].length;
          if (cut > from + 1 && /[\uD800-\uDBFF]/u.test(text[cut - 1])) cut--;
        }
        const source = text.slice(from, cut).trimEnd();
        if (source) cues.push({ start, end: Math.max(start + 1, timeAt(spans, from + source.length, true)), text: source });
        from = cut;
      }
    }
  }

  function sentences(events, language) {
    let segmenter;
    try { segmenter = new Intl.Segmenter(language || undefined, { granularity: 'sentence' }); }
    catch { segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' }); }
    const cues = [];
    let run = [];
    for (const piece of timedPieces(events)) {
      if (run.length && piece.start - run.at(-1).end >= 1200) {
        segmentRun(run, segmenter, cues);
        run = [];
      }
      run.push(piece);
    }
    if (run.length) segmentRun(run, segmenter, cues);
    return cues;
  }

  function cueAtOrAfter(cues, time) {
    let lo = 0, hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cues[mid].end <= time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function nextBatch(cues, time, translations, rate = 1) {
    const current = cueAtOrAfter(cues, time);
    let first = current;
    while (first < cues.length && translations.has(first)) {
      first++;
      if (first < cues.length && cues[first].start - time > 15000 * rate) return null;
    }
    if (first === cues.length) return null;
    const until = Math.max(time, cues[first].start) + windowMs;
    let after = first, chars = 0;
    while (after < cues.length && !translations.has(after) && cues[after].start < until &&
           after - first < 128 && chars + cues[after].text.length <= 12000) {
      chars += cues[after++].text.length;
    }
    return { first, after };
  }

  return { sentences, cueAtOrAfter, nextBatch };
})();
