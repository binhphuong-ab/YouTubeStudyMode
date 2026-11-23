/*
 * Runs in the PAGE's JavaScript world (manifest "world": "MAIN") at document_start.
 *
 * Why this file exists:
 *  - YouTube no longer lets outsiders fetch captions directly: /api/timedtext needs a
 *    "pot" proof-of-origin token, and /youtubei/v1/get_transcript answers 400.
 *  - But YouTube's OWN code still loads transcripts fine (via /youtubei/v1/get_panel).
 *  - So we wrap window.fetch / XMLHttpRequest before YouTube's scripts run, and copy
 *    every transcript-shaped response we see. The isolated content script then parses it.
 *
 * Talks to content.js through window.postMessage, tagged with source names.
 */
(() => {
  'use strict';
  if (window.__ytltMain) return;
  window.__ytltMain = true;

  const FROM_MAIN = 'ytlt-main';
  const FROM_ISO = 'ytlt-iso';
  const MAX_CACHE = 6;
  const RE_PANEL = /\/youtubei\/v1\/(get_panel|get_transcript)\b/;
  const RE_TIMEDTEXT = /\/api\/timedtext\b/;
  const RE_NEXT = /\/youtubei\/v1\/next\b/; // watch-page data (has chapters) on in-app navigation

  const cache = [];

  const currentVideoId = () => {
    try {
      return location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
    } catch {
      return null;
    }
  };

  const post = (msg) => window.postMessage({ source: FROM_MAIN, ...msg }, location.origin);

  // ---- chapters (caption files don't carry them; the watch-page data does) ----
  const chaptersByVideo = new Map();
  function rememberChapters(json) {
    const vid = json?.currentVideoEndpoint?.watchEndpoint?.videoId;
    if (!vid || chaptersByVideo.has(vid)) return;
    const out = [];
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 80) return;
      if (o.chapterRenderer) {
        const c = o.chapterRenderer;
        const title = c.title?.simpleText || (c.title?.runs || []).map((r) => r.text).join('');
        const start = Number(c.timeRangeStartMillis) / 1000;
        if (title && Number.isFinite(start) && !out.some((x) => x.start === start)) out.push({ start, title });
        return;
      }
      for (const k in o) walk(o[k], d + 1);
    })(json, 0);
    if (out.length) chaptersByVideo.set(vid, out.sort((a, b) => a.start - b.start));
  }

  function store(kind, url, text) {
    if (!text || text.length < 20) return;
    if (kind === 'next') {
      try {
        rememberChapters(JSON.parse(text));
      } catch {}
      return;
    }
    let videoId = null;
    const meta = {};
    try {
      if (kind === 'timedtext') {
        const u = new URL(url, location.origin);
        if (u.searchParams.get('tlang')) return; // machine-translated track: not what a learner wants
        videoId = u.searchParams.get('v');
        meta.lang = u.searchParams.get('lang');
        meta.asr = u.searchParams.get('kind') === 'asr';
      } else {
        // get_panel serves many panels; keep only transcript ones.
        if (!/"transcriptSegment(ViewModel|Renderer)"/.test(text)) return;
        const m = text.match(/"videoId":"([\w-]{11})"/);
        videoId = m ? m[1] : currentVideoId();
      }
    } catch {
      return;
    }
    if (!videoId) return;
    if (kind === 'timedtext' && pendingRestore && pendingRestore.videoId === videoId) {
      setTimeout(restoreCaptions, 300); // got what we needed: put CC back how the user had it
    }
    const entry = { kind, videoId, url: String(url), text, meta, ts: Date.now() };
    cache.push(entry);
    while (cache.length > MAX_CACHE) cache.shift();
    post({ type: 'capture', entry });
  }

  const classify = (url) =>
    RE_PANEL.test(url) ? 'panel' : RE_TIMEDTEXT.test(url) ? 'timedtext' : RE_NEXT.test(url) ? 'next' : null;

  // ---- fetch hook: return YouTube's promise untouched, read a clone on the side ----
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const kind = classify(url);
      if (kind) {
        p.then((r) => {
          if (r && r.ok) return r.clone().text();
          // Tell content.js right away so it can move to the next strategy instead of waiting.
          if (r && kind === 'panel') post({ type: 'requestFailed', kind, url: String(url), status: r.status });
          return '';
        })
          .then((t) => store(kind, url, t))
          .catch(() => {});
      }
    } catch {
      /* never break YouTube */
    }
    return p;
  };

  // ---- XHR hook (older player builds use XHR for captions) ----
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__ytltUrl = String(url);
    } catch {}
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      const kind = this.__ytltUrl && classify(this.__ytltUrl);
      if (kind) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') store(kind, this.__ytltUrl, this.responseText);
            else if (this.responseType === 'json' && this.response) store(kind, this.__ytltUrl, JSON.stringify(this.response));
          } catch {}
        });
      }
    } catch {}
    return xhrSend.apply(this, arguments);
  };

  // ---------------------------------------------------------------------------
  // Focus mode puts an empty, see-through layer of ours (#ytlt-focus) in full screen; older builds
  // used <html>. YouTube's own code would read either as "video full screen" (m.youtube rotates to
  // landscape and blows up the player), so hide it from page scripts. Real video full screen
  // (fullscreenElement = the player) is untouched. content.js runs in an isolated world and still
  // sees the true value.
  // ---------------------------------------------------------------------------
  (() => {
    const root = () => document.documentElement;
    const ours = (el) => !!el && (el === root() || el.id === 'ytlt-focus');
    for (const prop of ['fullscreenElement', 'webkitFullscreenElement', 'mozFullScreenElement']) {
      const d = Object.getOwnPropertyDescriptor(Document.prototype, prop);
      if (!d?.get) continue;
      Object.defineProperty(Document.prototype, prop, {
        configurable: true,
        enumerable: d.enumerable,
        get() {
          const el = d.get.call(this);
          return ours(el) ? null : el;
        },
      });
    }
    const fsd = Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreen');
    if (fsd?.get) {
      Object.defineProperty(Document.prototype, 'fullscreen', {
        configurable: true,
        enumerable: fsd.enumerable,
        get() {
          return !!this.fullscreenElement;
        },
      });
    }
    // Swallow the change events for page full screen, entering and leaving. Window + capture
    // phase, registered before any YouTube script, so nothing of theirs sees them.
    // (:fullscreen is a CSS check, so it reports the real state despite the getters above.)
    let pageFs = false;
    const onChange = (e) => {
      let nowPage = false;
      try {
        nowPage = root().matches(':fullscreen') || !!document.querySelector('#ytlt-focus:fullscreen');
      } catch {}
      if (nowPage || pageFs) {
        e.stopImmediatePropagation();
        post({ type: 'pageFullscreen', on: nowPage });
      }
      pageFs = nowPage;
    };
    for (const t of ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange']) window.addEventListener(t, onChange, true);
  })();

  // ---------------------------------------------------------------------------
  // Requests from content.js
  // ---------------------------------------------------------------------------
  const player = () => document.getElementById('movie_player');

  function playerInfo() {
    const pr = player()?.getPlayerResponse?.();
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return {
      videoId: pr?.videoDetails?.videoId || null,
      tracks: tracks.map((t) => ({
        languageCode: t.languageCode,
        kind: t.kind || '',
        name: t.name?.simpleText || t.name?.runs?.map((r) => r.text).join('') || t.languageCode,
      })),
    };
  }

  function findKey(obj, key, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 60) return null;
    if (key in obj) return obj[key];
    for (const v of Object.values(obj)) {
      const r = findKey(v, key, depth + 1);
      if (r) return r;
    }
    return null;
  }

  // Old-style transcript API. Rejected for many users today, kept as a fallback.
  async function classicTranscript(videoId) {
    const cfg = window.ytcfg?.data_ || {};
    const candidates = [
      window.ytInitialData,
      document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]')?.data,
    ];
    let params = null;
    for (const c of candidates) {
      const p = findKey(c, 'getTranscriptEndpoint')?.params;
      if (!p) continue;
      try {
        if (atob(decodeURIComponent(p)).includes(videoId)) {
          params = p;
          break;
        }
      } catch {}
    }
    if (!params) params = btoa('\n\x0b' + videoId);
    // Goes through our own fetch hook, so a good answer lands in the cache automatically.
    const r = await fetch('/youtubei/v1/get_transcript?prettyPrint=false', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Youtube-Client-Name': String(cfg.INNERTUBE_CONTEXT_CLIENT_NAME || 1),
        'X-Youtube-Client-Version': String(cfg.INNERTUBE_CLIENT_VERSION || ''),
      },
      body: JSON.stringify({ context: cfg.INNERTUBE_CONTEXT, params }),
    });
    return r.status;
  }

  // Last resort: make the player itself load a caption track (it attaches the pot token),
  // our hook copies the response, then put the user's CC state back.
  let captionRestore = null;
  let pendingRestore = null;
  function restoreCaptions() {
    clearTimeout(captionRestore);
    const r = pendingRestore;
    pendingRestore = null;
    if (r && !r.wasOn) {
      try {
        player()?.unloadModule?.('captions');
      } catch {}
    }
  }
  /**
   * Is CC on right now? Only touch the user's CC state if we are sure it was off.
   * 1) the CC button (desktop always; m.youtube only after the controls have been shown)
   * 2) YouTube's remembered choice in localStorage (set when the user toggles CC)
   * 3) the video's own default (many videos are CAPTIONS_INITIAL_STATE_ON_RECOMMENDED)
   */
  function captionsCurrentlyOn(p) {
    const btn = document.querySelector('.ytp-subtitles-button, .ytmClosedCaptioningButtonButton');
    if (btn) return btn.getAttribute('aria-pressed') === 'true';
    try {
      const raw = localStorage.getItem('yt-player-sticky-caption');
      if (raw) {
        const v = JSON.parse(raw);
        const d = v && 'data' in v ? v.data : v;
        if (d === true || d === 'true') return true;
        if (d === false || d === 'false') return false;
      }
    } catch {}
    try {
      const tl = p.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer;
      const state = tl?.audioTracks?.[0]?.captionsInitialState || tl?.captionsInitialState || '';
      if (/_ON_/.test(state)) return true;
    } catch {}
    return false;
  }

  function triggerCaptions(videoId) {
    const p = player();
    if (!p?.setOption) return false;
    const info = playerInfo();
    if (info.videoId !== videoId || !info.tracks.length) return false;
    // Desktop: .ytp-subtitles-button; m.youtube: .ytmClosedCaptioningButtonButton. (getOption() is no
    // help here: the mobile player reports a track even while CC is off.) No button → assume off.
    const wasOn = captionsCurrentlyOn(p);
    const pick =
      info.tracks.find((t) => t.languageCode.startsWith('en') && t.kind !== 'asr') ||
      info.tracks.find((t) => t.languageCode.startsWith('en')) ||
      info.tracks.find((t) => t.kind !== 'asr') ||
      info.tracks[0];
    try {
      p.loadModule?.('captions');
      p.setOption('captions', 'track', { languageCode: pick.languageCode, kind: pick.kind || undefined });
    } catch {
      return false;
    }
    pendingRestore = { videoId, wasOn };
    clearTimeout(captionRestore);
    captionRestore = setTimeout(restoreCaptions, 8000); // safety net if no file ever arrives
    return true;
  }

  function hidePanels() {
    document
      .querySelectorAll('ytd-engagement-panel-section-list-renderer[target-id*="transcript"]')
      .forEach((el) => {
        try {
          if (el.visibility && el.visibility !== 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN') {
            el.visibility = 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN';
          }
        } catch {}
      });
    return true;
  }

  /**
   * Open a /watch URL the way YouTube's own links do (no page reload), for the Saved list in
   * saved.js. The router listens for `yt-navigate` on ytd-app; the detail must be created in this
   * world, which is why the isolated world asks here. Falls back to a normal page load.
   */
  function navigate(url) {
    const u = new URL(url, location.origin);
    const videoId = u.searchParams.get('v');
    const app = document.querySelector('ytd-app');
    if (u.origin !== location.origin || u.pathname !== '/watch' || !videoId) return false;
    if (!app) {
      location.href = u.href;
      return true;
    }
    const watchEndpoint = { videoId };
    const list = u.searchParams.get('list');
    if (list) watchEndpoint.playlistId = list;
    const endpoint = {
      commandMetadata: { webCommandMetadata: { url: u.pathname + u.search, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832 } },
      watchEndpoint,
    };
    app.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint } }));
    return true;
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.source !== FROM_ISO) return;
    const { reqId, type, payload = {} } = e.data;
    let result = null;
    let error = null;
    try {
      if (type === 'getCache') result = cache.slice();
      else if (type === 'playerInfo') result = playerInfo();
      else if (type === 'classicTranscript') result = await classicTranscript(payload.videoId);
      else if (type === 'triggerCaptions') result = triggerCaptions(payload.videoId);
      else if (type === 'hidePanels') result = hidePanels();
      else if (type === 'navigate') result = navigate(payload.url);
      else if (type === 'getChapters') {
        rememberChapters(window.ytInitialData);
        result = chaptersByVideo.get(payload.videoId) || [];
      }
      else error = 'unknown request ' + type;
    } catch (err) {
      error = String(err?.message || err);
    }
    post({ type: 'reply', reqId, result, error });
  });
})();
