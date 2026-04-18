import { useEffect, useState } from "react";

const API = import.meta.env.VITE_API_URL ?? "";

interface Tier {
  id: string;
  name: string;
  slug: string;
  description: string;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  features: string[];
  isActive: boolean;
  sortOrder: number;
}

interface UserSub {
  id: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  tierId: string;
  tierName: string | null;
  status: string;
  currentPeriodEnd: string | null;
  createdAt: string;
}

const authHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${localStorage.getItem("admin_token")}`,
});

function formatCents(cents: number): string {
  if (cents === 0) return "Free";
  return `₦${(cents / 100).toLocaleString()}`;
}

export default function Subscriptions() {
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [userSubs, setUserSubs] = useState<UserSub[]>([]);
  const [tab, setTab] = useState<"tiers" | "subscribers">("tiers");
  const [loading, setLoading] = useState(true);
  const [showNewTier, setShowNewTier] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", description: "", priceMonthlyCents: 0, priceYearlyCents: 0, features: "" });

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [tiersRes, subsRes] = await Promise.all([
        fetch(`${API}/api/admin/subscriptions/tiers`, { headers: authHeaders() }),
        fetch(`${API}/api/admin/subscriptions/users`, { headers: authHeaders() }),
      ]);
      if (tiersRes.ok) setTiers(await tiersRes.json() as Tier[]);
      if (subsRes.ok) setUserSubs(await subsRes.json() as UserSub[]);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  const createTier = async () => {
    const features = form.features.split("\n").map((s) => s.trim()).filter(Boolean);
    await fetch(`${API}/api/admin/subscriptions/tiers`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ ...form, features }),
    });
    setForm({ name: "", slug: "", description: "", priceMonthlyCents: 0, priceYearlyCents: 0, features: "" });
    setShowNewTier(false);
    fetchAll();
  };

  const deleteTier = async (id: string) => {
    if (!confirm("Delete this tier?")) return;
    await fetch(`${API}/api/admin/subscriptions/tiers/${id}`, { method: "DELETE", headers: authHeaders() });
    fetchAll();
  };

  const updateSubStatus = async (id: string, status: string) => {
    await fetch(`${API}/api/admin/subscriptions/${id}/status`, {
      method: "PATCH", headers: authHeaders(), body: JSON.stringify({ status }),
    });
    fetchAll();
  };

  if (loading) return <div className="p-8 text-center text-slate-400">Loading subscriptions…</div>;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Subscriptions</h1>
          <p className="text-slate-400 text-sm mt-1">Manage subscription tiers and user memberships</p>
        </div>
        {tab === "tiers" && (
          <button onClick={() => setShowNewTier(true)} className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg font-semibold text-sm">
            + New Tier
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total Tiers", value: tiers.length },
          { label: "Active Subscribers", value: userSubs.filter(s => s.status === "active").length },
          { label: "Total Members", value: userSubs.length },
        ].map((s) => (
          <div key={s.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-center">
            <div className="text-3xl font-bold text-white">{s.value}</div>
            <div className="text-sm text-slate-400 mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-800">
        {(["tiers", "subscribers"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${tab === t ? "border-purple-500 text-purple-400" : "border-transparent text-slate-400 hover:text-white"}`}>
            {t}
          </button>
        ))}
      </div>

      {/* New Tier Form */}
      {showNewTier && tab === "tiers" && (
        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 space-y-4">
          <h3 className="font-semibold text-white">New Subscription Tier</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-slate-400 mb-1 block">Name</label>
              <input type="text" placeholder="e.g. Premium" value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
            </div>
            <div>
              <label className="text-sm text-slate-400 mb-1 block">Slug (unique)</label>
              <input type="text" placeholder="e.g. premium" value={form.slug} onChange={(e) => setForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") }))} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
            </div>
            <div>
              <label className="text-sm text-slate-400 mb-1 block">Monthly Price (₦)</label>
              <input type="number" min="0" value={form.priceMonthlyCents / 100} onChange={(e) => setForm(f => ({ ...f, priceMonthlyCents: Math.round(Number(e.target.value) * 100) }))} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
            </div>
            <div>
              <label className="text-sm text-slate-400 mb-1 block">Yearly Price (₦)</label>
              <input type="number" min="0" value={form.priceYearlyCents / 100} onChange={(e) => setForm(f => ({ ...f, priceYearlyCents: Math.round(Number(e.target.value) * 100) }))} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
            </div>
          </div>
          <div>
            <label className="text-sm text-slate-400 mb-1 block">Description</label>
            <input type="text" value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
          </div>
          <div>
            <label className="text-sm text-slate-400 mb-1 block">Features (one per line)</label>
            <textarea rows={4} placeholder="Ad-free streaming&#10;HD quality&#10;Download sermons" value={form.features} onChange={(e) => setForm(f => ({ ...f, features: e.target.value }))} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500 resize-none" />
          </div>
          <div className="flex gap-3">
            <button onClick={createTier} className="px-6 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-semibold">Create Tier</button>
            <button onClick={() => setShowNewTier(false)} className="px-6 py-2 bg-slate-800 text-slate-400 hover:text-white rounded-lg text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* Tiers List */}
      {tab === "tiers" && (
        <div className="grid gap-4">
          {tiers.length === 0 && (
            <div className="text-center py-12 text-slate-500">No subscription tiers yet. Create your first one.</div>
          )}
          {tiers.map((tier) => (
            <div key={tier.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold text-white">{tier.name}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">{tier.slug}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${tier.isActive ? "bg-green-900/40 text-green-400" : "bg-slate-800 text-slate-500"}`}>{tier.isActive ? "active" : "inactive"}</span>
                  </div>
                  {tier.description && <p className="text-sm text-slate-400 mt-1">{tier.description}</p>}
                  <div className="flex gap-4 mt-2">
                    <span className="text-sm text-purple-400 font-semibold">{formatCents(tier.priceMonthlyCents)}/mo</span>
                    {tier.priceYearlyCents > 0 && <span className="text-sm text-blue-400">{formatCents(tier.priceYearlyCents)}/yr</span>}
                  </div>
                  {tier.features.length > 0 && (
                    <ul className="mt-3 space-y-1">
                      {tier.features.map((f, i) => (
                        <li key={i} className="text-xs text-slate-400 flex items-center gap-2">
                          <span className="text-green-400">✓</span> {f}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <button onClick={() => deleteTier(tier.id)} className="text-slate-500 hover:text-red-400 transition-colors text-sm">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Subscribers List */}
      {tab === "subscribers" && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
          {userSubs.length === 0 ? (
            <div className="text-center py-12 text-slate-500">No subscribers yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  {["User", "Tier", "Status", "Expires", "Actions"].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-slate-400 font-medium text-xs uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {userSubs.map((sub) => (
                  <tr key={sub.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-4 py-3">
                      <div className="font-medium text-white">{sub.userName ?? "—"}</div>
                      <div className="text-slate-500 text-xs">{sub.userEmail ?? sub.userId.slice(0, 8)}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{sub.tierName ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${sub.status === "active" ? "bg-green-900/40 text-green-400" : sub.status === "canceled" ? "bg-orange-900/40 text-orange-400" : "bg-slate-800 text-slate-400"}`}>
                        {sub.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={sub.status}
                        onChange={(e) => updateSubStatus(sub.id, e.target.value)}
                        className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none"
                      >
                        <option value="active">Active</option>
                        <option value="canceled">Canceled</option>
                        <option value="expired">Expired</option>
                        <option value="past_due">Past Due</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
