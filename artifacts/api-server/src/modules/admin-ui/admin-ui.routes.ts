import type { FastifyInstance } from "fastify";

const HTML = String.raw`<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Temple TV — Broadcast Control</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .pulse-dot { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  .scroll-shadow::-webkit-scrollbar { width: 8px }
  .scroll-shadow::-webkit-scrollbar-thumb { background: #2a2f3a; border-radius: 4px }
  details > summary::-webkit-details-marker { display: none }
</style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen">
  <header class="border-b border-slate-800 bg-slate-900/70 backdrop-blur sticky top-0 z-10">
    <div class="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
      <div class="flex items-center gap-2">
        <span id="liveDot" class="pulse-dot inline-block w-2.5 h-2.5 rounded-full bg-rose-500"></span>
        <h1 class="text-lg font-semibold tracking-tight">Temple TV — Broadcast Control</h1>
      </div>
      <span id="connBadge" class="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">connecting…</span>
      <div class="ml-auto flex items-center gap-3">
        <span class="text-xs text-slate-500">viewers</span>
        <span id="viewers" class="text-sm font-semibold text-emerald-400">0</span>
        <a href="/docs" class="text-xs text-slate-400 hover:text-slate-100 underline-offset-2 hover:underline">API docs</a>
      </div>
    </div>
  </header>

  <main class="max-w-6xl mx-auto px-6 py-8 space-y-8">

    <section class="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <details>
        <summary class="cursor-pointer flex items-center justify-between">
          <div>
            <p class="text-xs uppercase tracking-wider text-slate-500">Authentication</p>
            <p id="authStatus" class="text-sm text-slate-300">No token — read-only mode</p>
          </div>
          <span class="text-xs text-slate-500">click to set</span>
        </summary>
        <div class="mt-4 grid sm:grid-cols-[1fr_auto_auto] gap-2">
          <input id="tokenInput" type="password" placeholder="Bearer token (ADMIN_API_TOKEN or JWT access token)"
                 class="px-3 py-2 rounded bg-slate-950 border border-slate-800 text-sm focus:outline-none focus:border-emerald-500" />
          <button id="saveToken" class="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-sm font-medium">Save</button>
          <button id="clearToken" class="px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 text-sm">Clear</button>
        </div>
        <p class="mt-2 text-xs text-slate-500">Stored in your browser only. Used as <code class="text-emerald-400">Authorization: Bearer …</code> on admin requests.</p>
      </details>
    </section>

    <section>
      <h2 class="text-sm uppercase tracking-wider text-slate-500 mb-3">Now Airing</h2>
      <div id="nowCard" class="rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950 p-6">
        <p class="text-slate-500 text-sm">Loading snapshot…</p>
      </div>
    </section>

    <section>
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-sm uppercase tracking-wider text-slate-500">Up Next</h2>
        <span id="snapshotAge" class="text-xs text-slate-600"></span>
      </div>
      <div id="upcoming" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"></div>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <h2 class="text-sm uppercase tracking-wider text-slate-500 mb-4">Add to queue</h2>
      <form id="addForm" class="grid sm:grid-cols-2 gap-3">
        <div class="sm:col-span-2">
          <label class="text-xs text-slate-400">Title <span class="text-rose-400">*</span></label>
          <input name="title" required class="mt-1 w-full px-3 py-2 rounded bg-slate-950 border border-slate-800 text-sm focus:outline-none focus:border-emerald-500" />
        </div>
        <div>
          <label class="text-xs text-slate-400">YouTube ID <span class="text-rose-400">*</span></label>
          <input name="youtubeId" required class="mt-1 w-full px-3 py-2 rounded bg-slate-950 border border-slate-800 text-sm focus:outline-none focus:border-emerald-500" />
        </div>
        <div>
          <label class="text-xs text-slate-400">Duration (seconds)</label>
          <input name="durationSecs" type="number" min="1" value="1800" class="mt-1 w-full px-3 py-2 rounded bg-slate-950 border border-slate-800 text-sm focus:outline-none focus:border-emerald-500" />
        </div>
        <div class="sm:col-span-2">
          <label class="text-xs text-slate-400">Thumbnail URL</label>
          <input name="thumbnailUrl" class="mt-1 w-full px-3 py-2 rounded bg-slate-950 border border-slate-800 text-sm focus:outline-none focus:border-emerald-500" />
        </div>
        <div>
          <label class="text-xs text-slate-400">Source</label>
          <select name="videoSource" class="mt-1 w-full px-3 py-2 rounded bg-slate-950 border border-slate-800 text-sm focus:outline-none focus:border-emerald-500">
            <option value="youtube">youtube</option>
            <option value="local">local</option>
            <option value="hls">hls</option>
          </select>
        </div>
        <div class="sm:col-span-2">
          <label class="text-xs text-slate-400">Local video URL (only if source = local)</label>
          <input name="localVideoUrl" class="mt-1 w-full px-3 py-2 rounded bg-slate-950 border border-slate-800 text-sm focus:outline-none focus:border-emerald-500" />
        </div>
        <div class="sm:col-span-2 flex items-center gap-3">
          <button type="submit" id="addBtn"
                  class="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed">
            Add to queue
          </button>
          <span id="addMsg" class="text-xs text-slate-400"></span>
        </div>
      </form>
    </section>

    <section>
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-sm uppercase tracking-wider text-slate-500">Full Queue</h2>
        <button id="reloadQueue" class="text-xs text-slate-400 hover:text-slate-100">refresh</button>
      </div>
      <div id="queueList" class="space-y-2 max-h-[600px] overflow-y-auto scroll-shadow pr-1"></div>
    </section>

    <footer class="pt-8 pb-12 text-center text-xs text-slate-600">
      Temple TV API v1 · live updates over Server-Sent Events
    </footer>
  </main>

<script>
(() => {
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const TOKEN_KEY = "templetv.admin.token";
  let token = localStorage.getItem(TOKEN_KEY) || "";
  let snapshot = null;
  let queue = [];
  let snapshotTimer = null;

  // ---------- helpers ----------
  function authHeaders() {
    return token ? { Authorization: "Bearer " + token } : {};
  }
  async function api(path, init = {}) {
    const res = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
        ...(init.headers || {}),
      },
    });
    if (!res.ok) {
      let msg = res.status + " " + res.statusText;
      try { const b = await res.json(); msg = b.title || b.detail || b.message || msg; } catch {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }
  function fmtSecs(s) {
    if (!s && s !== 0) return "—";
    const m = Math.floor(s / 60), r = s % 60;
    return m + ":" + String(r).padStart(2, "0");
  }
  function setBadge(text, color) {
    const el = $("#connBadge");
    el.textContent = text;
    el.className = "text-xs px-2 py-0.5 rounded-full " + color;
  }
  function setAuthStatus() {
    if (!token) {
      $("#authStatus").textContent = "No token — read-only mode";
      $("#authStatus").className = "text-sm text-slate-300";
    } else {
      $("#authStatus").textContent = "Token saved · " + token.slice(0, 6) + "…" + token.slice(-4);
      $("#authStatus").className = "text-sm text-emerald-400";
    }
  }

  // ---------- auth controls ----------
  setAuthStatus();
  $("#saveToken").addEventListener("click", () => {
    const v = $("#tokenInput").value.trim();
    if (!v) return;
    token = v;
    localStorage.setItem(TOKEN_KEY, v);
    $("#tokenInput").value = "";
    setAuthStatus();
    loadQueue();
  });
  $("#clearToken").addEventListener("click", () => {
    token = "";
    localStorage.removeItem(TOKEN_KEY);
    setAuthStatus();
    loadQueue();
  });

  // ---------- snapshot rendering ----------
  function renderSnapshot() {
    const card = $("#nowCard");
    if (!snapshot || !snapshot.current) {
      card.innerHTML = '<p class="text-slate-400 text-sm">Channel is idle — no item is currently airing.</p>';
      $("#upcoming").innerHTML = "";
      return;
    }
    const c = snapshot.current;
    const startsAt = new Date(c.startsAt).getTime();
    const endsAt = new Date(c.endsAt).getTime();
    const total = Math.max(1, Math.round((endsAt - startsAt) / 1000));
    const elapsed = Math.max(0, Math.min(total, Math.round((Date.now() - startsAt) / 1000)));
    const pct = Math.round((elapsed / total) * 100);
    const remaining = total - elapsed;
    card.innerHTML =
      '<div class="grid sm:grid-cols-[160px_1fr] gap-5">' +
      (c.thumbnailUrl
        ? '<img src="' + escapeAttr(c.thumbnailUrl) + '" alt="" class="rounded-lg w-40 h-24 object-cover bg-slate-800" />'
        : '<div class="rounded-lg w-40 h-24 bg-slate-800 grid place-items-center text-slate-600 text-xs">no thumb</div>') +
      '<div>' +
        '<p class="text-xs uppercase tracking-wider text-emerald-400">live · ' + escape(c.videoSource) + '</p>' +
        '<h3 class="text-2xl font-semibold mt-1">' + escape(c.title) + '</h3>' +
        '<p class="text-xs text-slate-500 mt-1">id ' + escape(c.id) + ' · yt ' + escape(c.youtubeId) + '</p>' +
        '<div class="mt-4 h-2 rounded bg-slate-800 overflow-hidden">' +
          '<div class="h-full bg-emerald-500" style="width:' + pct + '%"></div>' +
        '</div>' +
        '<p class="text-xs text-slate-400 mt-2">' + fmtSecs(elapsed) + ' / ' + fmtSecs(total) +
          ' · ends in ' + fmtSecs(remaining) + '</p>' +
      '</div>' +
      '</div>';

    const up = (snapshot.upcoming || []).slice(0, 6);
    $("#upcoming").innerHTML = up.length === 0
      ? '<p class="text-slate-500 text-sm col-span-full">Queue exhausted — add programs below.</p>'
      : up.map((it, i) =>
        '<div class="rounded-lg border border-slate-800 bg-slate-900/40 p-3">' +
          '<p class="text-xs text-slate-500">#' + (i + 1) + (i === 0 ? ' · next' : '') + '</p>' +
          '<p class="text-sm font-medium mt-0.5 truncate" title="' + escapeAttr(it.title) + '">' + escape(it.title) + '</p>' +
          '<p class="text-xs text-slate-500 mt-1">' + fmtSecs(it.durationSecs) + ' · starts ' +
            new Date(it.startsAt).toLocaleTimeString() + '</p>' +
        '</div>'
      ).join("");

    const age = Math.round((Date.now() - new Date(snapshot.generatedAt).getTime()) / 1000);
    $("#snapshotAge").textContent = "snapshot " + age + "s old";
  }
  function escape(s) { return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
  function escapeAttr(s) { return escape(s).replace(/"/g, "&quot;"); }

  async function loadSnapshot() {
    try {
      snapshot = await api("/api/v1/broadcast/current");
      renderSnapshot();
    } catch (e) {
      console.error("snapshot:", e);
    }
  }
  async function loadViewers() {
    try {
      const r = await api("/api/v1/broadcast/viewers");
      $("#viewers").textContent = r.count;
    } catch {}
  }

  // ---------- queue ----------
  async function loadQueue() {
    const list = $("#queueList");
    if (!token) {
      list.innerHTML = '<p class="text-slate-500 text-sm py-4">Set a token above to manage the queue.</p>';
      return;
    }
    list.innerHTML = '<p class="text-slate-500 text-sm py-2">Loading…</p>';
    try {
      queue = await api("/api/v1/broadcast/queue");
      renderQueue();
    } catch (e) {
      list.innerHTML = '<p class="text-rose-400 text-sm py-2">Failed to load queue: ' + escape(e.message) + '</p>';
    }
  }
  function renderQueue() {
    const list = $("#queueList");
    if (queue.length === 0) {
      list.innerHTML = '<p class="text-slate-500 text-sm py-4">Queue is empty.</p>';
      return;
    }
    list.innerHTML = queue.map((it, i) =>
      '<div class="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2" data-id="' + escapeAttr(it.id) + '">' +
        '<div class="flex flex-col gap-0.5">' +
          '<button data-act="up"   ' + (i === 0 ? 'disabled' : '') + ' class="w-6 h-5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-xs">↑</button>' +
          '<button data-act="down" ' + (i === queue.length - 1 ? 'disabled' : '') + ' class="w-6 h-5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-xs">↓</button>' +
        '</div>' +
        '<div class="flex-1 min-w-0">' +
          '<p class="text-sm font-medium truncate" title="' + escapeAttr(it.title) + '">' + escape(it.title) + '</p>' +
          '<p class="text-xs text-slate-500 truncate">' + escape(it.videoSource) + ' · ' + fmtSecs(it.durationSecs) + ' · order ' + (it.sortOrder ?? "—") + ' · ' + escape(it.youtubeId || "") + '</p>' +
        '</div>' +
        '<label class="flex items-center gap-1 text-xs text-slate-400 cursor-pointer">' +
          '<input type="checkbox" data-act="toggle" ' + (it.isActive ? "checked" : "") + ' class="accent-emerald-500" />' +
          '<span>active</span>' +
        '</label>' +
        '<button data-act="del" class="text-xs text-rose-400 hover:text-rose-300 px-2 py-1">delete</button>' +
      '</div>'
    ).join("");

    list.querySelectorAll("[data-id]").forEach((row) => {
      const id = row.getAttribute("data-id");
      row.querySelector('[data-act="up"]')?.addEventListener("click", () => move(id, -1));
      row.querySelector('[data-act="down"]')?.addEventListener("click", () => move(id, +1));
      row.querySelector('[data-act="toggle"]')?.addEventListener("change", (e) => toggleActive(id, e.target.checked));
      row.querySelector('[data-act="del"]')?.addEventListener("click", () => removeItem(id));
    });
  }
  async function move(id, delta) {
    const idx = queue.findIndex((q) => q.id === id);
    const j = idx + delta;
    if (idx < 0 || j < 0 || j >= queue.length) return;
    const newOrder = queue.slice();
    [newOrder[idx], newOrder[j]] = [newOrder[j], newOrder[idx]];
    try {
      await api("/api/v1/broadcast/queue/reorder", {
        method: "POST",
        body: JSON.stringify({ itemIds: newOrder.map((x) => x.id) }),
      });
      await loadQueue();
      await loadSnapshot();
    } catch (e) { alert("Reorder failed: " + e.message); }
  }
  async function toggleActive(id, isActive) {
    try {
      await api("/api/v1/broadcast/queue/" + encodeURIComponent(id) + "/active", {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      });
      await loadQueue();
      await loadSnapshot();
    } catch (e) { alert("Toggle failed: " + e.message); await loadQueue(); }
  }
  async function removeItem(id) {
    if (!confirm("Remove this item from the queue?")) return;
    try {
      await api("/api/v1/broadcast/queue/" + encodeURIComponent(id), { method: "DELETE" });
      await loadQueue();
      await loadSnapshot();
    } catch (e) { alert("Delete failed: " + e.message); }
  }

  $("#reloadQueue").addEventListener("click", loadQueue);
  $("#addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      title: String(fd.get("title") || "").trim(),
      youtubeId: String(fd.get("youtubeId") || "").trim(),
      durationSecs: Number(fd.get("durationSecs") || 1800),
      thumbnailUrl: String(fd.get("thumbnailUrl") || ""),
      videoSource: String(fd.get("videoSource") || "youtube"),
    };
    const lv = String(fd.get("localVideoUrl") || "").trim();
    if (lv) body.localVideoUrl = lv;
    const btn = $("#addBtn"), msg = $("#addMsg");
    btn.disabled = true; msg.textContent = "Adding…"; msg.className = "text-xs text-slate-400";
    try {
      await api("/api/v1/broadcast/queue", { method: "POST", body: JSON.stringify(body) });
      msg.textContent = "Added"; msg.className = "text-xs text-emerald-400";
      e.target.reset();
      await loadQueue(); await loadSnapshot();
    } catch (err) {
      msg.textContent = err.message; msg.className = "text-xs text-rose-400";
    } finally {
      btn.disabled = false;
      setTimeout(() => { msg.textContent = ""; }, 4000);
    }
  });

  // ---------- live SSE ----------
  function connectSSE() {
    let es;
    try { es = new EventSource("/api/v1/realtime/sse"); }
    catch (e) { setBadge("sse unsupported", "bg-amber-900/50 text-amber-300"); return; }
    es.onopen   = () => setBadge("live", "bg-emerald-900/50 text-emerald-300");
    es.onerror  = () => setBadge("reconnecting…", "bg-amber-900/50 text-amber-300");
    es.onmessage = () => {};
    let queueRefreshTimer = null;
    const debouncedQueueReload = () => {
      if (!token) return;
      clearTimeout(queueRefreshTimer);
      queueRefreshTimer = setTimeout(loadQueue, 250);
    };
    ["snapshot","advance","preload","viewer-count"].forEach((name) => {
      es.addEventListener(name, (ev) => {
        try {
          const data = ev.data ? JSON.parse(ev.data) : null;
          if (name === "viewer-count" && data && typeof data.count === "number") {
            $("#viewers").textContent = data.count;
          } else if (name === "snapshot" && data) {
            snapshot = data;
            renderSnapshot();
            debouncedQueueReload();
          } else {
            loadSnapshot();
            debouncedQueueReload();
          }
        } catch {}
      });
    });
  }

  // ---------- boot ----------
  loadSnapshot();
  loadViewers();
  loadQueue();
  connectSSE();
  snapshotTimer = setInterval(() => { if (snapshot) renderSnapshot(); }, 1000);
  setInterval(loadViewers, 15_000);
  setInterval(loadSnapshot, 30_000);
})();
</script>
</body>
</html>`;

export async function adminUiRoutes(app: FastifyInstance) {
  app.get("/admin", { schema: { hide: true } }, async (_req, reply) => {
    reply.redirect("/admin/broadcast", 302);
  });

  app.get("/admin/broadcast", { schema: { hide: true } }, async (_req, reply) => {
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(HTML);
  });
}
