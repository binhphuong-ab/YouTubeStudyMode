/*
 * Pure functions (no DOM state): turn any YouTube transcript payload into
 *   { segments: [{start, end, text, words?}], chapters: [{start, title}], format }
 * and then group segments into readable "blocks" (whole sentences).
 *
 * Exposed on globalThis.YTLT so content.js (same isolated world) can use them.
 */
(() => {
  'use strict';
  const NS = (globalThis.YTLT = globalThis.YTLT || {});

  const clean = (s) =>
    String(s ?? '')
      .replace(/[​-‍﻿]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  function textOf(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v.simpleText === 'string') return v.simpleText;
    if (typeof v.content === 'string') return v.content;
    if (Array.isArray(v.runs)) return v.runs.map((r) => r.text || '').join('');
    return '';
  }

  function parseClock(str) {
    const parts = String(str || '').trim().split(':');
    if (!parts.length || parts.some((p) => p === '' || isNaN(p))) return NaN;
    return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  /** Depth-first walk; visitor returning false stops descent into that node. */
  function walk(node, visit, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 150) return;
    if (visit(node) === false) return;
    if (Array.isArray(node)) for (const x of node) walk(x, visit, depth + 1);
    else for (const k in node) walk(node[k], visit, depth + 1);
  }

  // ---------------------------------------------------------------------------
  // 1) New transcript panel (/youtubei/v1/get_panel, "PAmodern_transcript_view")
  //    Text lives in content.…itemSectionRenderer[].contents[].macroMarkersPanelItemViewModel
  //    Exact ms timing lives separately in frameworkUpdates → timedMarkersListSyncEntity:
  //    per section, entry 0 = chapter header, entry k+1 = segment k.
  // ---------------------------------------------------------------------------
  function parseModernPanel(json) {
    const sections = [];
    walk(json.content || json, (n) => {
      const isr = n.itemSectionRenderer;
      if (!isr) return;
      const items = (isr.contents || []).map((c) => {
        const vm = c.macroMarkersPanelItemViewModel;
        const tl = vm?.item?.timelineItemViewModel;
        if (!tl) return null;
        const segs = (tl.contentItems || []).map((ci) => ci.transcriptSegmentViewModel).filter(Boolean);
        if (!segs.length) return null;
        return {
          text: segs.map((s) => textOf(s.simpleText ?? s.text)).join(' '),
          stamp: tl.timestamp ?? segs[0].timestamp,
          tap: vm.onTap?.innertubeCommand?.watchEndpoint?.startTimeSeconds,
        };
      });
      if (!items.some(Boolean)) return;
      const ch = isr.header?.macroMarkersPanelItemViewModel?.item?.timelineChapterViewModel;
      sections.push({ title: ch ? clean(textOf(ch.title)) : '', items });
      return false;
    });
    if (!sections.length) return null;

    const syncLists = [];
    walk(json.frameworkUpdates, (n) => {
      if (n.timedMarkersListSyncEntity) {
        syncLists.push(n.timedMarkersListSyncEntity.timedListData?.sections || []);
        return false;
      }
    });
    const syncSecs = syncLists.find((s) => s.length === sections.length) || syncLists[0] || [];

    const segments = [];
    const chapters = [];
    sections.forEach((sec, si) => {
      const list = syncSecs[si]?.timedSyncDataList || [];
      const nItems = sec.items.length;
      const off = list.length === nItems + 1 ? 1 : list.length === nItems ? 0 : -1;
      let firstStart = NaN;
      sec.items.forEach((it, k) => {
        if (!it) return;
        const text = clean(it.text);
        if (!text) return;
        const stampSec = Number.isFinite(it.tap) ? it.tap : parseClock(it.stamp);
        let start = NaN;
        let end = NaN;
        if (off >= 0) {
          const s = list[k + off];
          start = Number(s?.videoTimeMs) / 1000;
          end = Number(s?.endTimeMs) / 1000;
        }
        // Self-check: if the sync entry disagrees with the visible "1:23" label, trust the label.
        if (!Number.isFinite(start) || (Number.isFinite(stampSec) && Math.abs(start - stampSec) > 2.5)) {
          start = stampSec;
          end = NaN;
        }
        if (!Number.isFinite(start)) return;
        if (!Number.isFinite(firstStart)) firstStart = start;
        segments.push({ start, end, text });
      });
      if (sec.title) {
        const hdr = off === 1 ? Number(list[0]?.videoTimeMs) / 1000 : NaN;
        chapters.push({ title: sec.title, start: Number.isFinite(hdr) ? hdr : firstStart });
      }
    });
    return segments.length ? { segments, chapters: chapters.filter((c) => Number.isFinite(c.start)), format: 'panel' } : null;
  }

  // ---------------------------------------------------------------------------
  // 2) Classic transcript panel (/youtubei/v1/get_transcript)
  // ---------------------------------------------------------------------------
  function parseClassic(json) {
    const segments = [];
    const chapters = [];
    walk(json, (n) => {
      if (n.transcriptSegmentRenderer) {
        const s = n.transcriptSegmentRenderer;
        const text = clean(textOf(s.snippet));
        if (text) segments.push({ start: Number(s.startMs) / 1000, end: Number(s.endMs) / 1000, text });
        return false;
      }
      if (n.transcriptSectionHeaderRenderer) {
        const h = n.transcriptSectionHeaderRenderer;
        const title = clean(textOf(h.sectionHeader?.sectionHeaderViewModel?.headline) || textOf(h.snippet));
        if (title) chapters.push({ start: Number(h.startMs) / 1000, title });
        return false;
      }
    });
    return segments.length ? { segments, chapters, format: 'classic' } : null;
  }

  // ---------------------------------------------------------------------------
  // 3) Caption files the player downloads (/api/timedtext) — json3 or XML
  // ---------------------------------------------------------------------------
  function parseJson3(j) {
    const segments = [];
    for (const e of j.events || []) {
      if (!e.segs) continue;
      const t0 = Number(e.tStartMs) || 0;
      const text = clean(e.segs.map((s) => s.utf8 || '').join(''));
      if (!text) continue;
      let words = null;
      // Auto-generated captions carry per-word offsets → real karaoke timing.
      if (e.segs.length > 1 || e.segs.some((s) => s.tOffsetMs)) {
        words = [];
        for (const s of e.segs) {
          const w = clean(s.utf8);
          if (!w) continue;
          const t = (t0 + (Number(s.tOffsetMs) || 0)) / 1000;
          for (const part of w.split(' ')) words.push({ t, w: part });
        }
      }
      segments.push({ start: t0 / 1000, end: (t0 + (Number(e.dDurationMs) || 0)) / 1000, text, words });
    }
    return segments.length ? { segments, chapters: [], format: 'json3' } : null;
  }

  function decodeEntities(s) {
    if (!/&[#\w]+;/.test(s)) return s;
    return new DOMParser().parseFromString(`<!doctype html><body>${s.replace(/</g, '&lt;')}`, 'text/html').body.textContent;
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const segments = [];
    // srv1: <text start="1.2" dur="3">
    for (const n of doc.querySelectorAll('text[start]')) {
      const start = Number(n.getAttribute('start'));
      const t = clean(decodeEntities(n.textContent));
      if (t) segments.push({ start, end: start + Number(n.getAttribute('dur') || 0), text: t });
    }
    // srv3: <p t="1200" d="3000"><s t="0">word</s></p>
    if (!segments.length) {
      for (const p of doc.querySelectorAll('p[t]')) {
        const t0 = Number(p.getAttribute('t'));
        const t = clean(p.textContent);
        if (!t) continue;
        const ss = [...p.querySelectorAll('s')];
        const words = ss.length
          ? ss.flatMap((s) => clean(s.textContent).split(' ').filter(Boolean).map((w) => ({ t: (t0 + Number(s.getAttribute('t') || 0)) / 1000, w })))
          : null;
        segments.push({ start: t0 / 1000, end: (t0 + Number(p.getAttribute('d') || 0)) / 1000, text: t, words });
      }
    }
    return segments.length ? { segments, chapters: [], format: 'xml' } : null;
  }

  /** Normalise: sort, fill/clamp end times, drop junk. */
  function finalize(res) {
    if (!res) return null;
    const segs = res.segments.filter((s) => Number.isFinite(s.start) && s.text).sort((a, b) => a.start - b.start);
    for (let i = 0; i < segs.length; i++) {
      const next = segs[i + 1];
      let end = segs[i].end;
      if (!Number.isFinite(end) || end <= segs[i].start) end = next ? next.start : segs[i].start + 4;
      if (next && end > next.start) end = Math.max(next.start, segs[i].start + 0.05);
      segs[i].end = end;
    }
    res.segments = segs;
    res.chapters = (res.chapters || []).filter((c) => c.title && Number.isFinite(c.start)).sort((a, b) => a.start - b.start);
    return segs.length ? res : null;
  }

  NS.parseCapture = function (entry) {
    const raw = String(entry.text || '').trimStart();
    if (entry.kind === 'timedtext') {
      if (raw.startsWith('{')) return finalize(parseJson3(JSON.parse(raw)));
      if (raw.startsWith('<')) return finalize(parseXml(raw));
      return null;
    }
    const j = JSON.parse(raw);
    return finalize(parseModernPanel(j) || parseClassic(j));
  };

  NS.parseDomRows = function (rows) {
    // rows: [{stamp:"1:23", text:"..."}] scraped from YouTube's own panel (no ms precision)
    const segments = rows
      .map((r) => ({ start: parseClock(r.stamp), end: NaN, text: clean(r.text) }))
      .filter((s) => Number.isFinite(s.start) && s.text);
    return finalize(segments.length ? { segments, chapters: [], format: 'dom' } : null);
  };

  // ---------------------------------------------------------------------------
  // Blocks: what the panel actually shows.
  // join=true  → split the word stream into real sentences (time-interpolated)
  // join=false → one block per original caption line
  // ---------------------------------------------------------------------------
  const SPEAKER = /^(-|–|—|>>+)$/;
  const SOUND_TAG = /^\[[a-z]+\][.,!?]?$/i;
  const END_P = /[.!?…]["'”’)\]]*$/;
  const TITLE_ABBR = /^(mr|mrs|ms|dr|prof|sr|jr|st|mt|vs|etc|gen|col|lt|sgt|capt|gov|sen|rep|rev|vol|fig|approx|inc|ltd|co|corp|dept|e\.g|i\.e|a\.m|p\.m)\.$/i;

  function tokenize(segments) {
    const words = [];
    segments.forEach((s, si) => {
      let list;
      if (s.words && s.words.length) {
        list = s.words.map((w) => ({ w: w.w, t: Math.max(w.t, s.start) }));
      } else {
        // No word timing: spread words across the segment by character position.
        const parts = s.text.split(' ').filter(Boolean);
        const total = s.text.length || 1;
        const dur = Math.max(0, s.end - s.start);
        let off = 0;
        list = parts.map((p) => {
          const t = s.start + dur * (off / total);
          off += p.length + 1;
          return { w: p, t };
        });
      }
      let speakerNext = false;
      for (const tok of list) {
        // "[music]", "[applause]"… sprinkled inside auto-captions hurt readability.
        if (SOUND_TAG.test(tok.w)) continue;
        if (SPEAKER.test(tok.w)) {
          speakerNext = true;
          continue;
        }
        let w = tok.w;
        if (/^>>/.test(w)) {
          w = w.replace(/^>>+/, '');
          speakerNext = true;
          if (!w) continue;
        }
        words.push({ w, t: tok.t, seg: si, sp: speakerNext });
        speakerNext = false;
      }
    });
    for (let i = 1; i < words.length; i++) if (words[i].t < words[i - 1].t) words[i].t = words[i - 1].t;
    return words;
  }

  function endsSentence(word, next) {
    const w = word.w;
    if (!END_P.test(w)) return false;
    if (TITLE_ABBR.test(w) || /^[A-Z]\.$/.test(w)) return false;
    const nextCap = !next || next.sp || /^["'“‘(\[]?[A-Z0-9¿¡]/.test(next.w);
    if (/^(?:[A-Za-z]\.){2,}$/.test(w) || /(\.\.\.|…)["'”’)\]]*$/.test(w)) return nextCap;
    return true;
  }

  function makeBlock(words) {
    return {
      start: words[0].t,
      end: words[words.length - 1].t,
      words: words.map((x) => ({ w: x.w, t: x.t })),
      text: words.map((x) => x.w).join(' '),
      sp: !!words[0].sp,
    };
  }

  NS.buildBlocks = function (segments, chapters, opts = {}) {
    const words = tokenize(segments);
    const blocks = [];
    if (!words.length) return { blocks, chapterMarks: [] };

    if (!opts.join) {
      let cur = [];
      words.forEach((w, i) => {
        cur.push(w);
        const next = words[i + 1];
        if (!next || next.seg !== w.seg || next.sp) {
          blocks.push(makeBlock(cur));
          cur = [];
        }
      });
    } else {
      const punct = words.filter((w) => END_P.test(w.w)).length;
      const chunkMode = words.length > 60 && punct / words.length < 1 / 35; // auto-captions without punctuation
      let cur = [];
      const flush = () => {
        if (cur.length) blocks.push(makeBlock(cur));
        cur = [];
      };
      words.forEach((w, i) => {
        if (w.sp && cur.length) flush();
        cur.push(w);
        const next = words[i + 1];
        if (!next) return;
        const gap = next.t - w.t;
        const segEnd = next.seg !== w.seg;
        if (chunkMode) {
          if ((cur.length >= 7 && gap >= 0.7) || (cur.length >= 14 && segEnd) || cur.length >= 24) flush();
        } else if (
          (endsSentence(w, next) && cur.length >= 3) ||
          (cur.length >= 45 && /[,;:]$/.test(w.w)) ||
          cur.length >= 70 ||
          (gap > 3 && cur.length >= 3)
        ) {
          flush();
        }
      });
      flush();
    }

    const lastEnd = segments[segments.length - 1].end;
    for (let i = 0; i < blocks.length; i++) {
      blocks[i].end = i + 1 < blocks.length ? Math.max(blocks[i + 1].start, blocks[i].start + 0.05) : Math.max(lastEnd, blocks[i].start + 0.05);
    }

    // Chapter headers go before the first block that starts at/after the chapter.
    const chapterMarks = [];
    let bi = 0;
    for (const c of chapters || []) {
      while (bi < blocks.length && blocks[bi].start < c.start - 0.5) bi++;
      chapterMarks.push({ title: c.title, start: c.start, beforeBlock: bi });
    }
    return { blocks, chapterMarks };
  };

  NS.fmtTime = fmtTime;
  NS.parseClock = parseClock;
})();
