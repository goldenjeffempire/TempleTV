/* eslint-disable no-useless-escape */
// The HTML constant below is a large template literal containing inline
// JavaScript. Single-quote escapes (e.g. \') inside nested JS strings within
// that template literal are necessary for correct browser-side JS execution
// even though ESLint's no-useless-escape rule cannot detect that context.
import type { FastifyInstance } from "fastify";
import { z } from "zod";

/* ============================================================
   Temple TV — Broadcast Control Dashboard
   Self-contained HTML page (zero build step required).

   Audit checklist (all items resolved):
   ✓  No Tailwind CDN — full custom CSS, no external CDN warning
   ✓  No browser alert() / confirm() — custom inline modal
   ✓  SSE with exponential-backoff reconnect + visibilitychange recovery
   ✓  rAF-based smooth progress bar (no 1-second jank)
   ✓  Advance SSE event handled without race condition (debounced reload)
   ✓  AbortController on queue fetches (stale-response prevention)
   ✓  snapshotAge shown in all states (idle + live)
   ✓  statBroken neutral until health check runs
   ✓  localUrlField single style attribute, gridColumn preserved in JS
   ✓  Auto-thumbnail fill when YouTube ID is typed
   ✓  Live override reflected in Now Airing card
   ✓  Token validated against /admin/broadcast/health on save
   ✓  HTML-escape for all user-supplied strings
   ✓  CSRF: Bearer-token auth bypasses CSRF hook (no X-Admin-CSRF needed)
   ✓  All API paths verified against app.ts route registrations
   ✓  StartOverrideBodySchema uses youtubeUrl + endsAt (not youtubeVideoId/durationMinutes)
   ✓  Queue response is array (no .items wrapper)
   ✓  Keyboard shortcuts: R=reload, H=health, Esc=close modal
   ✓  CSP allows self + tailwindcss.com (Tailwind removed, CSP unchanged)
   ============================================================ */

const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Temple TV — Broadcast Control</title>
<style>
:root {
  --bg: #020617;
  --surface: #0f172a;
  --surface2: #1e293b;
  --surface3: #243044;
  --border: #1e293b;
  --border2: #334155;
  --text: #f1f5f9;
  --muted: #94a3b8;
  --dim: #475569;
  --emerald: #10b981;
  --emerald-dim: rgba(16,185,129,.12);
  --rose: #f43f5e;
  --rose-dim: rgba(244,63,94,.12);
  --amber: #f59e0b;
  --amber-dim: rgba(245,158,11,.12);
  --sky: #38bdf8;
  --violet: #8b5cf6;
  --violet-dim: rgba(139,92,246,.12);
}
*,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}

/* Scrollbar */
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--dim); }

/* Animations */
@keyframes pulse     { 0%,100%{opacity:1} 50%{opacity:.2} }
@keyframes spin      { to{transform:rotate(360deg)} }
@keyframes fadeUp    { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }
@keyframes slideInX  { from{opacity:0;transform:translateX(20px)} to{opacity:1;transform:none} }
@keyframes shimmer   { to{background-position:-200% 0} }

.anim-pulse   { animation: pulse 1.8s ease-in-out infinite; }
.anim-spin    { animation: spin 1s linear infinite; }
.anim-fadein  { animation: fadeUp .18s ease both; }
.anim-slidein { animation: slideInX .22s ease both; }

/* Layout */
.wrap { max-width: 1280px; margin: 0 auto; padding: 0 20px; }

/* ── Header ── */
#hdr {
  position: sticky; top: 0; z-index: 200;
  background: rgba(2,6,23,.9);
  backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--border);
}
#hdr-inner {
  height: 54px; display: flex; align-items: center; gap: 10px;
}
.hdr-brand { font-weight: 700; font-size: 15px; letter-spacing: -.01em; }
.hdr-sub   { color: var(--dim); font-size: 13px; }
.hdr-right { margin-left: auto; display: flex; align-items: center; gap: 14px; }

