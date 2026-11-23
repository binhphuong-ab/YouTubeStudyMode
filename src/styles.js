/* Shadow-DOM stylesheet for the panel. Kept in JS so it's applied instantly (no flash). */
(() => {
  const NS = (globalThis.YTLT = globalThis.YTLT || {});
  NS.CSS = String.raw`
:host {
  --fs: 16px;
  --lh: 1.6;
  --panel: #181818;
  --panel-glass: rgba(24, 24, 24, 0.97);
  --menu: #282828;
  --border: rgba(255, 255, 255, 0.1);
  --chip: rgba(255, 255, 255, 0.08);
  --hover: rgba(255, 255, 255, 0.06);
  --text: #f1f1f1;
  --text-future: rgba(241, 241, 241, 0.88);
  --text-past: rgba(241, 241, 241, 0.42);
  --text-upcoming-word: rgba(241, 241, 241, 0.5);
  --muted: #aaaaaa;
  --accent: #3ea6ff;
  --accent-ink: #0f0f0f;
  --accent-soft: rgba(62, 166, 255, 0.13);
  --mark: rgba(255, 196, 0, 0.32);
  --mark-cur: #ffb300;
  --shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  all: initial;
  display: block;
  height: 100%;
  font-family: "Roboto", "Arial", sans-serif;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
:host([data-theme="light"]) {
  --panel: #ffffff;
  --panel-glass: rgba(255, 255, 255, 0.97);
  --menu: #ffffff;
  --border: rgba(0, 0, 0, 0.1);
  --chip: rgba(0, 0, 0, 0.05);
  --hover: rgba(0, 0, 0, 0.05);
  --text: #0f0f0f;
  --text-future: rgba(15, 15, 15, 0.86);
  --text-past: rgba(15, 15, 15, 0.4);
  --text-upcoming-word: rgba(15, 15, 15, 0.45);
  --muted: #606060;
  --accent: #065fd4;
  --accent-ink: #ffffff;
  --accent-soft: rgba(6, 95, 212, 0.09);
  --mark: rgba(255, 196, 0, 0.4);
  --shadow: 0 8px 32px rgba(0, 0, 0, 0.16);
}

* { box-sizing: border-box; }
button { font: inherit; color: inherit; }
[hidden] { display: none !important; }

.panel {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}

/* ---------- header ---------- */
.bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 8px 8px 8px 16px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
}
.title svg { width: 20px; height: 20px; fill: var(--accent); flex: none; }
.badge {
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  background: var(--chip);
  padding: 2px 7px;
  border-radius: 999px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.btn {
  flex: none;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
@media (hover: hover) { .btn:hover { background: var(--hover); } }
.btn:active { background: var(--chip); }
.btn.on { color: var(--accent); background: var(--accent-soft); }
.btn svg { width: 20px; height: 20px; fill: currentColor; }
.btn.txt { font-size: 13px; font-weight: 600; letter-spacing: -0.02em; }
.btn:focus-visible, .row:focus-visible, .pill:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

/* ---------- search ---------- */
.search {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 8px 8px 8px 12px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.search input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 14px;
  border-radius: 17px;
  border: 1px solid var(--border);
  background: var(--chip);
  color: var(--text);
  font: 14px "Roboto", "Arial", sans-serif;
  outline: none;
}
.search input:focus { border-color: var(--accent); }
.search .count { font-size: 12px; color: var(--muted); min-width: 44px; text-align: center; font-variant-numeric: tabular-nums; }

/* ---------- list ---------- */
.body { position: relative; flex: 1; min-height: 0; display: flex; }
.list {
  position: relative;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 6px 0 45%;
  scrollbar-width: thin;
  scrollbar-color: var(--chip) transparent;
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
}
.list::-webkit-scrollbar { width: 8px; }
.list::-webkit-scrollbar-thumb { background: var(--chip); border-radius: 4px; }
.list:hover::-webkit-scrollbar-thumb { background: var(--border); }

.row {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  column-gap: 12px;
  margin: 1px 8px;
  padding: 7px 12px 7px 9px;
  border-left: 3px solid transparent;
  border-radius: 8px;
  color: var(--text-future);
  cursor: pointer;
  transition: background 0.18s, color 0.25s, border-color 0.18s;
}
@media (hover: hover) { .row:hover { background: var(--hover); } .row:hover .ts { color: var(--accent); } }
.row.past { color: var(--text-past); }
.row.active {
  color: var(--text);
  background: var(--accent-soft);
  border-left-color: var(--accent);
}
.row.sp { margin-top: 8px; }
.row.sp .tx::before { content: "– "; color: var(--muted); }
.row.looping { border-left-style: dashed; }

.ts {
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  background: var(--chip);
  padding: 1px 6px;
  border-radius: 4px;
  font-variant-numeric: tabular-nums;
  transition: background 0.18s, color 0.18s;
}
.row.active .ts { background: var(--accent); color: var(--accent-ink); }
.no-ts .row { grid-template-columns: 1fr; }
.no-ts .ts { display: none; }

.tx {
  margin: 0;
  font-size: var(--fs);
  line-height: var(--lh);
  overflow-wrap: anywhere;
}
.row.active .tx { font-weight: 500; }

/* karaoke: inside the active sentence, words already spoken are bright */
.row.karaoke .w { color: var(--text-upcoming-word); transition: color 0.12s; }
.row.karaoke .w.said { color: var(--text); }
.row.karaoke .w.cur { color: var(--accent); }

mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 1px; }
.row.hit-cur mark { box-shadow: 0 0 0 2px var(--mark-cur); }

.chapter {
  position: sticky;
  top: -6px;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 10px 0 4px;
  padding: 9px 20px 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted);
  background: var(--panel-glass);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.sec:first-child > .chapter, .sec:empty + .sec > .chapter { margin-top: -6px; }
.sec:empty { display: none; }
.chapter span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chapter span:last-child { font-variant-numeric: tabular-nums; font-weight: 500; letter-spacing: 0; }

/* ---------- floating "back to current" ---------- */
.pill {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 14px 0 10px;
  border: 0;
  border-radius: 17px;
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 13px;
  font-weight: 600;
  box-shadow: var(--shadow);
  cursor: pointer;
  z-index: 5;
  animation: pop 0.18s ease-out;
}
.pill svg { width: 18px; height: 18px; fill: currentColor; }
@keyframes pop { from { opacity: 0; transform: translate(-50%, 6px); } }

/* ---------- status (loading / error) ---------- */
.status {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  font-size: 14px;
  line-height: 1.5;
  color: var(--muted);
}
.status strong { color: var(--text); font-size: 15px; font-weight: 500; }
.status .hint { font-size: 12.5px; max-width: 280px; }
.status button {
  height: 34px;
  padding: 0 16px;
  border: 1px solid var(--border);
  border-radius: 17px;
  background: var(--chip);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}
.status button:hover { background: var(--hover); }
.spinner {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 3px solid var(--chip);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- footer (sentence controls) ---------- */
.foot {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-top: 1px solid var(--border);
  flex: none;
}
.foot .hint {
  flex: 1;
  min-width: 0;
  text-align: right;
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-right: 6px;
}
kbd {
  font: 500 11px "Roboto", "Arial", sans-serif;
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--chip);
  color: var(--text);
}
.toast { color: var(--accent); font-weight: 500; }

/* ---------- menu ---------- */
.menu {
  position: absolute;
  top: 50px;
  right: 8px;
  z-index: 10;
  min-width: 250px;
  padding: 8px 0;
  border-radius: 12px;
  background: var(--menu);
  box-shadow: var(--shadow);
  border: 1px solid var(--border);
  animation: fade 0.12s ease-out;
}
@keyframes fade { from { opacity: 0; transform: translateY(-4px); } }
.menu .item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 9px 16px;
  border: 0;
  background: transparent;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}
.menu .item:hover { background: var(--hover); }
.menu .item svg { width: 20px; height: 20px; fill: currentColor; flex: none; }
.menu .item .lbl { flex: 1; }
.menu .sep { height: 1px; margin: 6px 0; background: var(--border); }
.switch {
  position: relative;
  width: 34px;
  height: 20px;
  border-radius: 10px;
  background: var(--border);
  transition: background 0.15s;
  flex: none;
}
.switch::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
  box-shadow: 0 1px 2px rgba(0,0,0,.3);
}
.item[aria-checked="true"] .switch { background: var(--accent); }
.item[aria-checked="true"] .switch::after { transform: translateX(14px); }

/* ---------- auto-hiding toolbars (float over the list, fade in on hover) ---------- */
.panel.autohide:not(.collapsed) .bar,
.panel.autohide:not(.collapsed) .foot,
.panel.autohide:not(.collapsed) .search {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 6;
  background: var(--panel-glass);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  transition: opacity 0.22s ease, transform 0.22s ease, top 0.22s ease;
}
/* --ytlt-under: height of YouTube's title block when it slides in over the panel (phones),
   so our toolbar sits below it instead of hiding the video title. */
.panel.autohide:not(.collapsed) .bar { top: var(--ytlt-under, 0px); }
.panel.autohide:not(.collapsed) .search { top: calc(var(--ytlt-under, 0px) + 51px); }
.panel:not(.autohide) .bar, .panel.collapsed .bar { margin-top: var(--ytlt-under, 0px); }
.panel.autohide:not(.collapsed) .foot { bottom: 0; }
.panel.autohide:not(.collapsed):not(.chrome-on) .bar {
  opacity: 0;
  transform: translateY(-100%);
  pointer-events: none;
}
.panel.autohide:not(.collapsed):not(.chrome-on) .foot {
  opacity: 0;
  transform: translateY(100%);
  pointer-events: none;
}
.panel.autohide .pill { transition: bottom 0.22s ease; }
.panel.autohide.chrome-on .pill { bottom: 60px; }

/* ---------- phones (m.youtube.com) ---------- */
:host([data-mobile]) .btn { width: 40px; height: 40px; }
:host([data-mobile]) .btn svg { width: 22px; height: 22px; }
:host([data-mobile]) .bar { padding: 6px 4px 6px 14px; }
:host([data-mobile]) .row { margin: 1px 4px; padding: 8px 10px 8px 8px; column-gap: 10px; }
:host([data-mobile]) .panel.autohide:not(.collapsed) .search { top: calc(var(--ytlt-under, 0px) + 53px); }
:host([data-mobile]) .foot { justify-content: center; gap: 28px; }
:host([data-mobile]) .foot .hint { position: absolute; right: 12px; flex: none; }
.row { -webkit-tap-highlight-color: transparent; }

/* ---------- collapsed ---------- */
.collapsed .bar { border-bottom: 0; }
.collapsed .search, .collapsed .body, .collapsed .foot { display: none !important; }
`;
})();
