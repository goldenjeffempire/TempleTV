import { useEffect, useRef, useState } from "react";

const API = import.meta.env.VITE_API_URL ?? "";

interface LiveOverride {
  id: string;
  title: string;
  isActive: boolean;
  hlsStreamUrl: string | null;
  rtmpIngestKey: string | null;
  streamNotes: string | null;
  startedAt: string;
  endsAt: string | null;
}

function elapsed(startedAt: string): string {
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (h > 0) return `${h}h ${m}m on air`;
  if (m > 0) return `${m}m ${s}s on air`;
  return `${s}s on air`;
}

export default function LiveControl() {
  const [activeOverride, setActiveOverride] = useState<LiveOverride | null>(null);
  const [allOverrides, setAllOverrides] = useState<LiveOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [connectedClients, setConnectedClients] = useState<number | null>(null);
  const [elapsedStr, setElapsedStr] = useState("");

  const [form, setForm] = useState({
    title: "",
    hlsStreamUrl: "",
    rtmpIngestKey: "",
    streamNotes: "",
    durationMins: "",
  });

  const esRef = useRef<EventSource | null>(null);

  const fetchOverrides = async () => {
    try {
      const res = await fetch(`${API}/api/admin/live-overrides`, { headers: { Authorization: `Bearer ${localStorage.getItem("admin_token")}` } });
      if (res.ok) {
        const data = await res.json() as LiveOverride[];
        setAllOverrides(data);
        const active = data.find((o) => o.isActive) ?? null;
        setActiveOverride(active);
      }
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchOverrides(); }, []);

  useEffect(() => {
    if (!activeOverride) { setElapsedStr(""); return; }
    const tick = () => setElapsedStr(elapsed(activeOverride.startedAt));
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, [activeOverride]);

  useEffect(() => {
    const es = new EventSource(`${API}/api/broadcast/events`);
    esRef.current = es;
    es.addEventListener("broadcast-current-updated", () => fetchOverrides());
    return () => es.close();
  }, []);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`${API}/api/health`);
        if (res.ok) {
          const data = await res.json() as { sseClients?: number };
          if (typeof data.sseClients === "number") setConnectedClients(data.sseClients);
        }
      } catch {}
    };
    poll();
    const i = setInterval(poll, 10_000);
    return () => clearInterval(i);
  }, []);

  const goLive = async () => {
    if (!form.title.trim()) return;
    setStarting(true);
    try {
      const endsAt = form.durationMins
        ? new Date(Date.now() + Number(form.durationMins) * 60 * 1000).toISOString()
        : null;
      const res = await fetch(`${API}/api/admin/live-overrides`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("admin_token")}` },
        body: JSON.stringify({ title: form.title, hlsStreamUrl: form.hlsStreamUrl || null, rtmpIngestKey: form.rtmpIngestKey || null, streamNotes: form.streamNotes || null, endsAt }),
      });
      if (res.ok) {
        setForm({ title: "", hlsStreamUrl: "", rtmpIngestKey: "", streamNotes: "", durationMins: "" });
        await fetchOverrides();
      }
    } finally { setStarting(false); }
  };

  const endBroadcast = async (id: string) => {
    await fetch(`${API}/api/admin/live-overrides/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("admin_token")}` },
      body: JSON.stringify({ isActive: false }),
    });
    await fetchOverrides();
  };

  if (loading) return <div className="p-8 text-center text-slate-400">Loading live controls…</div>;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Live Status Banner */}
      <div className={`rounded-2xl p-6 border ${activeOverride ? "bg-red-950/40 border-red-800/50" : "bg-slate-900 border-slate-800"}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {activeOverride && (
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
              </span>
            )}
            <div>
              <h2 className="text-xl font-bold text-white">
                {activeOverride ? "🔴 LIVE ON AIR" : "⚫ Off Air"}
              </h2>
              {activeOverride && (
                <p className="text-sm text-red-300 mt-0.5">{activeOverride.title} · {elapsedStr}</p>
              )}
            </div>
          </div>
          {connectedClients !== null && (
            <div className="text-right">
              <div className="text-2xl font-bold text-white">{connectedClients}</div>
              <div className="text-xs text-slate-400">Connected viewers</div>
            </div>
          )}
        </div>

        {activeOverride && (
          <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-3">
            {activeOverride.hlsStreamUrl && (
              <div className="bg-black/30 rounded-lg p-3">
                <div className="text-xs text-slate-400 mb-1">HLS Stream URL</div>
                <div className="text-xs text-green-400 font-mono truncate">{activeOverride.hlsStreamUrl}</div>
              </div>
            )}
            {activeOverride.rtmpIngestKey && (
              <div className="bg-black/30 rounded-lg p-3">
                <div className="text-xs text-slate-400 mb-1">RTMP Key</div>
                <div className="text-xs text-yellow-400 font-mono">••••••••{activeOverride.rtmpIngestKey.slice(-4)}</div>
              </div>
            )}
            {activeOverride.endsAt && (
              <div className="bg-black/30 rounded-lg p-3">
                <div className="text-xs text-slate-400 mb-1">Scheduled End</div>
                <div className="text-xs text-orange-400">{new Date(activeOverride.endsAt).toLocaleTimeString()}</div>
              </div>
            )}
          </div>
        )}

        {activeOverride && (
          <button
            onClick={() => endBroadcast(activeOverride.id)}
            className="mt-4 px-6 py-2 bg-red-700 hover:bg-red-600 text-white rounded-lg font-semibold text-sm transition-colors"
          >
            End Broadcast
          </button>
        )}
      </div>

      {/* Start Broadcast Form */}
      {!activeOverride && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Start a Live Broadcast</h3>
          <p className="text-sm text-slate-400 mb-4">
            Going live instantly overrides the scheduled queue on all platforms — mobile, web, Smart TV, and radio mode.
          </p>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Broadcast Title *</label>
              <input
                type="text"
                placeholder="e.g. Sunday Service — Live"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">HLS Stream URL</label>
                <input
                  type="url"
                  placeholder="https://… .m3u8  (or leave empty for YouTube live)"
                  value={form.hlsStreamUrl}
                  onChange={(e) => setForm((f) => ({ ...f, hlsStreamUrl: e.target.value }))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 font-mono text-sm"
                />
                <p className="text-xs text-slate-500 mt-1">Mux, Cloudflare Stream, Wowza, or any HLS source</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">RTMP Ingest Key</label>
                <input
                  type="text"
                  placeholder="Stream key from your RTMP provider"
                  value={form.rtmpIngestKey}
                  onChange={(e) => setForm((f) => ({ ...f, rtmpIngestKey: e.target.value }))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 font-mono text-sm"
                />
                <p className="text-xs text-slate-500 mt-1">Stored for reference; ingestion uses your encoder</p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Auto-end after (minutes)</label>
                <input
                  type="number"
                  min="1"
                  placeholder="e.g. 120  (optional)"
                  value={form.durationMins}
                  onChange={(e) => setForm((f) => ({ ...f, durationMins: e.target.value }))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Internal Notes</label>
                <input
                  type="text"
                  placeholder="e.g. Pastor John preaching — Youth Sunday"
                  value={form.streamNotes}
                  onChange={(e) => setForm((f) => ({ ...f, streamNotes: e.target.value }))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>
            <div className="bg-blue-950/40 border border-blue-800/40 rounded-lg p-4">
              <h4 className="text-sm font-semibold text-blue-300 mb-2">📡 How Sync Works</h4>
              <ul className="text-xs text-blue-200/70 space-y-1">
                <li>• Clicking "Go Live" instantly pushes the broadcast state to all connected clients via Server-Sent Events</li>
                <li>• Mobile apps, Smart TV, web, and radio mode all switch to this stream within seconds</li>
                <li>• If an HLS URL is provided, all platforms play it directly — zero re-encoding delay</li>
                <li>• If no HLS URL, platforms fall back to YouTube Live detection (via the YouTube Data API)</li>
              </ul>
            </div>
            <button
              onClick={goLive}
              disabled={starting || !form.title.trim()}
              className="px-8 py-3 bg-red-600 hover:bg-red-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl font-bold text-sm transition-colors flex items-center gap-2"
            >
              {starting ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" className="opacity-75"/></svg>
                  Starting…
                </>
              ) : "🔴 Go Live — Push to All Platforms"}
            </button>
          </div>
        </div>
      )}

      {/* Stream Architecture Info */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <h3 className="text-lg font-semibold text-white mb-4">📐 Broadcast Architecture</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { icon: "📱", label: "Mobile", desc: "iOS & Android via HLS player" },
            { icon: "🌐", label: "Web", desc: "Browser HLS or YouTube embed" },
            { icon: "📺", label: "Smart TV", desc: "TV web app via YouTube iframe" },
            { icon: "🎙️", label: "Radio Mode", desc: "Audio-only from same stream" },
          ].map((p) => (
            <div key={p.label} className="bg-slate-800/60 rounded-xl p-4 text-center">
              <div className="text-2xl mb-2">{p.icon}</div>
              <div className="text-sm font-semibold text-white">{p.label}</div>
              <div className="text-xs text-slate-400 mt-1">{p.desc}</div>
              {activeOverride ? (
                <div className="mt-2 text-xs text-green-400 font-medium">● In Sync</div>
              ) : (
                <div className="mt-2 text-xs text-slate-500">○ Standby</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* History */}
      {allOverrides.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Broadcast History</h3>
          <div className="space-y-2">
            {allOverrides.slice(0, 10).map((o) => (
              <div key={o.id} className="flex items-center justify-between py-2 border-b border-slate-800 last:border-0">
                <div>
                  <span className={`text-xs px-2 py-0.5 rounded-full mr-2 font-medium ${o.isActive ? "bg-red-900/60 text-red-300" : "bg-slate-800 text-slate-400"}`}>
                    {o.isActive ? "LIVE" : "ended"}
                  </span>
                  <span className="text-sm text-white">{o.title}</span>
                </div>
                <div className="text-xs text-slate-500">{new Date(o.startedAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