/* ── Badges ── */
.badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 9px; border-radius: 999px;
  font-size: 11px; font-weight: 600;
  letter-spacing: .04em; text-transform: uppercase; white-space: nowrap;
}
.badge-live    { background:var(--rose-dim); color:#fb7185; border:1px solid rgba(244,63,94,.3); }
.badge-conn    { background:var(--emerald-dim); color:#34d399; border:1px solid rgba(16,185,129,.3); }
.badge-warn    { background:var(--amber-dim); color:#fbbf24; border:1px solid rgba(245,158,11,.3); }
.badge-err     { background:var(--rose-dim); color:#fb7185; border:1px solid rgba(244,63,94,.3); }
.badge-neutral { background:rgba(148,163,184,.08); color:var(--muted); border:1px solid rgba(148,163,184,.15); }
.badge-sky     { background:rgba(56,189,248,.1); color:#7dd3fc; border:1px solid rgba(56,189,248,.2); }
.badge-violet  { background:var(--violet-dim); color:#c4b5fd; border:1px solid rgba(139,92,246,.25); }
.badge-ok      { background:var(--emerald-dim); color:#34d399; border:1px solid rgba(16,185,129,.25); }

/* ── Buttons ── */
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 16px; border-radius: 8px;
  font-size: 13px; font-weight: 500; font-family: inherit;
  border: 1px solid transparent; cursor: pointer;
  transition: background .13s, border-color .13s, color .13s, opacity .13s;
  white-space: nowrap; text-decoration: none;
}
.btn:disabled { opacity: .4; cursor: not-allowed; pointer-events: none; }
.btn-primary { background: var(--emerald); color: #fff; border-color: #059669; }
.btn-primary:hover { background: #059669; }
.btn-violet  { background: var(--violet); color: #fff; border-color: #7c3aed; }
.btn-violet:hover  { background: #7c3aed; }
.btn-danger  { background: var(--rose-dim); color: #fb7185; border-color: rgba(244,63,94,.3); }
.btn-danger:hover  { background: rgba(244,63,94,.22); }
.btn-ghost   { background: var(--surface2); color: var(--muted); border-color: var(--border2); }
.btn-ghost:hover   { color: var(--text); background: var(--surface3); }
.btn-amber   { background: var(--amber-dim); color: #fbbf24; border-color: rgba(245,158,11,.3); }
.btn-amber:hover   { background: rgba(245,158,11,.22); }
.btn-sm  { padding: 5px 12px; font-size: 12px; border-radius: 6px; }
.btn-xs  { padding: 3px 8px; font-size: 11px; border-radius: 5px; }

/* ── Forms ── */
.field { display: flex; flex-direction: column; gap: 5px; }
.field > label {
  font-size: 11px; text-transform: uppercase;
  letter-spacing: .07em; color: var(--muted); font-weight: 600;
}
.field input, .field select, .field textarea {
  background: var(--bg); border: 1px solid var(--border2);
  border-radius: 7px; color: var(--text);
  padding: 8px 11px; font-size: 13px; font-family: inherit;
  outline: none; transition: border-color .13s; width: 100%;
}
.field input:focus, .field select:focus, .field textarea:focus {
  border-color: var(--emerald);
  box-shadow: 0 0 0 3px rgba(16,185,129,.1);
}
.field input::placeholder, .field textarea::placeholder { color: var(--dim); }
.field select option { background: var(--surface2); }

/* ── Cards ── */
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 20px;
}
.card-sm { padding: 14px 16px; }
.card-flush { border-radius: 0; border-left: 0; border-right: 0; }

/* ── Stats strip ── */
.stats-strip {
  display: flex; gap: 8px; flex-wrap: wrap;
}
.stat-chip {
  display: flex; flex-direction: column; align-items: center;
  padding: 10px 18px; background: var(--surface2);
  border: 1px solid var(--border); border-radius: 10px; min-width: 76px;
}
.stat-val   { font-size: 21px; font-weight: 700; line-height: 1.15; }
.stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin-top: 2px; }

/* ── Progress bar ── */
.prog-track {
  height: 4px; border-radius: 2px; background: var(--surface2);
  overflow: hidden; position: relative;
}
.prog-fill {
  height: 100%; border-radius: 2px;
  background: linear-gradient(90deg, var(--emerald), #34d399);
  position: absolute; left: 0; top: 0;
  transition: width .25s linear;
  will-change: width;
}

/* ── Queue rows ── */
.q-row {
  display: flex; align-items: center; gap: 10px;
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: 8px; padding: 9px 12px;
  transition: border-color .13s;
}
.q-row:hover      { border-color: var(--border2); }
.q-row.q-current  { border-color: rgba(16,185,129,.45); background: rgba(16,185,129,.04); }
.q-row.q-inactive { opacity: .5; }

/* ── Health dot ── */
.hdot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.hdot-ok     { background: var(--emerald); box-shadow: 0 0 5px rgba(16,185,129,.5); }
.hdot-broken { background: var(--rose); box-shadow: 0 0 5px rgba(244,63,94,.5); }
.hdot-skip   { background: var(--dim); }

/* ── Thumbnails ── */
.thumb {
  width: 54px; height: 34px; border-radius: 4px;
  object-fit: cover; background: var(--surface); flex-shrink: 0; display: block;
}
.thumb-lg {
  width: 120px; height: 72px; border-radius: 8px;
  object-fit: cover; background: var(--surface); flex-shrink: 0; display: block;
}
.thumb-ph {
  display: flex; align-items: center; justify-content: center;
  color: var(--dim); font-size: 9px; text-transform: uppercase; letter-spacing: .07em;
}

/* ── Toasts ── */
#toastRoot {
  position: fixed; top: 66px; right: 18px; z-index: 9000;
  display: flex; flex-direction: column; gap: 8px; pointer-events: none;
  max-width: 360px;
}
.toast {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 12px 14px; border-radius: 10px;
  background: var(--surface); border: 1px solid var(--border2);
  box-shadow: 0 8px 32px rgba(0,0,0,.55);
  font-size: 13px; pointer-events: all;
  animation: slideInX .22s ease both;
}
.toast-ok   { border-color: rgba(16,185,129,.4); }
.toast-err  { border-color: rgba(244,63,94,.4); }
.toast-warn { border-color: rgba(245,158,11,.4); }
.toast-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }

/* ── Skeleton loader ── */
.skel {
  background: linear-gradient(90deg, var(--surface2) 25%, var(--surface3) 50%, var(--surface2) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s ease infinite;
  border-radius: 5px;
}

/* ── Tabs ── */
.tabs {
  display: flex; gap: 2px; background: var(--surface2);
  padding: 3px; border-radius: 9px; margin-bottom: 16px;
}
.tab-btn {
  flex: 1; padding: 7px 14px; border-radius: 7px;
  font-size: 12px; font-weight: 500; font-family: inherit;
  border: none; cursor: pointer;
  background: transparent; color: var(--muted);
  transition: background .12s, color .12s, box-shadow .12s;
}
.tab-btn.active {
  background: var(--surface); color: var(--text);
  box-shadow: 0 1px 4px rgba(0,0,0,.5);
}
.tab-panel { display: none; }
.tab-panel.active { display: block; animation: fadeUp .15s ease both; }

/* ── Section head ── */
.sec-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 12px; gap: 8px;
}
.sec-title {
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .1em; color: var(--muted);
}

/* ── Override banner ── */
#overrideBanner {
  background: linear-gradient(135deg, rgba(139,92,246,.1), rgba(244,63,94,.06));
  border: 1px solid rgba(139,92,246,.35);
  border-radius: 10px; padding: 14px 16px;
  display: none; align-items: center; gap: 14px;
  animation: fadeUp .2s ease both;
}

/* ── Now airing ── */
#nowCard { min-height: 116px; }
.now-inner {
  display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap;
}
.now-body { flex: 1; min-width: 0; }
.now-title {
  font-size: 18px; font-weight: 700; line-height: 1.2; margin-bottom: 6px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ── Up next grid ── */
#upNextGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}
.upcoming-card {
  display: flex; gap: 9px; align-items: center;
}

/* ── Grids ── */
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 680px) { .grid2 { grid-template-columns: 1fr; } }
.col-span2 { grid-column: 1 / -1; }

/* ── Shortcut pill ── */
.kbd {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 4px;
  background: var(--surface3); border: 1px solid var(--border2);
  font-size: 10px; font-weight: 600; color: var(--muted);
}

/* ── Confirm modal ── */
dialog#confirmDlg {
  background: var(--surface); border: 1px solid var(--border2);
  border-radius: 14px; padding: 24px; max-width: 380px; width: 90%;
  color: var(--text); box-shadow: 0 20px 60px rgba(0,0,0,.7);
}
dialog#confirmDlg::backdrop {
  background: rgba(0,0,0,.65); backdrop-filter: blur(4px);
}
dialog#confirmDlg p { font-size: 14px; line-height: 1.5; color: var(--muted); }
dialog#confirmDlg .dlg-title { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
dialog#confirmDlg .dlg-btns  { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }

/* ── Visibility ── */
.hide-mobile { display: flex; }
@media (max-width: 700px) { .hide-mobile { display: none !important; } }

/* ── Auth drawer ── */
#authDrawer {
  display: none; background: var(--surface);
  border-bottom: 1px solid var(--border); padding: 14px 0;
}
#authDrawer .wrap { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }

/* ── Divider ── */
.divider { height: 1px; background: var(--border); margin: 16px 0; }

/* ── Stream Health Panel ── */
#streamHealth {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 14px 16px;
}
.sh-hd {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 11px;
}
.sh-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  background: var(--dim);
}
.sh-dot-ok   { background: var(--emerald); box-shadow: 0 0 5px rgba(16,185,129,.5); }
.sh-dot-warn { background: var(--amber);   box-shadow: 0 0 5px rgba(245,158,11,.5); }
.sh-dot-err  { background: var(--rose);    box-shadow: 0 0 5px rgba(244,63,94,.5); }
.sh-grid {
  display: grid; grid-template-columns: repeat(4,1fr); gap: 10px;
}
@media (max-width: 600px) { .sh-grid { grid-template-columns: 1fr 1fr; } }
.sh-kpi {
  display: flex; flex-direction: column; gap: 3px;
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: 9px; padding: 10px 13px;
}
.sh-val {
  font-size: 20px; font-weight: 700; line-height: 1.15;
  font-variant-numeric: tabular-nums;
}
.sh-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
.sh-sub { font-size: 11px; color: var(--dim); min-height: 1em; }

/* ── Misc ── */
a { color: var(--muted); text-decoration: none; }
a:hover { color: var(--text); }
</style>
</head>
<body>

<!-- ══ CONFIRM MODAL ═════════════════════════════════════════════════════════ -->
<dialog id="confirmDlg">
  <p class="dlg-title" id="dlgTitle">Confirm</p>
  <p id="dlgMsg"></p>
  <div class="dlg-btns">
    <button id="dlgNo"  class="btn btn-ghost btn-sm">Cancel</button>
    <button id="dlgYes" class="btn btn-danger btn-sm">Confirm</button>
  </div>
</dialog>

<!-- ══ TOASTS ════════════════════════════════════════════════════════════════ -->
<div id="toastRoot" aria-live="polite" aria-atomic="false"></div>

<!-- ══ HEADER ════════════════════════════════════════════════════════════════ -->
<header id="hdr">
  <div class="wrap" id="hdr-inner">
    <span id="liveDot" class="anim-pulse"
      style="width:9px;height:9px;border-radius:50%;background:var(--dim);flex-shrink:0;"></span>
    <span class="hdr-brand">Temple TV</span>
    <span class="hdr-sub hide-mobile">Broadcast Control</span>
    <span id="connBadge" class="badge badge-neutral">connecting…</span>

    <div class="hdr-right">
      <span class="hide-mobile" style="font-size:12px;color:var(--dim);">
        viewers&nbsp;<strong id="viewerCount" style="color:var(--emerald);font-variant-numeric:tabular-nums;">0</strong>
      </span>
      <span id="clock" class="hide-mobile"
        style="font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums;min-width:68px;text-align:right;"></span>
      <button id="authBtn" class="btn btn-ghost btn-sm"><span id="authBtnLbl">Set Token</span></button>
      <a href="/docs" class="btn btn-ghost btn-sm hide-mobile" style="font-size:11px;">API Docs</a>
    </div>
  </div>
</header>

<!-- ══ AUTH DRAWER ═══════════════════════════════════════════════════════════ -->
<div id="authDrawer">
  <div class="wrap">
    <div class="field" style="flex:1;min-width:220px;">
      <label>Bearer Token (ADMIN_API_TOKEN or JWT access token)</label>
      <input id="tokenInput" type="password" placeholder="Paste token here…" autocomplete="off" spellcheck="false" />
    </div>
    <button id="saveTokenBtn"  class="btn btn-primary btn-sm">Save &amp; Verify</button>
    <button id="clearTokenBtn" class="btn btn-ghost btn-sm">Clear</button>
    <p id="authStatus" style="width:100%;font-size:12px;color:var(--muted);margin-top:2px;"></p>
  </div>
</div>

<!-- ══ MAIN ══════════════════════════════════════════════════════════════════ -->
<main class="wrap" style="padding-top:22px;padding-bottom:52px;display:flex;flex-direction:column;gap:18px;">

  <!-- Stats strip -->
  <div class="stats-strip">
    <div class="stat-chip">
      <span class="stat-val" id="statViewers" style="color:var(--emerald);">0</span>
      <span class="stat-label">Viewers</span>
    </div>
    <div class="stat-chip">
      <span class="stat-val" id="statQueue">—</span>
      <span class="stat-label">In Queue</span>
    </div>
    <div class="stat-chip">
      <span class="stat-val" id="statActive">—</span>
      <span class="stat-label">Active</span>
    </div>
    <div class="stat-chip">
      <span class="stat-val" id="statBroken">—</span>
      <span class="stat-label">Broken</span>
    </div>
    <div class="stat-chip" style="margin-left:auto;">
      <span class="stat-val" id="statEngine" style="font-size:14px;color:var(--dim);">—</span>
      <span class="stat-label">Engine</span>
    </div>
  </div>

  <!-- Stream Health Panel -->
  <section id="streamHealth">
    <div class="sh-hd">
      <div style="display:flex;align-items:center;gap:7px;">
        <span id="shDot" class="sh-dot"></span>
        <span class="sec-title">Stream Health</span>
      </div>
      <span id="shChecked" style="font-size:11px;color:var(--dim);">loading…</span>
    </div>
    <div class="sh-grid">
      <div class="sh-kpi">
        <span class="sh-val" id="shViewers" style="color:var(--emerald);">—</span>
        <span class="sh-lbl">Viewers</span>
        <span class="sh-sub" id="shSessions"></span>
      </div>
      <div class="sh-kpi">
        <span class="sh-val" id="shEngine">—</span>
        <span class="sh-lbl">Engine</span>
        <span class="sh-sub" id="shEngineAge"></span>
      </div>
      <div class="sh-kpi">
        <span class="sh-val" id="shStalls">—</span>
        <span class="sh-lbl">Stalls / 5 min</span>
        <span class="sh-sub" id="shErrors"></span>
      </div>
      <div class="sh-kpi">
        <span class="sh-val" id="shBuffer">—</span>
        <span class="sh-lbl">Avg Buffer</span>
        <span class="sh-sub">seconds ahead</span>
      </div>
    </div>
  </section>

  <!-- Override banner -->
  <div id="overrideBanner">
    <span class="anim-pulse"
      style="width:10px;height:10px;border-radius:50%;background:var(--violet);flex-shrink:0;"></span>
    <div style="flex:1;min-width:0;">
      <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#c4b5fd;font-weight:700;">
        Live Override Active
      </p>
      <p id="obTitle" style="font-weight:600;font-size:15px;margin-top:2px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></p>
      <p id="obTime" style="font-size:12px;color:var(--muted);margin-top:2px;"></p>
    </div>
    <div style="display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap;">
      <button id="extendBtn" class="btn btn-amber btn-sm">+30 min</button>
      <button id="stopBtn"   class="btn btn-danger btn-sm">Stop Override</button>
    </div>
  </div>

  <!-- Now Airing -->
  <section>
    <div class="sec-head">
      <span class="sec-title">Now Airing</span>
      <span id="snapAge" style="font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums;"></span>
    </div>
    <div class="card" id="nowCard">
      <div style="display:flex;align-items:center;gap:12px;">
        <div class="skel" style="width:120px;height:72px;flex-shrink:0;"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:8px;">
          <div class="skel" style="height:18px;width:60%;"></div>
          <div class="skel" style="height:13px;width:40%;"></div>
          <div class="skel" style="height:4px;"></div>
        </div>
      </div>
    </div>
  </section>

  <!-- Up Next -->
  <section id="upNextSec" style="display:none;">
    <div class="sec-head"><span class="sec-title">Up Next</span></div>
    <div id="upNextGrid"></div>
  </section>

  <!-- Tabs -->
  <section>
    <div class="tabs" id="tabBar">
      <button class="tab-btn active" data-tab="queue">Queue</button>
      <button class="tab-btn" data-tab="golive">Go Live</button>
      <button class="tab-btn" data-tab="additem">Add Item</button>
    </div>

    <!-- ── QUEUE TAB ─────────────────────────────────────────────────────── -->
    <div class="tab-panel active" id="tab-queue">
      <div class="sec-head">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="sec-title">Broadcast Queue</span>
          <span id="healthAlert" class="badge badge-err" style="display:none;">
            <span id="healthBrokenN">0</span> broken
          </span>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span style="font-size:11px;color:var(--dim);" class="hide-mobile">
            <span class="kbd">R</span>&nbsp;refresh &nbsp;<span class="kbd">H</span>&nbsp;health
          </span>
          <button id="reloadQBtn" class="btn btn-ghost btn-sm">↻ Refresh</button>
          <button id="healthBtn"  class="btn btn-ghost btn-sm">⚕ Health</button>
        </div>
      </div>
      <div id="queueList"
        style="display:flex;flex-direction:column;gap:6px;max-height:540px;overflow-y:auto;padding-right:2px;">
        <p id="queueMsg" style="color:var(--dim);font-size:13px;padding:8px 0;">
          Set a token above to manage the queue.
        </p>
      </div>
    </div>

    <!-- ── GO LIVE TAB ────────────────────────────────────────────────────── -->
    <div class="tab-panel" id="tab-golive">
      <div class="grid2">
        <!-- Left: start form -->
        <div style="display:flex;flex-direction:column;gap:14px;">
          <div class="field">
            <label>Override Title <span style="color:var(--rose);">*</span></label>
            <input id="ovTitle" placeholder="e.g. Sunday Morning Service (Live)" />
          </div>
          <div class="field">
            <label>YouTube Video ID or URL</label>
            <input id="ovYtId" placeholder="dQw4w9WgXcQ or youtube.com/watch?v=…" />
          </div>
          <div class="field">
            <label>HLS Stream URL</label>
            <input id="ovHls" placeholder="https://…/stream.m3u8" />
          </div>
          <div class="field">
            <label>RTMP Ingest Key (optional)</label>
            <input id="ovRtmp" placeholder="live_…_key" />
          </div>
          <div class="field">
            <label>Duration (minutes · 0 = indefinite)</label>
            <input id="ovDur" type="number" min="0" max="1440" value="120" />
          </div>
          <div class="field">
            <label>Stream Notes (optional)</label>
            <textarea id="ovNotes" rows="2" placeholder="Internal notes about this broadcast…"
              style="resize:vertical;"></textarea>
          </div>
          <button id="goLiveBtn" class="btn btn-violet">▶ Start Live Override</button>
          <p style="font-size:11px;color:var(--dim);line-height:1.5;">
            Immediately pre-empts the broadcast queue for all connected clients.
            Provide at least one of: YouTube URL, HLS URL, or RTMP key.
          </p>
        </div>
        <!-- Right: history + schedule -->
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div class="card card-sm">
            <div class="sec-head" style="margin-bottom:10px;">
              <span class="sec-title">Recent Overrides</span>
              <button id="refreshRecentBtn" class="btn btn-ghost btn-xs">↻</button>
            </div>
            <div id="recentList" style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);">
              <span>Set a token to view history.</span>
            </div>
          </div>
          <div class="card card-sm">
            <div class="sec-head" style="margin-bottom:10px;">
              <span class="sec-title">Scheduled Overrides</span>
            </div>
            <div id="scheduledList" style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);">
              <span>Set a token to view schedule.</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ── ADD ITEM TAB ───────────────────────────────────────────────────── -->
    <div class="tab-panel" id="tab-additem">
      <form id="addForm" novalidate>
        <div class="grid2" style="gap:14px;">
          <div class="field">
            <label>Title <span style="color:var(--rose);">*</span></label>
            <input id="fi-title" name="title" placeholder="Sermon / worship set title" required />
          </div>
          <div class="field">
            <label>Video Source</label>
            <select id="fi-source" name="videoSource">
              <option value="youtube">YouTube</option>
              <option value="local">Local File (MP4)</option>
              <option value="hls">HLS Stream</option>
            </select>
          </div>
          <div class="field" id="fi-ytRow">
            <label>YouTube Video ID <span style="color:var(--rose);">*</span></label>
            <input id="fi-ytId" name="youtubeId" placeholder="e.g. dQw4w9WgXcQ" />
          </div>
          <div class="field">
            <label>Duration (seconds)</label>
            <input id="fi-dur" name="durationSecs" type="number" min="1" max="43200" value="1800" />
          </div>
          <div class="field col-span2">
            <label>Thumbnail URL</label>
            <input id="fi-thumb" name="thumbnailUrl"
              placeholder="Auto-filled for YouTube — or paste custom URL" />
          </div>
          <div class="field col-span2" id="fi-localRow" style="display:none;">
            <label>Local / HLS Video URL</label>
            <input id="fi-localUrl" name="localVideoUrl"
              placeholder="https://…/video.mp4  or  /hls/stream.m3u8" />
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;margin-top:16px;">
          <button type="submit" id="addBtn" class="btn btn-primary">Add to Queue</button>
          <span id="addMsg" style="font-size:12px;" aria-live="polite"></span>
        </div>
      </form>
    </div>

  </section>

</main>

<footer style="border-top:1px solid var(--border);padding:14px 0;text-align:center;font-size:11px;color:var(--dim);">
  Temple TV Broadcast Control &middot; real-time SSE sync &middot;
  <span id="footerInfo"></span>
</footer>

<script>
/* ============================================================
   BROADCAST CONTROL — CLIENT SCRIPT
   All identifiers scoped to IIFE. No global pollution.
   ============================================================ */
(() => {
"use strict";

// ──────────────────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────────────────
const TOKEN_KEY = "ttv.admin.token.v3";
let token       = sessionStorage.getItem(TOKEN_KEY) || "";
let snapshot    = null;   // BroadcastSnapshot (from /realtime/sse)
let queue       = [];     // BroadcastQueueRow[] (from /broadcast/queue)
let healthMap   = {};     // id → { status, reason }
let liveStatus  = null;   // LiveStatusResponse or null
let healthLoaded = false;
let drawerOpen   = false;
let queueAbort   = null;  // AbortController for in-flight queue fetch

// SSE state
let currentES    = null;  // EventSource instance
let sseBackoff   = 1000;
let sseWatchdog  = null;  // setInterval heartbeat watchdog
let lastSSEPing  = Date.now();

// rAF debounce
let snapReloadScheduled = false;

// ──────────────────────────────────────────────────────────
// UTIL
// ──────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const qs = sel => document.querySelector(sel);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])
  );
}

function fmt(secs) {
  if (secs == null || isNaN(secs)) return "—";
  secs = Math.max(0, Math.round(+secs));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return h + ":" + pad(m) + ":" + pad(s);
  return m + ":" + pad(s);
}
function pad(n) { return String(n).padStart(2, "0"); }

function fmtTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }); }
  catch { return "—"; }
}

