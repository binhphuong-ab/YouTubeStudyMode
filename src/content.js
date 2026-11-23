/*
 * Isolated-world content script: builds the transcript panel in YouTube's right column,
 * decides how to obtain the transcript, and keeps the highlight in sync with the video.
 */
(() => {
  'use strict';
  if (globalThis.__ytltIso) return;
  globalThis.__ytltIso = true;

  const Y = globalThis.YTLT;
  const FROM_MAIN = 'ytlt-main';
  const FROM_ISO = 'ytlt-iso';
  const LEAD = 0.12; // highlight a hair early so the eye arrives before the voice
  const EXTRA_HEIGHT = 110; // px the panel extends below the bottom of the video
  const PRIORITY = { panel: 3, dom: 2, timedtext: 1 };
  // m.youtube.com (phones): different page structure, no transcript panel, touch input.
  const IS_MOBILE = location.hostname === 'm.youtube.com';
  // Focus mode's full-screen layer (see toggleFocus). Declared early: sizePanel / ensureMounted use it.
  let focusLayer = null;
  const inFocus = () => !!focusLayer && document.fullscreenElement === focusLayer;

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  const DEFAULTS = {
    fontSize: 16,
    joinSentences: true,
    wordHighlight: true,
    showTimestamps: true,
    autoScroll: true,
    hideRelated: true,
    autoHideBars: true,
    compactMobile: true, // m.youtube: auto-hide YouTube's top bar + title block
    collapsed: false,
    hideThumbs: true, // Home feed; applied by saved.js (desktop only)
  };
  let settings = { ...DEFAULTS };
  const storage = globalThis.chrome?.storage?.sync;

  function saveSetting(key, value) {
    settings[key] = value;
    try {
      storage?.set({ [key]: value });
    } catch {
      /* extension reloaded; ignore */
    }
    applySettings(key);
  }

  // ---------------------------------------------------------------------------
  // Bridge to main-world.js
  // ---------------------------------------------------------------------------
  const pending = new Map();
  let reqSeq = 0;

  function callMain(type, payload = {}, timeout = 6000) {
    return new Promise((resolve) => {
      const reqId = `${Date.now()}-${++reqSeq}`;
      const timer = setTimeout(() => {
        pending.delete(reqId);
        resolve(null);
      }, timeout);
      pending.set(reqId, (msg) => {
        clearTimeout(timer);
        resolve(msg.error ? null : msg.result);
      });
      window.postMessage({ source: FROM_ISO, reqId, type, payload }, location.origin);
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== FROM_MAIN) return;
    const msg = e.data;
    if (msg.type === 'reply') {
      const fn = pending.get(msg.reqId);
      if (fn) {
        pending.delete(msg.reqId);
        fn(msg);
      }
    } else if (msg.type === 'capture') {
      onCapture(msg.entry);
    } else if (msg.type === 'pageFullscreen') {
      updateFocusButton();
    } else if (msg.type === 'requestFailed') {
      state.lastFail = { url: msg.url, at: Date.now() };
      for (const w of [...waiters]) {
        if (w.kinds.includes('panel')) {
          waiters.delete(w);
          w.resolve(null);
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    videoId: null,
    token: 0,
    status: 'idle', // idle | loading | ready | error
    priority: 0,
    parsed: null,
    badge: '',
    blocks: [],
    chapterMarks: [],
    rows: [],
    activeIdx: -1,
    activeWord: -1,
    loopIdx: -1,
    following: true,
    resumeTimer: 0,
    q: '',
    hits: [],
    hitCur: -1,
    marked: new Set(),
    lastT: -1,
  };

  // ---------------------------------------------------------------------------
  // DOM helpers (no innerHTML: YouTube enforces Trusted Types)
  // ---------------------------------------------------------------------------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const ICONS = {
    notes: 'M14 17H4v2h10v-2zm6-8H4v2h16V9zM4 15h16v-2H4v2zM4 5v2h16V5H4z',
    search:
      'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
    less: 'M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z',
    expand: 'M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z',
    close:
      'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    up: 'M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z',
    down: 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z',
    target:
      'M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.99 8.99 0 0 0 13 3.06V1h-2v2.06A8.99 8.99 0 0 0 3.06 11H1v2h2.06A8.99 8.99 0 0 0 11 20.94V23h2v-2.06A8.99 8.99 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z',
    prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    repeat:
      'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z',
    copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
    fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
    fullscreenExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
    refresh:
      'M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  };
  function icon(name) {
    const NSV = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NSV, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NSV, 'path');
    p.setAttribute('d', ICONS[name]);
    svg.append(p);
    return svg;
  }
  const iconBtn = (name, title, onclick, extra = {}) =>
    h('button', { class: 'btn', title, 'aria-label': title, onclick, ...extra }, icon(name));

  // ---------------------------------------------------------------------------
  // Build the panel
  // ---------------------------------------------------------------------------
  const host = h('div', { id: 'ytlt-host', 'data-mobile': IS_MOBILE ? '1' : null });
  if (IS_MOBILE) document.documentElement.classList.add('ytlt-mobile');
  const root = host.attachShadow({ mode: 'open' });
  root.append(h('style', { text: Y.CSS }));

  const els = {};
  els.badge = h('span', { class: 'badge', hidden: true });
  els.btnSearch = iconBtn('search', 'Search transcript', () => toggleSearch());
  els.btnCollapse = iconBtn('less', 'Collapse', () => saveSetting('collapsed', !settings.collapsed));
  els.btnFocus = iconBtn('fullscreen', 'Focus mode (full screen)', () => toggleFocus());
  els.btnMenu = iconBtn('more', 'Settings', (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  els.bar = h(
    'div',
    { class: 'bar' },
    h('div', { class: 'title' }, icon('notes'), h('span', { text: 'Transcript' }), els.badge),
    els.btnSearch,
    h('button', { class: 'btn txt', title: 'Smaller text', 'aria-label': 'Smaller text', onclick: () => bumpFont(-1) }, 'A−'),
    h('button', { class: 'btn txt', title: 'Larger text', 'aria-label': 'Larger text', onclick: () => bumpFont(1) }, 'A+'),
    IS_MOBILE ? els.btnFocus : null,
    els.btnMenu,
    els.btnCollapse
  );

  els.searchInput = h('input', {
    type: 'search',
    placeholder: 'Search in transcript…',
    'aria-label': 'Search in transcript',
    spellcheck: 'false',
  });
  els.searchCount = h('span', { class: 'count', text: '' });
  els.search = h(
    'div',
    { class: 'search', hidden: true },
    els.searchInput,
    els.searchCount,
    iconBtn('up', 'Previous match (Shift+Enter)', () => stepHit(-1)),
    iconBtn('down', 'Next match (Enter)', () => stepHit(1)),
    iconBtn('close', 'Close search (Esc)', () => toggleSearch(false))
  );

  els.list = h('div', { class: 'list', role: 'list', tabindex: '-1' });
  els.pill = h('button', { class: 'pill', hidden: true, onclick: () => resumeFollow(true) }, icon('target'), 'Back to current');
  els.status = h('div', { class: 'status' });
  els.body = h('div', { class: 'body' }, els.list, els.status, els.pill);

  els.btnLoop = iconBtn('repeat', 'Repeat current sentence (\\)', () => toggleLoop());
  els.hint = h('span', { class: 'hint' });
  els.foot = h(
    'div',
    { class: 'foot' },
    iconBtn('prev', 'Previous sentence ( [ )', () => stepSentence(-1)),
    els.btnLoop,
    iconBtn('next', 'Next sentence ( ] )', () => stepSentence(1)),
    els.hint
  );

  els.menu = h('div', { class: 'menu', hidden: true, role: 'menu' });
  els.panel = h('div', { class: 'panel' }, els.bar, els.search, els.body, els.foot, els.menu);
  root.append(els.panel);

  function setHint(nodes, isToast = false) {
    els.hint.textContent = '';
    els.hint.classList.toggle('toast', isToast);
    els.hint.append(...nodes);
  }
  const defaultHint = () =>
    IS_MOBILE
      ? setHint([])
      : setHint([h('kbd', {}, '['), ' prev · ', h('kbd', {}, ']'), ' next · ', h('kbd', {}, '\\'), ' repeat']);
  let toastTimer = 0;
  function toast(text, ms = 1800) {
    setHint([text], true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(defaultHint, ms);
    // Feedback for keyboard actions ([ ] \) even when the pointer is elsewhere.
    showChrome();
    hideChromeSoon(ms);
  }
  defaultHint();

  // ---------------------------------------------------------------------------
  // Auto-hiding toolbars: visible while the pointer is over the panel, or while
  // the menu / search box is open; fade out shortly after the pointer leaves.
  // ---------------------------------------------------------------------------
  const HIDE_DELAY = 1000;
  let hovering = false;
  let uiShown = false; // set by the two-finger tap (touch screens have no hover)
  let chromeTimer = 0;
  const chromeHeld = () => hovering || uiShown || !els.menu.hidden || !els.search.hidden;
  function showChrome() {
    clearTimeout(chromeTimer);
    els.panel.classList.add('chrome-on');
  }
  function hideChromeSoon(delay = HIDE_DELAY) {
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(() => {
      if (!chromeHeld()) els.panel.classList.remove('chrome-on');
    }, delay);
  }
  // Real hover only. A finger "enters" the panel on every tap, which made the bars flicker in
  // and cover the line being tapped; touch uses the two-finger tap instead (see below).
  els.panel.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'touch') return;
    hovering = true;
    showChrome();
  });
  els.panel.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch') return;
    hovering = false;
    hideChromeSoon();
  });

  // ---------------------------------------------------------------------------
  // Settings menu
  // ---------------------------------------------------------------------------
  const TOGGLES = [
    ['joinSentences', 'Join lines into sentences'],
    ['wordHighlight', 'Karaoke word highlight'],
    ['showTimestamps', 'Show timestamps'],
    ['autoScroll', 'Auto-scroll with video'],
    ['hideRelated', 'Hide recommended videos'],
    ['autoHideBars', 'Auto-hide toolbars'],
    ['hideThumbs', 'Hide thumbnails on Home', 'desktop'],
    ['compactMobile', 'Auto-hide YouTube header & title', 'mobile'],
  ];
  function buildMenu() {
    els.menu.textContent = '';
    for (const [key, label, only] of TOGGLES) {
      if (only === 'mobile' && !IS_MOBILE) continue;
      if (only === 'desktop' && IS_MOBILE) continue;
      els.menu.append(
        h(
          'button',
          {
            class: 'item',
            role: 'menuitemcheckbox',
            'aria-checked': String(!!settings[key]),
            onclick: (e) => {
              e.stopPropagation();
              saveSetting(key, !settings[key]);
              buildMenu();
            },
          },
          h('span', { class: 'lbl', text: label }),
          h('span', { class: 'switch' })
        )
      );
    }
    els.menu.append(
      h('div', { class: 'sep' }),
      h('button', { class: 'item', role: 'menuitem', onclick: () => (closeMenu(), copyTranscript()) }, icon('copy'), h('span', { class: 'lbl', text: 'Copy transcript' })),
      h('button', { class: 'item', role: 'menuitem', onclick: () => (closeMenu(), state.videoId && loadTranscript(state.videoId, true)) }, icon('refresh'), h('span', { class: 'lbl', text: 'Reload transcript' }))
    );
  }
  function toggleMenu() {
    if (els.menu.hidden) {
      buildMenu();
      els.menu.hidden = false;
      els.btnMenu.classList.add('on');
    } else closeMenu();
  }
  function closeMenu() {
    els.menu.hidden = true;
    els.btnMenu.classList.remove('on');
    hideChromeSoon();
  }
  root.addEventListener('click', (e) => {
    if (!els.menu.hidden && !e.composedPath().includes(els.menu)) closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!els.menu.hidden && !e.composedPath().includes(host)) closeMenu();
  });

  function bumpFont(d) {
    saveSetting('fontSize', Math.min(28, Math.max(12, settings.fontSize + d)));
    toast(`Text size ${settings.fontSize}px`);
  }

  function applySettings(changed) {
    host.style.setProperty('--fs', settings.fontSize + 'px');
    els.panel.classList.toggle('no-ts', !settings.showTimestamps);
    els.panel.classList.toggle('collapsed', !!settings.collapsed);
    els.panel.classList.toggle('autohide', !!settings.autoHideBars);
    els.btnCollapse.replaceChildren(icon(settings.collapsed ? 'expand' : 'less'));
    els.btnCollapse.title = settings.collapsed ? 'Expand' : 'Collapse';
    document.documentElement.classList.toggle('ytlt-hide-related', !!settings.hideRelated && !settings.collapsed);
    document.documentElement.classList.toggle('ytlt-compact', IS_MOBILE && !!settings.compactMobile);
    if (changed === 'compactMobile') requestAnimationFrame(sizePanel);
    if (!settings.autoScroll) els.pill.hidden = true;
    if (changed === 'joinSentences' && state.parsed) rebuildBlocks();
    else if (changed === 'wordHighlight' && state.activeIdx >= 0) paintRow(state.activeIdx);
    else if (changed === 'collapsed' || changed === 'fontSize' || changed === 'showTimestamps') {
      sizePanel();
      requestAnimationFrame(() => follow(false));
    }
  }

  // ---------------------------------------------------------------------------
  // Status screens
  // ---------------------------------------------------------------------------
  function showStatus(kind) {
    els.status.textContent = '';
    els.status.hidden = kind === 'ready';
    els.list.hidden = kind !== 'ready';
    if (kind === 'loading') {
      els.status.append(h('div', { class: 'spinner' }), h('div', { text: 'Loading transcript…' }));
    } else if (kind === 'error') {
      els.status.append(
        h('strong', { text: 'No transcript found' }),
        h('div', { class: 'hint', text: 'This video may not have captions. If it does, turn on CC (subtitles) in the player, then press Retry.' }),
        h('button', { onclick: () => state.videoId && loadTranscript(state.videoId, true) }, 'Retry')
      );
    } else if (kind === 'needplay') {
      els.status.append(
        h('strong', { text: 'Press ▶ play to load the transcript' }),
        h('div', { class: 'hint', text: 'On the mobile site, YouTube only downloads captions once the video is playing.' })
      );
    } else if (kind === 'idle') {
      els.status.append(h('div', { text: 'Open a video to see its transcript.' }));
    }
  }

  // ---------------------------------------------------------------------------
  // Getting the transcript
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, ms, step = 200) {
    const until = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > until) return null;
      await sleep(step);
    }
  }

  const waiters = new Set();
  function waitForCapture(videoId, kinds, ms) {
    return new Promise((resolve) => {
      const w = { videoId, kinds, resolve };
      waiters.add(w);
      setTimeout(() => {
        if (waiters.delete(w)) resolve(null);
      }, ms);
    });
  }

  function onCapture(entry) {
    if (!entry || entry.videoId !== state.videoId) return;
    considerCapture(entry);
    for (const w of [...waiters]) {
      if (w.videoId === entry.videoId && w.kinds.includes(entry.kind)) {
        waiters.delete(w);
        w.resolve(entry);
      }
    }
  }

  /** Apply a captured payload if it is for this video and better than what we show. */
  function considerCapture(entry) {
    if (entry.videoId !== state.videoId) return false;
    const pr = PRIORITY[entry.kind] || 0;
    if (state.status === 'ready' && pr <= state.priority) return false;
    let parsed = null;
    try {
      parsed = Y.parseCapture(entry);
    } catch (err) {
      console.debug('[Study Mode] parse failed', err);
    }
    if (!parsed || parsed.segments.length < 2) return false;
    if (entry.kind === 'timedtext' && entry.meta?.asr) parsed.auto = true;
    setTranscript(parsed, pr);
    if (!parsed.chapters.length) addChapters(parsed, entry.videoId);
    return true;
  }

  const flexyVideoId = () => document.querySelector('ytd-watch-flexy')?.getAttribute('video-id');
  const findTranscriptButton = () =>
    document.querySelector('ytd-watch-metadata ytd-video-description-transcript-section-renderer button') ||
    document.querySelector('ytd-video-description-transcript-section-renderer button');

  function scrapeNativeDom() {
    const sel = 'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]';
    const rows = [];
    document.querySelectorAll(`${sel} transcript-segment-view-model, ${sel} ytd-transcript-segment-renderer`).forEach((n) => {
      const stamp = n.querySelector('.ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp')?.textContent;
      const text = n.querySelector('.ytAttributedStringHost, .segment-text, yt-formatted-string')?.textContent;
      if (stamp && text) rows.push({ stamp, text });
    });
    return rows.length > 1 ? Y.parseDomRows(rows) : null;
  }

  const PANELS = 'ytd-engagement-panel-section-list-renderer';
  const isExpanded = (p) => p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
  const expandedPanels = () => new Set([...document.querySelectorAll(PANELS)].filter(isExpanded));

  /** Close transcript panels, plus any panel that only opened because of our click. */
  function closeNativePanels(openBefore) {
    document.querySelectorAll(PANELS).forEach((p) => {
      if (!isExpanded(p)) return;
      const ours = /transcript/.test(p.getAttribute('target-id') || '') || (openBefore && !openBefore.has(p));
      if (ours) p.querySelector('#visibility-button button')?.click();
    });
    callMain('hidePanels', {}, 1500);
    // Keep the ghosting CSS a moment longer so YouTube's close animation is never seen.
    setTimeout(() => document.documentElement.classList.remove('ytlt-loading'), 600);
  }

  async function loadTranscript(videoId, force = false) {
    const token = ++state.token;
    const loadStart = Date.now();
    const stale = () => token !== state.token || state.videoId !== videoId;
    if (force) {
      state.status = 'loading';
      state.priority = 0;
    }
    if (state.status !== 'ready') showStatus('loading');

    // 1) Something already captured? (user's CC was on, or the panel was opened earlier)
    const cached = (await callMain('getCache', {}, 3000)) || [];
    if (stale()) return;
    cached
      .filter((e) => e.videoId === videoId)
      .sort((a, b) => (PRIORITY[b.kind] || 0) - (PRIORITY[a.kind] || 0) || b.ts - a.ts)
      .some((e) => considerCapture(e));
    if (state.status === 'ready' && state.priority >= PRIORITY.panel) return;

    if (IS_MOBILE) return loadMobile(videoId, stale);

    // 2) Ask YouTube to load its own transcript panel (kept invisible by page.css).
    await waitFor(() => flexyVideoId() === videoId, 10000);
    if (stale()) return;
    const btn = await waitFor(findTranscriptButton, 6000);
    if (stale()) return;
    if (btn) {
      const y = window.scrollY;
      const openBefore = expandedPanels();
      const got = waitForCapture(videoId, ['panel'], 10000);
      document.documentElement.classList.add('ytlt-loading');
      btn.click();
      // Opening YouTube's panel can nudge the page; undo that, unless the user scrolled meanwhile.
      let userMoved = false;
      const mark = () => (userMoved = true);
      window.addEventListener('wheel', mark, { passive: true, once: true });
      window.addEventListener('keydown', mark, { once: true });
      const restore = () => !userMoved && window.scrollY !== y && window.scrollTo({ top: y });
      setTimeout(restore, 80);
      setTimeout(restore, 500);
      await got;
      restore();
      setTimeout(restore, 400);
      setTimeout(() => {
        window.removeEventListener('wheel', mark);
        window.removeEventListener('keydown', mark);
      }, 1500);
      if (stale()) return;
      if (state.status !== 'ready' || state.priority < PRIORITY.dom) {
        const dom = await waitFor(scrapeNativeDom, 1500, 300);
        if (dom && !stale()) setTranscript(dom, PRIORITY.dom);
      }
      setTimeout(() => closeNativePanels(openBefore), 200);
      if (state.status === 'ready') return;
    }

    // 3) Classic API (works for some accounts / regions) — pointless if YouTube's own call just failed.
    const youtubeClassicFailed = state.lastFail && state.lastFail.at >= loadStart && /get_transcript/.test(state.lastFail.url);
    if (!youtubeClassicFailed) {
      const classic = waitForCapture(videoId, ['panel'], 6000);
      callMain('classicTranscript', { videoId }, 6000);
      await classic;
      if (stale() || state.status === 'ready') return;
    }

    // 4) Make the player download a caption track and read that. The player ignores this
    //    during ads (and before playback starts), so wait for the real video first.
    await waitFor(() => stale() || state.status === 'ready' || playingContent(), 180000, 400);
    if (stale() || state.status === 'ready') return;
    const tt = waitForCapture(videoId, ['timedtext'], 9000);
    const ok = await callMain('triggerCaptions', { videoId }, 2000);
    if (ok) await tt;
    if (stale() || state.status === 'ready') return;

    state.status = 'error';
    showStatus('error');
  }

  /**
   * m.youtube.com has no "Show transcript" panel. The only reliable source is the caption
   * file the player itself downloads (it signs the request with its pot token), and the
   * player only does that while the video is actually playing.
   */
  async function loadMobile(videoId, stale) {
    const playing = playingContent;
    if (state.status !== 'ready' && !playing()) showStatus('needplay');
    for (;;) {
      if (stale() || state.status === 'ready') return;
      if (playing()) break;
      await sleep(400);
    }
    if (state.status !== 'ready') showStatus('loading');
    // Many videos have CC on by default; the player then fetches captions by itself. Prefer that
    // over switching tracks ourselves.
    await waitForCapture(videoId, ['timedtext'], 3000);
    if (stale() || state.status === 'ready') return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const tt = waitForCapture(videoId, ['timedtext'], 8000);
      const ok = await callMain('triggerCaptions', { videoId }, 2000);
      if (ok) await tt;
      if (stale() || state.status === 'ready') return;
      await sleep(1000);
    }
    state.status = 'error';
    showStatus('error');
  }

  /** Caption files have no chapters; borrow them from the watch-page data. */
  async function addChapters(parsed, videoId) {
    const ch = await callMain('getChapters', { videoId }, 2000);
    if (!ch?.length || state.parsed !== parsed || state.videoId !== videoId) return;
    parsed.chapters = ch;
    rebuildBlocks();
  }

  function setTranscript(parsed, priority) {
    state.parsed = parsed;
    state.priority = priority;
    state.status = 'ready';
    showStatus('ready');
    rebuildBlocks();
    updateBadge();
    // Show the toolbars briefly so it's discoverable that they exist.
    if (IS_MOBILE) mobileHint();
    else {
      showChrome();
      hideChromeSoon(2500);
    }
  }
  // Teach the two-finger tap the first few times a transcript appears.
  async function mobileHint() {
    if (!settings.autoHideBars && !settings.compactMobile) return;
    const local = globalThis.chrome?.storage?.local;
    let n = 0;
    try {
      n = (await local.get({ gestureHints: 0 })).gestureHints;
    } catch {}
    if (n >= 3) return;
    toast('Tap with two fingers to show controls', 4000);
    try {
      await local.set({ gestureHints: n + 1 });
    } catch {}
  }

  async function updateBadge() {
    const vid = state.videoId;
    let auto = !!state.parsed?.auto;
    if (!auto) {
      const info = await callMain('playerInfo', {}, 2000);
      if (vid !== state.videoId) return;
      if (info?.videoId === vid && info.tracks.length) auto = info.tracks.every((t) => t.kind === 'asr');
    }
    els.badge.hidden = !auto;
    els.badge.textContent = auto ? 'Auto-generated' : '';
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function rebuildBlocks() {
    const { segments, chapters } = state.parsed;
    const { blocks, chapterMarks } = Y.buildBlocks(segments, chapters, { join: settings.joinSentences });
    state.blocks = blocks;
    state.chapterMarks = chapterMarks;
    state.loopIdx = -1;
    els.btnLoop.classList.remove('on');
    renderList();
    if (state.q) runSearch(els.searchInput.value, false);
    state.lastT = -1;
    tick(true);
    requestAnimationFrame(() => follow(false));
  }

  function chapterEl(c) {
    return h('div', { class: 'chapter', 'data-t': String(c.start) }, h('span', { text: c.title }), h('span', { text: Y.fmtTime(c.start) }));
  }

  function renderList() {
    // Each chapter gets its own <section>, so its sticky header is pushed away by the next one.
    const frag = document.createDocumentFragment();
    let sec = h('section', { class: 'sec' });
    frag.append(sec);
    const openChapter = (c) => {
      sec = h('section', { class: 'sec' }, chapterEl(c));
      frag.append(sec);
    };
    state.rows = [];
    let ci = 0;
    state.blocks.forEach((b, i) => {
      while (ci < state.chapterMarks.length && state.chapterMarks[ci].beforeBlock <= i) openChapter(state.chapterMarks[ci++]);
      const row = h(
        'div',
        { class: 'row' + (b.sp ? ' sp' : ''), role: 'listitem', 'data-i': String(i) },
        h('span', { class: 'ts', text: Y.fmtTime(b.start) }),
        h('p', { class: 'tx', text: b.text })
      );
      row._mode = 'plain';
      state.rows.push(row);
      sec.append(row);
    });
    while (ci < state.chapterMarks.length) openChapter(state.chapterMarks[ci++]);
    els.list.replaceChildren(frag);
    state.activeIdx = -1;
    state.activeWord = -1;
    state.marked.clear();
  }

  /** Decide what a row's text should look like right now and (re)draw it if needed. */
  function paintRow(i) {
    const row = state.rows[i];
    const b = state.blocks[i];
    if (!row || !b) return;
    const q = state.q;
    const hasHit = q && b.text.toLowerCase().includes(q);
    const karaoke = !hasHit && i === state.activeIdx && settings.wordHighlight;
    const mode = hasHit ? 'hit:' + q : karaoke ? 'words' : 'plain';
    row.classList.toggle('karaoke', karaoke);
    if (row._mode === mode) return;
    row._mode = mode;
    const tx = row.querySelector('.tx');
    if (mode === 'plain') {
      tx.textContent = b.text;
    } else if (mode === 'words') {
      const frag = document.createDocumentFragment();
      b.words.forEach((w, k) => {
        if (k) frag.append(' ');
        frag.append(h('span', { class: 'w', text: w.w }));
      });
      tx.replaceChildren(frag);
      state.activeWord = -1;
    } else {
      const lower = b.text.toLowerCase();
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, at + q.length)) {
        if (at > pos) frag.append(b.text.slice(pos, at));
        frag.append(h('mark', { text: b.text.slice(at, at + q.length) }));
        pos = at + q.length;
      }
      if (pos < b.text.length) frag.append(b.text.slice(pos));
      tx.replaceChildren(frag);
    }
  }

  // ---------------------------------------------------------------------------
  // Playback sync
  // ---------------------------------------------------------------------------
  const video = () => document.querySelector('#movie_player video.html5-main-video') || document.querySelector('#movie_player video');
  const adShowing = () => !!document.querySelector('#movie_player.ad-showing');
  const playingContent = () => {
    const v = video();
    return !!v && !v.paused && v.currentTime > 0 && !adShowing();
  };

  function blockAt(t) {
    const b = state.blocks;
    if (!b.length || t < b[0].start) return -1;
    let lo = 0;
    let hi = b.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (b[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function setActive(idx) {
    const old = state.activeIdx;
    if (idx === old) return;
    state.activeIdx = idx;
    const rows = state.rows;
    if (old >= 0 && rows[old]) {
      rows[old].classList.remove('active');
      paintRow(old);
    }
    const lo = Math.max(0, Math.min(old, idx));
    const hi = Math.max(old, idx);
    for (let i = lo; i <= hi; i++) rows[i]?.classList.toggle('past', i < idx);
    if (idx >= 0 && rows[idx]) {
      rows[idx].classList.add('active');
      paintRow(idx);
    }
    state.activeWord = -1;
    if (state.following && settings.autoScroll && !state.q) follow(true);
  }

  function updateWords(t) {
    const row = state.rows[state.activeIdx];
    if (!row || row._mode !== 'words') return;
    const words = state.blocks[state.activeIdx].words;
    let k = -1;
    for (let i = 0; i < words.length && words[i].t <= t; i++) k = i;
    if (k === state.activeWord) return;
    const spans = row.querySelectorAll('.w');
    spans.forEach((s, i) => {
      s.classList.toggle('said', i < k);
      s.classList.toggle('cur', i === k);
    });
    state.activeWord = k;
  }

  function tick(force = false) {
    if (state.status !== 'ready' || !state.blocks.length || settings.collapsed) return;
    const v = video();
    if (!v || adShowing()) return;
    const t = v.currentTime;
    if (!force && t === state.lastT) return;
    state.lastT = t;

    if (state.loopIdx >= 0) {
      const b = state.blocks[state.loopIdx];
      if (t >= b.end - 0.04 && t < b.end + 0.75) {
        v.currentTime = b.start;
        return;
      }
      if (t < b.start - 1 || t >= b.end + 0.75) setLoop(blockAt(t)); // user jumped elsewhere: loop that sentence instead
    }

    setActive(blockAt(t + LEAD));
    if (settings.wordHighlight) updateWords(t + LEAD);
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!document.hidden) tick();
  }
  requestAnimationFrame(frame);

  function seek(t, play = true) {
    const v = video();
    if (!v || adShowing()) return;
    v.currentTime = Math.max(0, t);
    if (play && v.paused) v.play().catch(() => {});
    resumeFollow(false);
  }

  // ---------------------------------------------------------------------------
  // Scrolling: follow the video, but step aside when the user scrolls
  // ---------------------------------------------------------------------------
  function follow(smooth) {
    const row = state.rows[state.activeIdx];
    if (!row || els.list.hidden) return;
    const list = els.list;
    const target = Math.max(0, row.offsetTop - list.clientHeight * 0.3);
    const far = Math.abs(list.scrollTop - target) > list.clientHeight * 1.5;
    list.scrollTo({ top: target, behavior: smooth && !far ? 'smooth' : 'auto' });
  }

  function userScrolled() {
    if (!settings.autoScroll || state.status !== 'ready') return;
    state.following = false;
    els.pill.hidden = false;
    clearTimeout(state.resumeTimer);
    state.resumeTimer = setTimeout(() => resumeFollow(true), 10000);
  }

  function resumeFollow(scroll) {
    clearTimeout(state.resumeTimer);
    state.following = true;
    els.pill.hidden = true;
    if (scroll) follow(true);
  }

  els.list.addEventListener('wheel', userScrolled, { passive: true });
  els.list.addEventListener('touchmove', userScrolled, { passive: true });
  els.list.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) userScrolled();
  });
  els.list.addEventListener('pointerdown', (e) => {
    if (e.target === els.list) userScrolled(); // grabbing the scrollbar
  });

  // ---------------------------------------------------------------------------
  // Clicking rows: seek — but let double-click select a word (dictionary extensions)
  // ---------------------------------------------------------------------------
  let clickTimer = 0;
  els.list.addEventListener('click', (e) => {
    const chapter = e.target.closest('.chapter');
    if (chapter) return seek(Number(chapter.dataset.t));
    const row = e.target.closest('.row');
    if (!row) return;
    clearTimeout(clickTimer);
    if (e.detail > 1) return;
    clickTimer = setTimeout(() => {
      const sel = root.getSelection ? root.getSelection() : document.getSelection();
      if (sel && !sel.isCollapsed && String(sel).trim()) return;
      const i = Number(row.dataset.i);
      if (state.loopIdx >= 0) setLoop(i);
      seek(state.blocks[i].start);
    }, 230);
  });
  els.list.addEventListener('dblclick', () => clearTimeout(clickTimer));

  // ---------------------------------------------------------------------------
  // Sentence controls
  // ---------------------------------------------------------------------------
  function stepSentence(dir) {
    if (!state.blocks.length) return;
    const v = video();
    const t = v ? v.currentTime : 0;
    let i = blockAt(t + LEAD);
    if (dir < 0) {
      // Like a music player: first press restarts the sentence, second goes back one.
      if (i >= 0 && t - state.blocks[i].start > 1.2) {
        /* restart current */
      } else i = Math.max(0, i - 1);
    } else i = Math.min(state.blocks.length - 1, i + 1);
    if (state.loopIdx >= 0) setLoop(i);
    seek(state.blocks[i].start);
  }

  function setLoop(i) {
    if (state.loopIdx >= 0) state.rows[state.loopIdx]?.classList.remove('looping');
    state.loopIdx = i;
    if (i >= 0) state.rows[i]?.classList.add('looping');
    els.btnLoop.classList.toggle('on', i >= 0);
  }

  function toggleLoop() {
    if (!state.blocks.length) return;
    if (state.loopIdx >= 0) {
      setLoop(-1);
      toast('Repeat off');
    } else {
      const v = video();
      const i = Math.max(0, blockAt((v ? v.currentTime : 0) + LEAD));
      setLoop(i);
      toast('Repeating this sentence');
    }
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------
  function toggleSearch(force) {
    const open = force ?? els.search.hidden;
    els.search.hidden = !open;
    els.btnSearch.classList.toggle('on', open);
    if (open) {
      els.searchInput.focus();
      els.searchInput.select();
    } else {
      els.searchInput.value = '';
      runSearch('');
      resumeFollow(true);
      hideChromeSoon();
    }
  }

  function runSearch(raw, jump = true) {
    const q = raw.trim().toLowerCase();
    const prevMarked = state.marked;
    state.q = q;
    state.hits = [];
    state.marked = new Set();
    if (q) state.blocks.forEach((b, i) => b.text.toLowerCase().includes(q) && (state.hits.push(i), state.marked.add(i)));
    for (const i of prevMarked) paintRow(i);
    for (const i of state.marked) paintRow(i);
    state.rows[state.hits[state.hitCur]]?.classList.remove('hit-cur');
    state.hitCur = -1;
    if (q && state.hits.length && jump) {
      const after = state.hits.findIndex((i) => i >= state.activeIdx);
      gotoHit(after === -1 ? 0 : after);
    } else updateCount();
  }

  function updateCount() {
    els.searchCount.textContent = state.q ? (state.hits.length ? `${state.hitCur + 1}/${state.hits.length}` : '0') : '';
  }

  function gotoHit(n) {
    state.rows[state.hits[state.hitCur]]?.classList.remove('hit-cur');
    state.hitCur = n;
    const row = state.rows[state.hits[n]];
    if (row) {
      row.classList.add('hit-cur');
      state.following = false;
      els.pill.hidden = !settings.autoScroll;
      els.list.scrollTo({ top: Math.max(0, row.offsetTop - els.list.clientHeight * 0.3), behavior: 'smooth' });
    }
    updateCount();
  }

  function stepHit(d) {
    if (!state.hits.length) return;
    gotoHit((state.hitCur + d + state.hits.length) % state.hits.length);
  }

  let searchDebounce = 0;
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(els.searchInput.value), 120);
  });
  els.searchInput.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep YouTube's single-key shortcuts out of the search box
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!state.q && els.searchInput.value) runSearch(els.searchInput.value);
      else stepHit(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') toggleSearch(false);
  });
  els.searchInput.addEventListener('keyup', (e) => e.stopPropagation());
  els.searchInput.addEventListener('keypress', (e) => e.stopPropagation());

  // ---------------------------------------------------------------------------
  // Copy
  // ---------------------------------------------------------------------------
  async function copyTranscript() {
    if (!state.blocks.length) return;
    const lines = [];
    let ci = 0;
    state.blocks.forEach((b, i) => {
      while (ci < state.chapterMarks.length && state.chapterMarks[ci].beforeBlock <= i) {
        lines.push('', `## ${state.chapterMarks[ci++].title}`, '');
      }
      lines.push((settings.showTimestamps ? `[${Y.fmtTime(b.start)}] ` : '') + (b.sp ? '– ' : '') + b.text);
    });
    try {
      await navigator.clipboard.writeText(lines.join('\n').trim());
      toast('Transcript copied');
    } catch {
      toast('Copy failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Global keys:  [  ]  \   (by physical key so Telex/Unikey layouts still work)
  // ---------------------------------------------------------------------------
  document.addEventListener(
    'keydown',
    (e) => {
      if (state.status !== 'ready' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (location.pathname !== '/watch' || settings.collapsed) return;
      const typing = e.composedPath().some((n) => n instanceof HTMLElement && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)));
      if (typing) return;
      const map = { BracketLeft: () => stepSentence(-1), BracketRight: () => stepSentence(1), Backslash: toggleLoop };
      const fn = map[e.code];
      if (!fn) return;
      e.preventDefault();
      e.stopPropagation();
      fn();
    },
    true
  );

  // ---------------------------------------------------------------------------
  // Mounting, sizing, theme, navigation
  // ---------------------------------------------------------------------------
  function sizePanel() {
    if (!host.isConnected) return;
    if (settings.collapsed) {
      host.style.height = 'auto';
      return;
    }
    if (IS_MOBILE) {
      const pl = document.getElementById('player-container-id');
      if (pl) document.documentElement.style.setProperty('--ytlt-pb', Math.round(pl.getBoundingClientRect().bottom) + 'px');
      if (inFocus() && pl) {
        // Pinned inside the full-screen layer, from just under the video to the bottom.
        const top = Math.round(pl.getBoundingClientRect().bottom + 4);
        host.style.top = top + 'px';
        host.style.height = Math.max(window.innerHeight - top - 8, 200) + 'px';
        return;
      }
      host.style.top = '';
      layoutReveal();
      // Fill from the panel's resting position to the bottom of the screen (no page scroll needed).
      const top = host.getBoundingClientRect().top + window.scrollY;
      host.style.height = Math.round(Math.max(window.innerHeight - top - 8, 260)) + 'px';
      return;
    }
    const flexy = document.querySelector('ytd-watch-flexy');
    const twoCol = flexy?.hasAttribute('is-two-columns_');
    const theater = flexy?.hasAttribute('theater') || flexy?.hasAttribute('fullscreen');
    const player = document.querySelector('ytd-watch-flexy #player-container-outer') || document.querySelector('#movie_player');
    let hgt = 0;
    // A bit taller than the video (reaches down past the title row), but never past the window.
    if (twoCol && !theater && player) hgt = Math.min(player.getBoundingClientRect().height + EXTRA_HEIGHT, window.innerHeight - 90);
    if (!hgt || hgt < 200) hgt = Math.min(window.innerHeight * 0.75, 720);
    host.style.height = Math.round(Math.max(hgt, 380)) + 'px';
  }

  let observedPlayer = null;
  const ro = new ResizeObserver(() => sizePanel());

  function ensureMounted() {
    const onWatch = location.pathname === '/watch';
    document.documentElement.classList.toggle('ytlt-on', onWatch);
    if (!onWatch) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    if (IS_MOBILE) {
      // Focus mode: everything outside the full-screen layer is inert, so the panel lives in it.
      if (inFocus()) {
        if (host.parentElement !== focusLayer) {
          focusLayer.append(host);
          sizePanel();
        }
        return;
      }
      // Right under title + like/share row; page.css hides comments teaser + related list.
      // Logged-out: metadata is a direct child of the list. Logged-in: it sits inside an extra
      // div.related-chips-slot-wrapper. So look at any depth.
      const list = document.querySelector('ytm-single-column-watch-next-results-renderer');
      const meta = list?.querySelector('ytm-slim-video-metadata-section-renderer');
      if (meta && meta.nextElementSibling !== host) {
        meta.after(host);
        sizePanel();
        requestAnimationFrame(() => follow(false));
      } else if (!meta && list && host.parentElement !== list) {
        list.prepend(host);
        sizePanel();
      }
      return;
    }
    const container = document.querySelector('ytd-watch-flexy #secondary-inner') || document.querySelector('ytd-watch-flexy #secondary');
    if (container && host.parentElement !== container) {
      container.prepend(host);
      sizePanel();
      requestAnimationFrame(() => follow(false));
    }
    const player = document.querySelector('ytd-watch-flexy #player-container-outer');
    if (player && player !== observedPlayer) {
      if (observedPlayer) ro.unobserve(observedPlayer);
      ro.observe(player);
      observedPlayer = player;
    }
  }

  function syncTheme() {
    const el = document.documentElement;
    host.dataset.theme = el.hasAttribute('dark') || el.hasAttribute('darker-dark-theme') ? 'dark' : 'light';
    el.style.setProperty('--ytlt-bg', host.dataset.theme === 'dark' ? '#0f0f0f' : '#ffffff');
  }

  function currentVideoId() {
    return location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
  }

  function onVideoChange(vid) {
    state.videoId = vid;
    state.token++;
    state.status = 'idle';
    state.priority = 0;
    state.parsed = null;
    state.blocks = [];
    state.rows = [];
    state.chapterMarks = [];
    state.activeIdx = -1;
    state.loopIdx = -1;
    els.btnLoop.classList.remove('on');
    els.badge.hidden = true;
    els.list.replaceChildren();
    if (!els.search.hidden) toggleSearch(false);
    resumeFollow(false);
    if (vid) loadTranscript(vid);
    else showStatus('idle');
  }

  function poll() {
    const vid = currentVideoId();
    if (vid !== state.videoId) onVideoChange(vid);
    ensureMounted();
    sizePanel();
  }

  // ---------------------------------------------------------------------------
  // Mobile compact mode: YouTube's top bar + title block are hidden layers that slide in with the
  // two-finger tap below.
  // ---------------------------------------------------------------------------
  /**
   * The title block is position:fixed just under the video. But when logged in, m.youtube wraps it
   * in an element that becomes the containing block for fixed children (transform, contain…), so
   * top:Npx is measured from that wrapper. Measure where the containing block really is
   * (on-screen top − current translate − current top) and compensate.
   */
  function positionTitleBlock() {
    const meta = document.querySelector('ytm-slim-video-metadata-section-renderer');
    const pl = document.getElementById('player-container-id');
    if (!meta || !pl) return;
    const st = getComputedStyle(meta);
    if (st.position !== 'fixed') return;
    let ty = 0;
    try {
      ty = new DOMMatrixReadOnly(st.transform === 'none' ? undefined : st.transform).m42;
    } catch {}
    const containerTop = meta.getBoundingClientRect().top - ty - (parseFloat(st.top) || 0);
    const want = pl.getBoundingClientRect().bottom;
    document.documentElement.style.setProperty('--ytlt-meta-top', Math.round(want - containerTop) + 'px');
  }

  function reveal() {
    document.documentElement.classList.add('ytlt-reveal');
    layoutReveal();
  }
  // Positions depend on the live layout, which keeps changing after a reveal (leaving focus mode,
  // Firefox's address bar coming back, rotation…), so sizePanel calls this again on every resize
  // and poll instead of trusting the numbers measured at reveal time.
  function layoutReveal() {
    if (!document.documentElement.classList.contains('ytlt-reveal')) return;
    positionTitleBlock();
    // The title block covers the top of our panel: move our toolbar down to just below it.
    const meta = document.querySelector('ytm-slim-video-metadata-section-renderer');
    const pl = document.getElementById('player-container-id');
    if (meta && pl) {
      const under = pl.getBoundingClientRect().bottom + meta.offsetHeight - els.panel.getBoundingClientRect().top;
      host.style.setProperty('--ytlt-under', Math.max(0, Math.round(under)) + 'px');
    }
  }
  function unreveal() {
    document.documentElement.classList.remove('ytlt-reveal');
    host.style.removeProperty('--ytlt-under');
  }

  // ---------------------------------------------------------------------------
  // Two-finger tap = "hover" for touch screens. It shows our toolbars and, in compact mode,
  // YouTube's top bar + title block, all together, and they stay until the next two-finger tap
  // (no timer, no tap-elsewhere: the user decides). Three or more fingers are ignored
  // (Android's three-finger swipe is the screenshot gesture).
  // ---------------------------------------------------------------------------
  const TAP_MOVE = 24; // px a finger may drift before it counts as a pinch / scroll
  const TAP_MAX_MS = 600; // first finger down → last finger up
  const SECOND_FINGER_MS = 350; // the two fingers must land almost together
  function showUI() {
    uiShown = true;
    showChrome();
    // Not in focus mode: there YouTube's bars would be visible but inert (untappable).
    if (IS_MOBILE && settings.compactMobile && !inFocus()) reveal();
  }
  function hideUI() {
    if (!uiShown) return;
    uiShown = false;
    unreveal();
    hideChromeSoon(0);
  }

  let gesture = null; // one per touch sequence: first finger down → all fingers up
  window.addEventListener(
    'touchstart',
    (e) => {
      const n = e.touches.length;
      if (n === 1) gesture = { t0: e.timeStamp, max: 1, start: new Map(), moved: false };
      if (!gesture) return;
      for (const t of e.changedTouches) gesture.start.set(t.identifier, [t.clientX, t.clientY]);
      gesture.max = Math.max(gesture.max, n);
      if (n === 2 && e.timeStamp - gesture.t0 > SECOND_FINGER_MS) gesture.moved = true;
    },
    { capture: true, passive: true }
  );
  window.addEventListener(
    'touchmove',
    (e) => {
      if (!gesture || gesture.moved) return;
      for (const t of e.changedTouches) {
        const s = gesture.start.get(t.identifier);
        if (s && Math.hypot(t.clientX - s[0], t.clientY - s[1]) > TAP_MOVE) gesture.moved = true;
      }
    },
    { capture: true, passive: true }
  );
  // In focus mode the page (video included) is inert, so YouTube never sees the tap; do the
  // most useful thing it would have done.
  function tapOnVideo(g) {
    const pl = document.getElementById('player-container-id');
    const [x, y] = g.start.values().next().value || [];
    const r = pl?.getBoundingClientRect();
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  function togglePlay() {
    const v = document.querySelector('#player-container-id video') || document.querySelector('video');
    if (!v) return;
    if (v.paused) {
      v.play()?.catch?.(() => {});
      toast('Playing', 900);
    } else {
      v.pause();
      toast('Paused', 900);
    }
  }
  function endGesture(e) {
    if (!gesture || e.touches.length) return;
    const g = gesture;
    gesture = null;
    const tap = e.type === 'touchend' && !g.moved && e.timeStamp - g.t0 < TAP_MAX_MS;
    if (tap && g.max === 2) return uiShown ? hideUI() : showUI();
    if (tap && g.max === 1 && inFocus() && tapOnVideo(g)) togglePlay();
  }
  window.addEventListener('touchend', endGesture, true);
  window.addEventListener('touchcancel', endGesture, true);

  // Focus mode: full screen hides Firefox's address bar and Android's status bar. Browsers only
  // allow it from a tap, which is why it's a button.
  // What goes full screen is an empty, see-through, click-through layer, NOT the page: Firefox
  // Android forces landscape whenever a playing <video> is inside the full-screen element (and
  // again on every pause / play), so the video must stay outside it. The page keeps rendering
  // underneath at the new, taller size. page.css styles the layer.
  function toggleFocus() {
    const d = document;
    if (d.fullscreenElement) return void d.exitFullscreen?.().catch(() => {});
    if (!focusLayer) focusLayer = h('div', { id: 'ytlt-focus', 'aria-hidden': 'true' });
    if (!focusLayer.isConnected) d.documentElement.append(focusLayer);
    focusLayer.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => toast('Full screen not allowed here'));
  }
  // Safety net if Firefox rotates anyway: while in focus mode, ask for portrait back.
  screen.orientation?.addEventListener?.('change', () => {
    if (inFocus() && screen.orientation.type.startsWith('landscape')) screen.orientation.lock?.('portrait-primary').catch(() => {});
  });
  // main-world.js swallows fullscreenchange for focus mode (so YouTube never sees it) and
  // tells us via postMessage instead; resize is a second signal.
  function updateFocusButton() {
    const on = inFocus();
    if (els.btnFocus.classList.contains('on') === on) return;
    els.btnFocus.replaceChildren(icon(on ? 'fullscreenExit' : 'fullscreen'));
    els.btnFocus.classList.toggle('on', on);
    els.btnFocus.title = on ? 'Exit focus mode' : 'Focus mode (full screen)';
    // YouTube's top bar / title can't be used in focus mode: put them away, keep our toolbars;
    // bring them back on the way out if the toolbars are still shown.
    if (on) unreveal();
    else if (uiShown && settings.compactMobile) reveal();
    ensureMounted(); // move the panel into / out of the full-screen layer
    sizePanel();
    setTimeout(sizePanel, 300);
  }
  document.addEventListener('fullscreenchange', updateFocusButton);
  window.addEventListener('resize', updateFocusButton);

  async function init() {
    try {
      if (storage) settings = { ...DEFAULTS, ...(await storage.get(DEFAULTS)) };
    } catch {
      /* use defaults */
    }
    try {
      globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
        if (area !== 'sync') return;
        for (const [k, { newValue }] of Object.entries(changes)) {
          if (k in DEFAULTS && settings[k] !== newValue) {
            settings[k] = newValue;
            applySettings(k);
          }
        }
      });
    } catch {}
    applySettings();
    showStatus('idle');
    syncTheme();
    new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['dark', 'darker-dark-theme'] });
    document.addEventListener('yt-navigate-finish', poll);
    window.addEventListener('resize', sizePanel);
    setInterval(poll, 700);
    poll();
  }

  init();
})();
