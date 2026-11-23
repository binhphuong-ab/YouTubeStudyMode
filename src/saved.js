/*
 * Home feed + "Saved" list (desktop www.youtube.com only).
 *
 * 1. Hide thumbnails on the Home feed (setting `hideThumbs`, chrome.storage.sync). The card keeps the
 *    channel avatar, title, channel, views/date; the duration badge is copied under the title.
 * 2. Save videos without YouTube's "Save to playlist": a bookmark button on every video card and on
 *    the watch page. The list lives in chrome.storage.local (this browser only, never sent anywhere)
 *    and is shown as a "Saved" section at the top of the left guide, above Subscriptions.
 *
 * Independent of content.js (the transcript panel). Everything here is light DOM styled by page.css,
 * gated on classes / ids prefixed with ytlt-.
 */
(() => {
  'use strict';
  if (globalThis.__ytltSaved) return;
  globalThis.__ytltSaved = true;
  if (location.hostname !== 'www.youtube.com') return;

  const KEY = 'savedVideos';
  const PREVIEW = 5; // items shown before "Show more"
  const sync = globalThis.chrome?.storage?.sync;
  const local = globalThis.chrome?.storage?.local;

  const prefs = { hideThumbs: true, savedCollapsed: false };
  let saved = []; // newest first: { id, title, channel, channelUrl, avatar, duration, list, savedAt }
  let savedIds = new Set();
  let showAll = false;

  // ---------------------------------------------------------------------------
  // DOM helpers (no innerHTML: YouTube enforces Trusted Types)
  // ---------------------------------------------------------------------------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    el.append(...kids.filter((k) => k != null));
    return el;
  }
  const PATHS = {
    bookmark: 'M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2zm0 15-5-2.18L7 18V5h10v13z',
    bookmarked: 'M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    chevron: 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z',
    // YouTube's own "Not interested" icon (circle with a slash)
    notInterested:
      'M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1Zm0 2a9 9 0 018.246 12.605L4.755 6.661A8.99 8.99 0 0112 3ZM3.754 8.393l15.491 8.944A9 9 0 013.754 8.393Z',
    eye: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    eyeOff:
      'M12 7a5 5 0 0 1 5 5c0 .65-.13 1.26-.36 1.83l2.92 2.92A11.8 11.8 0 0 0 23 12c-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.8 11.8 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55A2.82 2.82 0 0 0 9 12a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.55 1.55A5 5 0 0 1 7.53 9.8zm4.31-.78 3.15 3.15.02-.16a3 3 0 0 0-3-3l-.17.01z',
  };
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', PATHS[name]);
    svg.append(p);
    return svg;
  }

  function videoIdOf(href) {
    try {
      const u = new URL(href, location.origin);
      return u.pathname === '/watch' ? u.searchParams.get('v') : null;
    } catch {
      return null;
    }
  }
  function listOf(href) {
    try {
      return new URL(href, location.origin).searchParams.get('list') || '';
    } catch {
      return '';
    }
  }
  const watchUrl = (v) => '/watch?v=' + encodeURIComponent(v.id) + (v.list ? '&list=' + encodeURIComponent(v.list) : '');
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

  // SPA navigation: YouTube's router listens for `yt-navigate` in the page's own JS world, and an
  // event detail built here (isolated world) would arrive empty there, so main-world.js fires it.
  function navigate(url) {
    window.postMessage({ source: 'ytlt-iso', reqId: 'nav-' + Date.now(), type: 'navigate', payload: { url } }, location.origin);
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  function setSaved(list) {
    saved = Array.isArray(list) ? list : [];
    savedIds = new Set(saved.map((v) => v.id));
    renderGuide();
    scan();
  }
  async function readSaved() {
    try {
      return (await local.get(KEY))[KEY] || [];
    } catch {
      return saved;
    }
  }
  async function writeSaved(list) {
    setSaved(list); // optimistic: the UI updates at once, onChanged confirms
    try {
      await local.set({ [KEY]: list });
    } catch {
      /* extension reloaded; the page needs a refresh */
    }
  }
  async function toggleSave(info) {
    if (!info?.id) return;
    const list = await readSaved();
    const i = list.findIndex((v) => v.id === info.id);
    if (i >= 0) list.splice(i, 1);
    else list.unshift({ ...info, savedAt: Date.now() });
    await writeSaved(list);
  }
  async function removeSaved(id) {
    await writeSaved((await readSaved()).filter((v) => v.id !== id));
  }
  function setPref(key, value) {
    prefs[key] = value;
    try {
      sync?.set({ [key]: value });
    } catch {}
    applyPrefs();
  }
  function applyPrefs() {
    document.documentElement.classList.toggle('ytlt-nothumbs', !!prefs.hideThumbs);
    renderGuide();
  }

  // ---------------------------------------------------------------------------
  // Video cards (yt-lockup-view-model: Home, Subscriptions, channel pages…)
  // ---------------------------------------------------------------------------
  function cardInfo(lockup) {
    const a = lockup.querySelector('a.ytLockupMetadataViewModelTitle, h3 a[href*="/watch"]');
    const id = a && videoIdOf(a.getAttribute('href'));
    if (!id) return null;
    const row = lockup.querySelector('.ytContentMetadataViewModelMetadataRow');
    const ch = row?.querySelector('a[href^="/@"], a[href^="/channel/"], a[href^="/c/"], a[href^="/user/"]');
    return {
      id,
      title: text(a),
      channel: text(ch) || text(row?.querySelector('span')),
      channelUrl: ch?.getAttribute('href') || '',
      avatar: lockup.querySelector('.ytLockupMetadataViewModelAvatar img')?.src || '',
      duration: badges(lockup),
      list: listOf(a.getAttribute('href')),
    };
  }
  function badges(lockup) {
    return [...lockup.querySelectorAll('yt-thumbnail-view-model .ytBadgeShapeText, yt-collection-thumbnail-view-model .ytBadgeShapeText')]
      .map(text)
      .filter(Boolean)
      .join(' · ');
  }

  function decorateCard(lockup) {
    const meta = lockup.querySelector('yt-lockup-metadata-view-model');
    const a = meta?.querySelector('a.ytLockupMetadataViewModelTitle, h3 a[href*="/watch"]');
    const id = a && videoIdOf(a.getAttribute('href'));
    let btn = meta?.querySelector(':scope > .ytlt-save');
    if (!id) {
      btn?.remove();
      return;
    }
    if (!btn) {
      btn = h('button', {
        class: 'ytlt-save',
        type: 'button',
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          // Read the card again at click time: YouTube recycles card elements for other videos.
          toggleSave(cardInfo(lockup));
        },
      });
      const menu = meta.querySelector(':scope > .ytLockupMetadataViewModelMenuButton');
      meta.insertBefore(btn, menu || null);
    }
    const on = savedIds.has(id);
    if (btn.dataset.vid !== id || btn.dataset.on !== String(on)) {
      btn.dataset.vid = id;
      btn.dataset.on = String(on);
      btn.classList.toggle('on', on);
      btn.title = on ? 'Remove from Saved' : 'Save (stored in this browser)';
      btn.setAttribute('aria-pressed', String(on));
      btn.replaceChildren(icon(on ? 'bookmarked' : 'bookmark'));
    }
    // Home feed: one-click "Not interested" in place of the ⋮ menu button (page.css hides ⋮).
    const ytMenu = meta.querySelector(':scope > .ytLockupMetadataViewModelMenuButton');
    let ni = meta.querySelector(':scope > .ytlt-ni');
    if (ytMenu && lockup.closest('ytd-browse[page-subtype="home"]')) {
      if (!ni) {
        ni = h(
          'button',
          {
            class: 'ytlt-ni',
            type: 'button',
            title: 'Not interested',
            'aria-label': 'Not interested',
            onclick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              notInterested(lockup, ni);
            },
          },
          icon('notInterested')
        );
        meta.insertBefore(ni, ytMenu);
      }
    } else ni?.remove();
    // Duration line, visible only while thumbnails are hidden (page.css).
    const box = meta.querySelector('.ytLockupMetadataViewModelTextContainer');
    if (box) {
      const dur = badges(lockup);
      let el = box.querySelector(':scope > .ytlt-dur');
      if (!dur) el?.remove();
      else if (!el) box.append(h('div', { class: 'ytlt-dur', text: dur }));
      else if (el.textContent !== dur) el.textContent = dur;
    }
  }

  // ---------------------------------------------------------------------------
  // One-click "Not interested"
  // ---------------------------------------------------------------------------
  /*
   * There is no public call for it, so drive YouTube's own ⋮ menu while it is invisible
   * (html.ytlt-silent-menu, page.css): open it, click its "Not interested" item, done. The card is
   * then removed from the grid (no "Video removed · Undo" notice).
   *
   * The popup and its items are reused between cards (only their data changes), so "a fresh item"
   * cannot tell this card's menu from the previous one. Instead: make sure the popup is closed, open
   * it, wait until it is shown, give the list two frames to re-render, then click.
   */
  const POPUP = 'ytd-popup-container tp-yt-iron-dropdown';
  const NI_TEXT = /^(not interested|không quan tâm|no me interesa|pas intéressé|kein interesse|興味なし|관심 없음|不感兴趣|不感興趣)$/i;
  const NI_ICON = 'L4.755 6.661'; // the slash in the circle-slash icon
  let niBusy = false;

  const popupShown = () => [...document.querySelectorAll(POPUP)].find((d) => d.querySelector('yt-sheet-view-model') && getComputedStyle(d).display !== 'none');
  const frames = (n) => new Promise((res) => (function f(k) { k ? requestAnimationFrame(() => f(k - 1)) : res(); })(n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, ms) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(30)) {
      const v = fn();
      if (v) return v;
    }
    return null;
  }
  function findNotInterested(popup) {
    for (const it of popup.querySelectorAll('yt-list-item-view-model')) {
      const d = it.querySelector('svg path')?.getAttribute('d') || '';
      if (d.includes(NI_ICON) || NI_TEXT.test(text(it))) return it.querySelector('button, [role="menuitem"]') || it;
    }
    return null;
  }
  const pressEscape = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));

  async function notInterested(lockup, btn) {
    const menuBtn = lockup.querySelector('.ytLockupMetadataViewModelMenuButton button');
    if (!menuBtn || niBusy) return;
    niBusy = true;
    btn.classList.add('busy');
    const html = document.documentElement;
    html.classList.add('ytlt-silent-menu');
    let ok = false;
    try {
      if (popupShown()) {
        pressEscape();
        await until(() => !popupShown(), 1000);
      }
      menuBtn.click(); // works although the button is visibility:hidden
      const popup = await until(popupShown, 2500);
      if (popup) {
        await frames(2);
        const item = await until(() => findNotInterested(popup), 1000);
        if (item) {
          item.click();
          ok = true;
          // Vanish at once instead of showing YouTube's "Video removed · Undo" card (page.css also
          // hides any card YouTube has replaced with that notice).
          lockup.closest('ytd-rich-item-renderer')?.classList.add('ytlt-dismissed');
        }
      }
    } finally {
      if (popupShown()) pressEscape();
      await sleep(250); // let the popup finish closing before it may become visible again
      html.classList.remove('ytlt-silent-menu');
      btn.classList.remove('busy');
      niBusy = false;
    }
    if (!ok) {
      btn.classList.add('fail');
      btn.title = 'Could not find "Not interested" in this video\'s menu';
      setTimeout(() => btn.classList.remove('fail'), 1500);
    }
  }

  // ---------------------------------------------------------------------------
  // Watch page button (next to Like / Share)
  // ---------------------------------------------------------------------------
  function watchInfo() {
    const id = videoIdOf(location.href);
    const wm = document.querySelector('ytd-watch-metadata');
    if (!id || !wm) return null;
    const ch = wm.querySelector('ytd-channel-name a');
    let duration = text(document.querySelector('#movie_player .ytp-time-duration'));
    if (!duration) {
      const d = document.querySelector('#movie_player video')?.duration;
      if (isFinite(d) && d > 0) duration = fmt(d);
    }
    return {
      id,
      title: text(wm.querySelector('h1')) || document.title.replace(/ - YouTube$/, ''),
      channel: text(ch),
      channelUrl: ch?.getAttribute('href') || '',
      avatar: wm.querySelector('#owner #avatar img')?.src || '',
      duration,
      list: listOf(location.href),
    };
  }
  function fmt(s) {
    s = Math.round(s);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  }

  let watchBtn = null;
  function decorateWatch() {
    const id = videoIdOf(location.href);
    // #actions-inner is a *column* flexbox (a direct child gets stretched into a full-width row of
    // its own); the horizontal row holding Like / Share / ⋯ is the ytd-menu-renderer inside #menu.
    const row = id && document.querySelector('ytd-watch-metadata #actions-inner #menu ytd-menu-renderer');
    if (!row) return;
    if (!watchBtn) {
      watchBtn = h('button', {
        class: 'ytlt-save-watch',
        type: 'button',
        onclick: (e) => {
          e.stopPropagation();
          toggleSave(watchInfo());
        },
      });
    }
    if (watchBtn.parentElement !== row) row.prepend(watchBtn);
    const on = savedIds.has(id);
    if (watchBtn.dataset.vid !== id || watchBtn.dataset.on !== String(on)) {
      watchBtn.dataset.vid = id;
      watchBtn.dataset.on = String(on);
      watchBtn.classList.toggle('on', on);
      watchBtn.title = on ? 'Remove from Saved' : 'Save to the Saved list (stored in this browser)';
      watchBtn.replaceChildren(icon(on ? 'bookmarked' : 'bookmark'), h('span', { text: on ? 'Saved' : 'Save' }));
    }
  }

  // ---------------------------------------------------------------------------
  // "Saved" section in the left guide, above Subscriptions
  // ---------------------------------------------------------------------------
  const section = h('div', { id: 'ytlt-saved' });

  function itemEl(v) {
    const url = watchUrl(v);
    const sub = [v.channel, v.duration].filter(Boolean).join(' · ');
    return h(
      'a',
      {
        class: 'ytlt-sv-item',
        href: url,
        title: v.title + (v.channel ? '\n' + v.channel : ''),
        onclick: (e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab etc.
          e.preventDefault();
          navigate(url);
        },
      },
      v.avatar
        ? h('img', { class: 'ytlt-sv-av', src: v.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
        : h('span', { class: 'ytlt-sv-av ytlt-sv-av-empty', text: (v.channel || v.title || '?').trim().charAt(0).toUpperCase() }),
      h('span', { class: 'ytlt-sv-txt' }, h('span', { class: 'ytlt-sv-t', text: v.title || v.id }), sub ? h('span', { class: 'ytlt-sv-c', text: sub }) : null),
      h(
        'button',
        {
          class: 'ytlt-sv-rm',
          type: 'button',
          title: 'Remove from Saved',
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            removeSaved(v.id);
          },
        },
        icon('close')
      )
    );
  }

  function renderGuide() {
    const collapsed = !!prefs.savedCollapsed;
    section.classList.toggle('collapsed', collapsed);
    const head = h(
      'div',
      { class: 'ytlt-sv-head' },
      h(
        'button',
        {
          class: 'ytlt-sv-title',
          type: 'button',
          title: collapsed ? 'Show saved videos' : 'Hide saved videos',
          onclick: () => setPref('savedCollapsed', !collapsed),
        },
        h('span', { text: 'Saved' }),
        saved.length ? h('span', { class: 'ytlt-sv-count', text: String(saved.length) }) : null,
        icon('chevron')
      ),
      h(
        'button',
        {
          class: 'ytlt-sv-icon' + (prefs.hideThumbs ? ' on' : ''),
          type: 'button',
          title: prefs.hideThumbs ? 'Thumbnails hidden on Home (click to show)' : 'Hide thumbnails on Home',
          onclick: () => setPref('hideThumbs', !prefs.hideThumbs),
        },
        icon(prefs.hideThumbs ? 'eyeOff' : 'eye')
      )
    );
    const body = [];
    if (!collapsed) {
      if (!saved.length) {
        body.push(h('div', { class: 'ytlt-sv-empty' }, 'Click ', icon('bookmark'), ' on a video to save it here.'));
      } else {
        const shown = showAll ? saved : saved.slice(0, PREVIEW);
        body.push(h('div', { class: 'ytlt-sv-list' }, ...shown.map(itemEl)));
        if (saved.length > PREVIEW) {
          body.push(
            h(
              'button',
              { class: 'ytlt-sv-more' + (showAll ? ' less' : ''), type: 'button', onclick: () => ((showAll = !showAll), renderGuide()) },
              icon('chevron'),
              h('span', { text: showAll ? 'Show less' : `Show ${saved.length - PREVIEW} more` })
            )
          );
        }
      }
    }
    section.replaceChildren(head, ...body);
  }

  function mountGuide() {
    const sections = document.querySelector('ytd-guide-renderer #sections');
    const first = sections?.querySelector(':scope > ytd-guide-section-renderer');
    if (!first) return;
    if (section.previousElementSibling !== first || section.parentElement !== sections) first.after(section);
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------
  function scan() {
    mountGuide();
    for (const lockup of document.querySelectorAll('ytd-app yt-lockup-view-model')) decorateCard(lockup);
    decorateWatch();
  }
  let queued = false;
  function queueScan() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  }

  async function init() {
    try {
      Object.assign(prefs, await sync.get(prefs));
    } catch {}
    try {
      saved = (await local.get(KEY))[KEY] || [];
      savedIds = new Set(saved.map((v) => v.id));
    } catch {}
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && KEY in changes) setSaved(changes[KEY].newValue);
        if (area === 'sync') {
          let touched = false;
          for (const k of Object.keys(prefs)) {
            if (k in changes && changes[k].newValue !== undefined && changes[k].newValue !== prefs[k]) {
              prefs[k] = changes[k].newValue;
              touched = true;
            }
          }
          if (touched) applyPrefs();
        }
      });
    } catch {}
    applyPrefs();
    const start = () => {
      new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
      document.addEventListener('yt-navigate-finish', queueScan);
      setInterval(scan, 1000); // catches recycled cards whose href changed without new nodes
      scan();
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  init();
})();