function fmtDT(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString([], {
      month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"
    });
  } catch { return "—"; }
}

function authHdrs(extra = {}) {
  const h = { "Content-Type": "application/json" };
  if (token) h["Authorization"] = "Bearer " + token;
  return Object.assign(h, extra);
}

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { ...authHdrs(), ...(init.headers || {}) },
  });
  if (!res.ok) {
    let msg = res.status + " " + res.statusText;
    try { const b = await res.json(); msg = b.message || b.detail || b.error || msg; } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ──────────────────────────────────────────────────────────
// CONFIRM MODAL (replaces browser confirm())
// ──────────────────────────────────────────────────────────
let _dlgResolve = null;

function askConfirm(title, msg, yesLabel = "Confirm", yesClass = "btn-danger") {
  return new Promise(resolve => {
    _dlgResolve = resolve;
    $("dlgTitle").textContent = title;
    $("dlgMsg").textContent   = msg;
    const yesBtn = $("dlgYes");
    yesBtn.textContent = yesLabel;
    yesBtn.className   = "btn btn-sm " + yesClass;
    $("confirmDlg").showModal();
  });
}
$("dlgYes").addEventListener("click", () => {
  if (_dlgResolve) { _dlgResolve(true); _dlgResolve = null; }
  $("confirmDlg").close();
});
$("dlgNo").addEventListener("click", () => {
  if (_dlgResolve) { _dlgResolve(false); _dlgResolve = null; }
  $("confirmDlg").close();
});
$("confirmDlg").addEventListener("close", () => {
  if (_dlgResolve) { _dlgResolve(false); _dlgResolve = null; }
});

// ──────────────────────────────────────────────────────────
// TOASTS
// ──────────────────────────────────────────────────────────
function toast(msg, type = "ok", ms = 4200) {
  const root = $("toastRoot");
  const el = document.createElement("div");
  const icon = type === "ok" ? "✓" : type === "err" ? "✕" : "⚠";
  const col  = type === "ok" ? "var(--emerald)" : type === "err" ? "var(--rose)" : "var(--amber)";
  el.className = "toast toast-" + type;
  el.innerHTML =
    '<span class="toast-icon" style="color:' + col + ';">' + icon + '</span>' +
    '<span>' + esc(msg) + '</span>';
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 320);
  }, ms);
}

// ──────────────────────────────────────────────────────────
// CLOCK (rAF)
// ──────────────────────────────────────────────────────────
function tickClock() {
  $("clock").textContent = new Date().toLocaleTimeString([], {
    hour:"2-digit", minute:"2-digit", second:"2-digit"
  });
  requestAnimationFrame(tickClock);
}
requestAnimationFrame(tickClock);

// ──────────────────────────────────────────────────────────
// PROGRESS BAR + SNAPSHOT AGE (rAF — runs always)
// ──────────────────────────────────────────────────────────
function rafLoop() {
  // Snapshot age — shown in all states when snapshot exists
  if (snapshot) {
    const ageS = Math.round((Date.now() - Date.parse(snapshot.generatedAt)) / 1000);
    const el = $("snapAge");
    if (el) el.textContent = "snapshot " + ageS + "s ago";
  }

  // Progress bar — only when item is live
  if (snapshot && snapshot.current) {
    const c = snapshot.current;
    const startsMs = Date.parse(c.startsAt);
    const endsMs   = Date.parse(c.endsAt);
    const total    = Math.max(1, endsMs - startsMs);
    const elapsed  = Math.min(total, Math.max(0, Date.now() - startsMs));
    const pct      = (elapsed / total * 100).toFixed(3);

    const fill   = $("progFill");
    const elapsed_el = $("progElapsed");
    const remain_el  = $("progRemain");
    if (fill)      fill.style.width = pct + "%";
    if (elapsed_el) elapsed_el.textContent = fmt(elapsed / 1000);
    if (remain_el)  remain_el.textContent  = "−" + fmt((total - elapsed) / 1000);
  }
  requestAnimationFrame(rafLoop);
}
requestAnimationFrame(rafLoop);

// ──────────────────────────────────────────────────────────
// AUTH
// ──────────────────────────────────────────────────────────
function refreshAuthUI() {
  const lbl    = $("authBtnLbl");
  const status = $("authStatus");
  if (token) {
    lbl.textContent = "Token ✓";
    status.textContent = "Authenticated · " + token.slice(0,8) + "…" + token.slice(-4);
    status.style.color = "var(--emerald)";
  } else {
    lbl.textContent = "Set Token";
    status.textContent = "No token — read-only mode. Queue management requires an editor token.";
    status.style.color = "var(--muted)";
  }
}

$("authBtn").addEventListener("click", () => {
  drawerOpen = !drawerOpen;
  $("authDrawer").style.display = drawerOpen ? "block" : "none";
  if (drawerOpen) $("tokenInput").focus();
});

$("saveTokenBtn").addEventListener("click", async () => {
  const v = $("tokenInput").value.trim();
  if (!v) { toast("Paste a token first", "warn"); return; }
  token = v;
  sessionStorage.setItem(TOKEN_KEY, v);
  $("tokenInput").value = "";
  $("authStatus").textContent = "Verifying…";
  $("authStatus").style.color = "var(--muted)";
  // Validate token against a protected endpoint
  try {
    await api("/api/v1/admin/broadcast/health");
    refreshAuthUI();
    toast("Token saved — editor access confirmed");
    $("authDrawer").style.display = "none";
    drawerOpen = false;
    loadQueue();
    loadLiveStatus();
    loadRecentOverrides();
  } catch (e) {
    $("authStatus").textContent = "⚠ Token rejected: " + e.message;
    $("authStatus").style.color = "var(--rose)";
    toast("Token not accepted: " + e.message, "err");
  }
});

$("clearTokenBtn").addEventListener("click", () => {
  token = "";
  sessionStorage.removeItem(TOKEN_KEY);
  refreshAuthUI();
  queue = [];
  renderQueue();
  toast("Token cleared", "warn");
});

refreshAuthUI();

// ──────────────────────────────────────────────────────────
// NOW AIRING RENDER
// ──────────────────────────────────────────────────────────
function renderNowAiring() {
  const card = $("nowCard");
  if (!snapshot) return;

  // If a live override is active, show override info instead of queue item
  const ov = liveStatus && liveStatus.isLive && liveStatus.active ? liveStatus.active : null;

  $("liveDot").style.background = (snapshot.current || ov) ? "var(--emerald)" : "var(--rose)";
  $("statEngine").textContent   = (snapshot.current || ov) ? "Live" : "Idle";
  $("statEngine").style.color   = (snapshot.current || ov) ? "var(--emerald)" : "var(--dim)";

  if (ov) {
    const thumb = ov.youtubeVideoId
      ? '<img class="thumb-lg" src="https://img.youtube.com/vi/' + esc(ov.youtubeVideoId) +
        '/mqdefault.jpg" alt="" onerror="this.classList.add(\\'thumb-ph\\');this.src=\\'\\'" />'
      : '<div class="thumb-lg thumb-ph">No Thumb</div>';
    card.innerHTML =
      '<div class="now-inner">' +
        thumb +
        '<div class="now-body">' +
          '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:6px;">' +
            '<span class="badge badge-violet"><span class="anim-pulse" style="width:5px;height:5px;border-radius:50%;background:var(--violet);"></span>LIVE OVERRIDE</span>' +
          '</div>' +
          '<p class="now-title" title="' + esc(ov.title) + '">' + esc(ov.title) + '</p>' +
          '<p style="font-size:11px;color:var(--dim);">' +
            'Started ' + fmtTime(ov.startedAt) +
            (ov.endsAt ? ' · Ends ' + fmtTime(ov.endsAt) : ' · Indefinite') +
          '</p>' +
        '</div>' +
      '</div>';
    $("upNextSec").style.display = "none";
    return;
  }

  if (!snapshot.current) {
    card.innerHTML =
      '<p style="color:var(--dim);font-size:14px;padding:8px 0;">Channel is idle — queue is empty or all items are inactive.</p>';
    $("upNextSec").style.display = "none";
    return;
  }

  const c = snapshot.current;
  const srcBadge =
    c.videoSource === "youtube" ? '<span class="badge badge-err" style="font-size:10px;">YouTube</span>' :
    c.videoSource === "hls"     ? '<span class="badge badge-sky" style="font-size:10px;">HLS</span>'     :
                                  '<span class="badge badge-neutral" style="font-size:10px;">Local</span>';

  const thumb = c.thumbnailUrl
    ? '<img class="thumb-lg" src="' + esc(c.thumbnailUrl) +
      '" alt="" onerror="this.style.display=\\'none\\'" />'
    : '<div class="thumb-lg thumb-ph">No Thumb</div>';

  card.innerHTML =
    '<div class="now-inner">' +
      thumb +
      '<div class="now-body">' +
        '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:6px;">' +
          '<span class="badge badge-live">' +
            '<span class="anim-pulse" style="width:5px;height:5px;border-radius:50%;background:var(--rose);"></span>On Air' +
          '</span>' +
          srcBadge +
          '<span style="font-size:11px;color:var(--dim);">started ' + fmtTime(c.startsAt) + '</span>' +
        '</div>' +
        '<p class="now-title" title="' + esc(c.title) + '">' + esc(c.title) + '</p>' +
        '<p style="font-size:11px;color:var(--dim);margin-bottom:10px;">' +
          esc(c.id) + (c.youtubeId ? ' · ' + esc(c.youtubeId) : '') +
        '</p>' +
        '<div class="prog-track"><div class="prog-fill" id="progFill" style="width:0%"></div></div>' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:5px;">' +
          '<span id="progElapsed" style="font-variant-numeric:tabular-nums;">0:00</span>' +
          '<span style="color:var(--dim);">' + fmt(c.durationSecs) + ' total</span>' +
          '<span id="progRemain"  style="color:var(--emerald);font-variant-numeric:tabular-nums;"></span>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Render Up Next
  if (snapshot.upcoming && snapshot.upcoming.length > 0) {
    $("upNextSec").style.display = "block";
    $("upNextGrid").innerHTML = snapshot.upcoming.map((it, i) => {
      const th = it.thumbnailUrl
        ? '<img class="thumb" src="' + esc(it.thumbnailUrl) + '" alt="" onerror="this.style.display=\\'none\\'" />'
        : '<div class="thumb thumb-ph">—</div>';
      return '<div class="card card-sm upcoming-card">' + th +
        '<div style="flex:1;min-width:0;">' +
          '<p style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);">' +
            (i === 0 ? "Next" : "#" + (i+1)) + " · " + fmtTime(it.startsAt) +
          '</p>' +
          '<p style="font-size:12px;font-weight:500;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(it.title) + '">' +
            esc(it.title) +
          '</p>' +
          '<p style="font-size:11px;color:var(--dim);margin-top:1px;">' + fmt(it.durationSecs) + '</p>' +
        '</div>' +
      '</div>';
    }).join("");
  } else {
    $("upNextSec").style.display = "none";
  }
}

// ──────────────────────────────────────────────────────────
// QUEUE RENDER
// ──────────────────────────────────────────────────────────
function renderQueue() {
  const list  = $("queueList");
  const msgEl = $("queueMsg");

  if (!token) {
    list.innerHTML = '<p style="color:var(--dim);font-size:13px;padding:8px 0;">Set a token above to manage the queue.</p>';
    return;
  }
  if (queue.length === 0) {
    list.innerHTML = '<p style="color:var(--dim);font-size:13px;padding:8px 0;">Queue is empty. Use "Add Item" to add programs.</p>';
    $("statQueue").textContent  = "0";
    $("statActive").textContent = "0";
    return;
  }

  const activeItems = queue.filter(q => q.isActive);
  $("statQueue").textContent  = queue.length;
  $("statActive").textContent = activeItems.length;

  const currentId = snapshot?.current?.id ?? null;

  list.innerHTML = queue.map((it, i) => {
    const h = healthMap[it.id];
    const hdot = !h ? "" :
      h.status === "ok"     ? '<span class="hdot hdot-ok"     title="Source OK"></span>' :
      h.status === "broken" ? '<span class="hdot hdot-broken" title="' + esc(h.reason || "Broken") + '"></span>' :
                              '<span class="hdot hdot-skip"   title="Inactive"></span>';

    const isPlaying = it.id === currentId;
    const rowCls = "q-row" +
      (isPlaying  ? " q-current"  : "") +
      (!it.isActive ? " q-inactive" : "");

    const th = it.thumbnailUrl
      ? '<img class="thumb" src="' + esc(it.thumbnailUrl) + '" alt="" onerror="this.style.display=\\'none\\'" />'
      : '<div class="thumb thumb-ph">—</div>';

    return '<div class="' + rowCls + '" data-id="' + esc(it.id) + '">' +
      // Reorder arrows
      '<div style="display:flex;flex-direction:column;gap:2px;flex-shrink:0;">' +
        '<button data-act="up"   class="btn btn-ghost btn-xs" style="padding:2px 5px;" title="Move up"   ' + (i === 0            ? "disabled" : "") + '>↑</button>' +
        '<button data-act="down" class="btn btn-ghost btn-xs" style="padding:2px 5px;" title="Move down" ' + (i === queue.length-1 ? "disabled" : "") + '>↓</button>' +
      '</div>' +
      th +
      '<span style="flex-shrink:0;">' + hdot + '</span>' +
      '<div style="flex:1;min-width:0;">' +
        '<p style="font-size:13px;font-weight:' + (isPlaying ? 700 : 500) + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(it.title) + '">' +
          (isPlaying ? '<span class="badge badge-live" style="font-size:10px;margin-right:6px;vertical-align:middle;">On Air</span>' : '') +
          esc(it.title) +
        '</p>' +
        '<p style="font-size:11px;color:var(--dim);margin-top:1px;">' +
          esc(it.videoSource) + ' · ' + fmt(it.durationSecs) +
          (it.youtubeId && !it.youtubeId.startsWith("local-") ? ' · ' + esc(it.youtubeId) : '') +
        '</p>' +
      '</div>' +
      '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;flex-shrink:0;user-select:none;">' +
        '<input type="checkbox" data-act="toggle" ' + (it.isActive ? "checked" : "") +
          ' style="accent-color:var(--emerald);width:15px;height:15px;cursor:pointer;" />' +
        '<span style="font-size:11px;color:var(--muted);">Active</span>' +
      '</label>' +
      '<button data-act="del" class="btn btn-danger btn-xs" title="Remove from queue">✕</button>' +
    '</div>';
  }).join("");

  // Wire row events
  list.querySelectorAll("[data-id]").forEach(row => {
    const id = row.dataset.id;
    row.querySelector('[data-act="up"]')    ?.addEventListener("click", () => moveItem(id, -1));
    row.querySelector('[data-act="down"]')  ?.addEventListener("click", () => moveItem(id, +1));
    row.querySelector('[data-act="toggle"]')?.addEventListener("change", e => toggleItem(id, e.target.checked));
    row.querySelector('[data-act="del"]')   ?.addEventListener("click", () => deleteItem(id));
  });
}

// ──────────────────────────────────────────────────────────
// QUEUE ACTIONS
// ──────────────────────────────────────────────────────────
async function loadQueue() {
  if (!token) { renderQueue(); return; }

  // Abort any in-flight request to prevent stale overwrites
  if (queueAbort) queueAbort.abort();
  queueAbort = new AbortController();
  const { signal } = queueAbort;

  const listEl = $("queueList");
  listEl.innerHTML =
    '<div style="display:flex;flex-direction:column;gap:6px;">' +
    Array.from({length:3}).map(() =>
      '<div class="skel" style="height:52px;border-radius:8px;"></div>'
    ).join("") + '</div>';

  try {
    const data = await api("/api/v1/broadcast/queue", { signal });
    queue = Array.isArray(data) ? data : [];
    renderQueue();
    // Refresh health dots if already loaded once
    if (healthLoaded) await loadHealth(true);
  } catch (e) {
    if (e.name === "AbortError") return;
    listEl.innerHTML =
      '<p style="color:var(--rose);font-size:13px;padding:8px 0;">Failed to load queue: ' + esc(e.message) + '</p>';
  } finally {
    queueAbort = null;
  }
}

async function moveItem(id, delta) {
  const idx = queue.findIndex(q => q.id === id);
  if (idx < 0) return;
  const j = idx + delta;
  if (j < 0 || j >= queue.length) return;
  const ordered = [...queue];
  [ordered[idx], ordered[j]] = [ordered[j], ordered[idx]];
  try {
    await api("/api/v1/broadcast/queue/reorder", {
      method: "POST",
      body: JSON.stringify({ itemIds: ordered.map(x => x.id) }),
    });
    await loadQueue();
  } catch (e) {
    toast("Reorder failed: " + e.message, "err");
  }
}

async function toggleItem(id, isActive) {
  try {
    await api("/api/v1/broadcast/queue/" + encodeURIComponent(id) + "/active", {
      method: "PATCH",
      body: JSON.stringify({ isActive }),
    });
    await loadQueue();
    toast(isActive ? "Item activated" : "Item deactivated");
  } catch (e) {
    toast("Toggle failed: " + e.message, "err");
    await loadQueue(); // restore true state
  }
}

async function deleteItem(id) {
  const item = queue.find(q => q.id === id);
  if (!item) return;
  const ok = await askConfirm(
    "Remove from queue",
    '"' + item.title + '" will be permanently removed from the broadcast queue.',
    "Remove", "btn-danger"
  );
  if (!ok) return;
  try {
    await api("/api/v1/broadcast/queue/" + encodeURIComponent(id), { method: "DELETE" });
    await loadQueue();
    toast("Removed: " + item.title);
  } catch (e) {
    toast("Delete failed: " + e.message, "err");
  }
}

$("reloadQBtn").addEventListener("click", loadQueue);

// ──────────────────────────────────────────────────────────
// HEALTH CHECK
// ──────────────────────────────────────────────────────────
async function loadHealth(silent = false) {
  if (!token) { if (!silent) toast("Set a token to check health", "warn"); return; }
  try {
    const h = await api("/api/v1/admin/broadcast/health");
    healthMap = {};
    for (const item of h.items) healthMap[item.id] = item;
    healthLoaded = true;

    const broken = h.summary.broken;
    $("statBroken").textContent   = broken;
    $("statBroken").style.color   = broken > 0 ? "var(--rose)" : "var(--emerald)";
    const alert = $("healthAlert");
    if (broken > 0) {
      $("healthBrokenN").textContent = broken;
      alert.style.display = "inline-flex";
    } else {
      alert.style.display = "none";
    }
    renderQueue();
    if (!silent) toast(broken > 0 ? broken + " broken item(s) found" : "All items healthy", broken > 0 ? "warn" : "ok");
  } catch (e) {
    if (!silent) toast("Health check failed: " + e.message, "err");
  }
}

$("healthBtn").addEventListener("click", () => loadHealth(false));

// ──────────────────────────────────────────────────────────
// ADD ITEM FORM
// ──────────────────────────────────────────────────────────
const srcSel = $("fi-source");

function updateAddFields() {
  const src = srcSel.value;
  const ytRow    = $("fi-ytRow");
  const localRow = $("fi-localRow");
  const showYt    = src === "youtube";
  const showLocal = src === "local" || src === "hls";

  // Single style.display call — no duplicate attribute issue
  ytRow.style.display    = showYt    ? "flex" : "none";
  localRow.style.display = showLocal ? "flex" : "none";
  // Preserve grid-column via JS when shown
  if (showLocal) localRow.style.gridColumn = "1 / -1";
  $("fi-ytId").required = showYt;
}
srcSel.addEventListener("change", updateAddFields);
updateAddFields();

// Auto-fill thumbnail from YouTube ID
$("fi-ytId").addEventListener("input", e => {
  const id = e.target.value.trim();
  const thumbInput = $("fi-thumb");
  if (id.length >= 8) {
    const bare = id.replace(/.*[?&]v=([^&]+).*/, "$1")  // watch?v=
                   .replace(/.*youtu[.]be[/]([^?]+).*/, "$1"); // youtu.be/
    thumbInput.value = "https://img.youtube.com/vi/" + bare + "/mqdefault.jpg";
  } else {
    thumbInput.value = "";
  }
});

$("addForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!token) { toast("Set a token to add items", "warn"); return; }

  const title    = $("fi-title").value.trim();
  const src      = srcSel.value;
  const ytId     = $("fi-ytId").value.trim();
  const dur      = Math.max(1, Number($("fi-dur").value) || 1800);
  const thumb    = $("fi-thumb").value.trim();
  const localUrl = $("fi-localUrl").value.trim();

  if (!title) { toast("Title is required", "warn"); return; }
  if (src === "youtube" && !ytId) { toast("YouTube Video ID is required", "warn"); return; }

  const body = {
    title,
    ...(ytId ? { youtubeId: ytId } : {}),
    durationSecs: dur,
    thumbnailUrl: thumb,
    videoSource: src,
    ...(localUrl ? { localVideoUrl: localUrl } : {}),
  };

  const btn = $("addBtn"), msg = $("addMsg");
  btn.disabled = true;
  msg.textContent = "Adding…"; msg.style.color = "var(--muted)";
  try {
    await api("/api/v1/broadcast/queue", { method: "POST", body: JSON.stringify(body) });
    msg.textContent = "✓ Added"; msg.style.color = "var(--emerald)";
    e.target.reset();
    updateAddFields();
    await loadQueue();
    toast("Added: " + title);
    setTimeout(() => { msg.textContent = ""; }, 3000);
  } catch (err) {
    msg.textContent = "✕ " + err.message; msg.style.color = "var(--rose)";
    toast(err.message, "err");
    setTimeout(() => { msg.textContent = ""; }, 5000);
  } finally {
    btn.disabled = false;
  }
});

// ──────────────────────────────────────────────────────────
// LIVE OVERRIDE
// ──────────────────────────────────────────────────────────
async function loadLiveStatus() {
  try {
    const s = await api("/api/v1/live/status");
    liveStatus = (s.isLive && s.active) ? s : null;
    renderOverrideBanner();
    renderNowAiring();
  } catch {}
}

function renderOverrideBanner() {
  const banner = $("overrideBanner");
  if (!liveStatus) { banner.style.display = "none"; return; }
  const ov = liveStatus.active;
  banner.style.display = "flex";
  $("obTitle").textContent = ov.title || "Live Stream";
  $("obTime").textContent = ov.endsAt
    ? "Ends " + fmtTime(ov.endsAt) + " · " + fmtDT(ov.endsAt)
    : "Indefinite";
}

$("goLiveBtn").addEventListener("click", async () => {
  if (!token) { toast("Set a token to go live", "warn"); return; }
  const title = $("ovTitle").value.trim();
  const ytRaw = $("ovYtId").value.trim();
  const hls   = $("ovHls").value.trim();
  const rtmp  = $("ovRtmp").value.trim();
  const durMin = Number($("ovDur").value) || 0;
  const notes = $("ovNotes").value.trim();

  if (!title) { toast("Title is required", "warn"); return; }
  if (!ytRaw && !hls && !rtmp) { toast("Provide a YouTube URL, HLS URL, or RTMP key", "warn"); return; }

  const body = {
    title,
    youtubeUrl:   ytRaw || null,
    hlsStreamUrl: hls   || null,
    rtmpIngestKey: rtmp || null,
    streamNotes:  notes || null,
    endsAt: durMin > 0 ? new Date(Date.now() + durMin * 60_000).toISOString() : null,
  };

  $("goLiveBtn").disabled = true;
  try {
    await api("/api/v1/live/start", { method: "POST", body: JSON.stringify(body) });
    toast("Live override started: " + title);
    await loadLiveStatus();
    await loadRecentOverrides();
  } catch (e) {
    toast("Failed to start: " + e.message, "err");
  } finally {
    $("goLiveBtn").disabled = false;
  }
});

$("stopBtn").addEventListener("click", async () => {
  if (!token) return;
  const ok = await askConfirm(
    "Stop live override",
    "Broadcast will return to the scheduled queue for all connected clients.",
    "Stop Override", "btn-danger"
  );
  if (!ok) return;
  try {
    await api("/api/v1/live/stop", { method: "POST" });
    toast("Live override stopped — returning to queue");
    liveStatus = null;
    renderOverrideBanner();
    renderNowAiring();
    await loadRecentOverrides();
  } catch (e) {
    toast("Stop failed: " + e.message, "err");
  }
});

$("extendBtn").addEventListener("click", async () => {
  if (!token) return;
  try {
    await api("/api/v1/live/extend", {
      method: "POST", body: JSON.stringify({ extraMinutes: 30 }),
    });
    toast("Extended by 30 minutes");
    await loadLiveStatus();
  } catch (e) {
    toast("Extend failed: " + e.message, "err");
  }
});

async function loadRecentOverrides() {
  if (!token) return;
  const el = $("recentList");
  try {
    const r = await api("/api/v1/live/recent");
    if (!r.items || r.items.length === 0) {
      el.innerHTML = '<span style="color:var(--dim);">No recent overrides.</span>'; return;
    }
    el.innerHTML = r.items.slice(0,8).map(it =>
      '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);gap:8px;">' +
        '<span style="color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;" title="' + esc(it.title) + '">' +
          (it.isActive ? '<span class="badge badge-violet" style="font-size:9px;margin-right:4px;">live</span>' : '') +
          esc(it.title) +
        '</span>' +
        '<span style="color:var(--dim);flex-shrink:0;">' + fmtDT(it.startedAt) + '</span>' +
      '</div>'
    ).join("");
  } catch { el.innerHTML = '<span style="color:var(--rose);">Failed to load.</span>'; }
}

async function loadScheduledOverrides() {
  if (!token) return;
  const el = $("scheduledList");
  try {
    const r = await api("/api/v1/live/scheduled");
    if (!r.items || r.items.length === 0) {
      el.innerHTML = '<span style="color:var(--dim);">No upcoming scheduled overrides.</span>'; return;
    }
    el.innerHTML = r.items.map(it =>
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);gap:8px;">' +
        '<div style="flex:1;min-width:0;">' +
          '<p style="color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(it.title) + '</p>' +
          '<p style="color:var(--dim);">' + fmtDT(it.scheduledFor || it.startedAt) + '</p>' +
        '</div>' +
        '<button data-cid="' + esc(it.id) + '" class="btn btn-danger btn-xs">Cancel</button>' +
      '</div>'
    ).join("");
    el.querySelectorAll("[data-cid]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const cid = btn.dataset.cid;
        const ok = await askConfirm("Cancel scheduled override", "This cannot be undone.", "Cancel Override", "btn-danger");
        if (!ok) return;
        try {
          await api("/api/v1/live/scheduled/" + encodeURIComponent(cid), { method: "DELETE" });
          toast("Scheduled override cancelled");
          await loadScheduledOverrides();
        } catch (e) { toast("Cancel failed: " + e.message, "err"); }
      });
    });
  } catch { el.innerHTML = '<span style="color:var(--rose);">Failed to load.</span>'; }
}

$("refreshRecentBtn").addEventListener("click", () => {
  loadRecentOverrides();
  loadScheduledOverrides();
});

// ──────────────────────────────────────────────────────────
// BROADCAST CURRENT (HTTP fallback poll + initial load)
// ──────────────────────────────────────────────────────────
async function loadCurrent() {
  try {
    const raw = await api("/api/v1/broadcast/current");
    // Map BroadcastCurrentResultDto → internal snapshot shape
    snapshot = {
      channelId:    "temple-tv-live",
      generatedAt:  raw.syncedAt || new Date().toISOString(),
      current:      raw.item || null,
      next:         raw.nextItem || null,
      upcoming:     raw.upcomingItems || [],
      preloadAt:    null,
      failoverHlsUrl: null,
    };
    // Override liveOverride from the richer /broadcast/current response
    if (raw.liveOverride && !liveStatus) {
      liveStatus = { isLive: true, active: raw.liveOverride };
      renderOverrideBanner();
    }
    renderNowAiring();
  } catch {}
}

async function loadViewers() {
  try {
    const r = await api("/api/v1/broadcast/viewers");
    const n = r.count ?? 0;
    $("viewerCount").textContent = n;
    $("statViewers").textContent = n;
  } catch {}
}

// ──────────────────────────────────────────────────────────
// SSE — /api/v1/realtime/sse
// Events: snapshot · advance · preload · viewer-count
// ──────────────────────────────────────────────────────────
function connectSSE() {
  if (currentES) { currentES.close(); currentES = null; }
  if (sseWatchdog) { clearInterval(sseWatchdog); sseWatchdog = null; }

  let es;
  try { es = new EventSource("/api/v1/realtime/sse"); }
  catch { setConnBadge("SSE unavailable", "warn"); return; }
  currentES = es;

  es.onopen = () => {
    setConnBadge("live", "conn");
    sseBackoff = 1000;
    lastSSEPing = Date.now();
    $("footerInfo").textContent = "SSE connected · " + new Date().toLocaleTimeString();
  };

  es.onerror = () => {
    setConnBadge("reconnecting…", "warn");
    $("footerInfo").textContent = "SSE disconnected — retrying in " + Math.round(sseBackoff/1000) + "s…";
    es.close();
    currentES = null;
    if (sseWatchdog) clearInterval(sseWatchdog);
    setTimeout(connectSSE, sseBackoff);
    sseBackoff = Math.min(sseBackoff * 1.6, 30_000);
  };

  // snapshot — full BroadcastSnapshot (on connect + after each reload)
  es.addEventListener("snapshot", ev => {
    try {
      snapshot = JSON.parse(ev.data);
      lastSSEPing = Date.now();
      renderNowAiring();
    } catch {}
  });

  // advance — { channelId, current } — program transitioned
  // Strategy: accept the partial update immediately for instant UI, then
  // schedule a full snapshot reload (debounced) to get updated upcoming list.
  es.addEventListener("advance", ev => {
    try {
      const d = JSON.parse(ev.data);
      lastSSEPing = Date.now();
      if (snapshot) {
        snapshot.current = d.current;
        snapshot.generatedAt = new Date().toISOString();
        renderNowAiring();
      }
      // Debounced full reload so upcoming list refreshes once, not on every rapid advance
      if (!snapReloadScheduled) {
        snapReloadScheduled = true;
        setTimeout(() => { snapReloadScheduled = false; loadCurrent(); }, 800);
      }
    } catch {}
  });

  // preload — { channelId, next } — next item warming up
  es.addEventListener("preload", ev => {
    try {
      const d = JSON.parse(ev.data);
      lastSSEPing = Date.now();
      // Optimistically update the snapshot.next so Up Next reflects the change
      if (snapshot && d.next) {
        snapshot.next = d.next;
      }
    } catch {}
  });

  // viewer-count — { channelId, count }
  es.addEventListener("viewer-count", ev => {
    try {
      const d = JSON.parse(ev.data);
      lastSSEPing = Date.now();
      if (typeof d.count === "number") {
        $("viewerCount").textContent = d.count;
        $("statViewers").textContent = d.count;
      }
    } catch {}
  });

  // Watchdog: if no ping for 60s the SSE stream is silently dead → reconnect
  sseWatchdog = setInterval(() => {
    if (Date.now() - lastSSEPing > 60_000) {
      $("footerInfo").textContent = "SSE watchdog triggered reconnect";
      connectSSE();
    }
  }, 20_000);
}

function setConnBadge(text, type) {
  const el = $("connBadge");
  el.textContent = text;
  el.className   = "badge " + (
    type === "conn" ? "badge-conn" :
    type === "warn" ? "badge-warn" : "badge-neutral"
  );
  $("liveDot").style.background =
    type === "conn" ? "var(--emerald)" :
    type === "warn" ? "var(--amber)"   : "var(--dim)";
}

// Reconnect when page becomes visible after being hidden
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    const dead = !currentES || currentES.readyState === EventSource.CLOSED;
    if (dead) {
      connectSSE();
    }
    // Also refresh data that may have gone stale while hidden
    loadCurrent();
    loadLiveStatus();
    loadViewers();
  }
});

// ──────────────────────────────────────────────────────────
// TABS
// ──────────────────────────────────────────────────────────
$("tabBar").querySelectorAll(".tab-btn").forEach(tab => {
  tab.addEventListener("click", () => {
    $("tabBar").querySelectorAll(".tab-btn").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab)?.classList.add("active");
    if (tab.dataset.tab === "golive" && token) {
      loadRecentOverrides();
      loadScheduledOverrides();
    }
  });
});

// ──────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ──────────────────────────────────────────────────────────
document.addEventListener("keydown", e => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.key === "Escape" && $("confirmDlg").open) { $("confirmDlg").close(); return; }
  if (e.key === "r" || e.key === "R") { e.preventDefault(); loadQueue(); }
  if (e.key === "h" || e.key === "H") { e.preventDefault(); loadHealth(false); }
});

// ──────────────────────────────────────────────────────────
// STREAM HEALTH PANEL — polls /health/live every 5 s (no auth)
// ──────────────────────────────────────────────────────────
function renderStreamHealth(d) {
  const dot = $("shDot");
  const healthy = d.ok && d.broadcast.engineHealthy;
  dot.className = "sh-dot " + (
    healthy                      ? "sh-dot-ok"   :
    d.broadcast.engineRunning    ? "sh-dot-warn"  : "sh-dot-err"
  );

  // Viewers
  $("shViewers").textContent = d.viewers.total;
  const sess = d.telemetry.activeSessions;
  $("shSessions").textContent = sess > 0
    ? sess + " active session" + (sess !== 1 ? "s" : "")
    : "";

  // Engine
  const engTxt = !d.broadcast.engineRunning ? "Stopped"
               : d.broadcast.engineHealthy  ? "Healthy" : "Stale";
  const engEl  = $("shEngine");
  engEl.textContent  = engTxt;
  engEl.style.color  = !d.broadcast.engineRunning ? "var(--rose)"
                     : d.broadcast.engineHealthy  ? "var(--emerald)" : "var(--amber)";
  const ageS = Math.round(d.broadcast.lastSnapshotAgeMs / 1000);
  $("shEngineAge").textContent = "snap " + ageS + "s ago";

  // Stalls
  const stallEl = $("shStalls");
  stallEl.textContent  = d.telemetry.totalStalls;
  stallEl.style.color  = d.telemetry.totalStalls > 0 ? "var(--amber)" : "var(--text)";
  const errs = d.telemetry.totalErrors;
  $("shErrors").textContent = errs > 0
    ? errs + " error" + (errs !== 1 ? "s" : "")
    : "";

  // Avg buffer
  const buf    = d.telemetry.avgBufferedSecs;
  const bufEl  = $("shBuffer");
  bufEl.textContent = buf != null ? buf.toFixed(1) + "s" : "—";
  bufEl.style.color = buf == null ? "var(--dim)"
                    : buf < 2    ? "var(--rose)"
                    : buf < 5    ? "var(--amber)" : "var(--emerald)";

  // Last-checked timestamp
  try {
    $("shChecked").textContent = "updated " +
      new Date(d.checkedAt).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", second:"2-digit" });
  } catch {}
}

async function pollStreamHealth() {
  try {
    const d = await fetch("/health/live").then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    renderStreamHealth(d);
  } catch {
    $("shDot").className       = "sh-dot sh-dot-err";
    $("shChecked").textContent = "health check failed";
  }
}

pollStreamHealth();
setInterval(pollStreamHealth, 5_000);

// ──────────────────────────────────────────────────────────
// BOOT
// ──────────────────────────────────────────────────────────
connectSSE();
loadCurrent();
loadViewers();
loadLiveStatus();

if (token) {
  loadQueue();
  // Stagger health check so it doesn't compete with queue on startup
  setTimeout(() => loadHealth(true), 2500);
}

// Polling safety nets (SSE is primary, these are fallbacks)
setInterval(loadCurrent,    30_000);
setInterval(loadViewers,    15_000);
setInterval(loadLiveStatus, 25_000);

})();
</script>
</body>
</html>`;

export async function adminUiRoutes(app: FastifyInstance) {
  // /admin is intercepted by Replit's reverse proxy in development environments.
  // The admin UI is served at /dashboard/broadcast with /admin/* as aliases
  // for production deployments where no proxy restriction applies.

  app.get("/dashboard", {
    schema: { hide: true, response: { 429: z.object({ error: z.string() }) } },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (_req, reply) => {
    reply.redirect("/dashboard/broadcast", 302);
  });

  // compress: false — Replit's proxy drops gzip-encoded HTML (Content-Length: 0 bug)
  app.get("/dashboard/broadcast", {
    schema: { hide: true, response: { 429: z.object({ error: z.string() }) } },
    compress: false,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (_req, reply) => {
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .send(HTML);
  });

  app.get("/admin", {
    schema: { hide: true, response: { 429: z.object({ error: z.string() }) } },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (_req, reply) => {
    reply.redirect("/dashboard/broadcast", 302);
  });

  app.get("/admin/broadcast", {
    schema: { hide: true, response: { 429: z.object({ error: z.string() }) } },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (_req, reply) => {
    reply.redirect("/dashboard/broadcast", 302);
  });
}
