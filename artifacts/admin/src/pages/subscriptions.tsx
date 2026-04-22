import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Users, Layers, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

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

function formatCents(cents: number): string {
  if (cents === 0) return "Free";
  return `₦${(cents / 100).toLocaleString()}`;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "active") return "default";
  if (status === "canceled" || status === "expired") return "destructive";
  return "secondary";
}

export default function Subscriptions() {
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [userSubs, setUserSubs] = useState<UserSub[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewTier, setShowNewTier] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    name: "",
    slug: "",
    description: "",
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    features: "",
  });

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [tiersRes, subsRes] = await Promise.all([
        fetch("/api/admin/subscriptions/tiers"),
        fetch("/api/admin/subscriptions/users"),
      ]);
      if (tiersRes.ok) setTiers((await tiersRes.json()) as Tier[]);
      if (subsRes.ok) setUserSubs((await subsRes.json()) as UserSub[]);
    } catch (err) {
      toast.error("Failed to load subscriptions");
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const createTier = async () => {
    if (!form.name.trim() || !form.slug.trim()) {
      toast.error("Name and slug are required");
      return;
    }
    setSubmitting(true);
    try {
      const features = form.features
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch("/api/admin/subscriptions/tiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, features }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success("Tier created");
      setForm({
        name: "",
        slug: "",
        description: "",
        priceMonthlyCents: 0,
        priceYearlyCents: 0,
        features: "",
      });
      setShowNewTier(false);
      await fetchAll();
    } catch {
      toast.error("Failed to create tier");
    } finally {
      setSubmitting(false);
    }
  };

  const deleteTier = async (id: string) => {
    if (!confirm("Delete this tier? Subscribers on it will keep access until expiry.")) return;
    try {
      const res = await fetch(`/api/admin/subscriptions/tiers/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Tier deleted");
      fetchAll();
    } catch {
      toast.error("Failed to delete tier");
    }
  };

  const updateSubStatus = async (id: string, status: string) => {
    try {
      const res = await fetch(`/api/admin/subscriptions/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error();
      toast.success(`Status updated to ${status}`);
      fetchAll();
    } catch {
      toast.error("Failed to update status");
    }
  };

  const stats = [
    { label: "Total Tiers", value: tiers.length, icon: Layers },
    {
      label: "Active Subscribers",
      value: userSubs.filter((s) => s.status === "active").length,
      icon: CheckCircle2,
    },
    { label: "Total Members", value: userSubs.length, icon: Users },
  ];

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Subscriptions</h1>
          <p className="text-muted-foreground mt-1">
            Manage subscription tiers and member status across Temple TV.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardContent className="p-6 flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{s.label}</p>
                <p className="text-3xl font-bold mt-1">
                  {loading ? <Skeleton className="h-8 w-16" /> : s.value}
                </p>
              </div>
              <s.icon className="h-8 w-8 text-muted-foreground/40" />
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="tiers" className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <TabsList>
            <TabsTrigger value="tiers">Tiers</TabsTrigger>
            <TabsTrigger value="subscribers">Subscribers</TabsTrigger>
          </TabsList>
          <Button size="sm" onClick={() => setShowNewTier((v) => !v)}>
            <Plus className="h-4 w-4 mr-2" />
            {showNewTier ? "Cancel" : "New Tier"}
          </Button>
        </div>

        <TabsContent value="tiers" className="space-y-4">
          {showNewTier && (
            <Card>
              <CardHeader>
                <CardTitle>New Subscription Tier</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="tier-name">Name</Label>
                    <Input
                      id="tier-name"
                      placeholder="Premium"
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="tier-slug">Slug (unique)</Label>
                    <Input
                      id="tier-slug"
                      placeholder="premium"
                      value={form.slug}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          slug: e.target.value.toLowerCase().replace(/\s+/g, "-"),
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="tier-monthly">Monthly Price (₦)</Label>
                    <Input
                      id="tier-monthly"
                      type="number"
                      min="0"
                      value={form.priceMonthlyCents / 100}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          priceMonthlyCents: Math.round(Number(e.target.value) * 100),
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="tier-yearly">Yearly Price (₦)</Label>
                    <Input
                      id="tier-yearly"
                      type="number"
                      min="0"
                      value={form.priceYearlyCents / 100}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          priceYearlyCents: Math.round(Number(e.target.value) * 100),
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tier-desc">Description</Label>
                  <Input
                    id="tier-desc"
                    value={form.description}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, description: e.target.value }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tier-features">Features (one per line)</Label>
                  <Textarea
                    id="tier-features"
                    rows={4}
                    placeholder={"Ad-free streaming\nHD quality\nDownload sermons"}
                    value={form.features}
                    onChange={(e) => setForm((f) => ({ ...f, features: e.target.value }))}
                  />
                </div>
                <div className="flex gap-2">
                  <Button onClick={createTier} disabled={submitting}>
                    {submitting ? "Creating…" : "Create Tier"}
                  </Button>
                  <Button variant="outline" onClick={() => setShowNewTier(false)}>
                    Cancel
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {loading ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-32 rounded-lg" />
              ))}
            </div>
          ) : tiers.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center text-muted-foreground">
                <Layers className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p className="font-medium text-foreground">No subscription tiers yet</p>
                <p className="text-sm mt-1">Create your first tier to start accepting members.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {tiers.map((tier) => (
                <Card key={tier.id}>
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-lg font-bold">{tier.name}</h3>
                          <Badge variant="outline" className="font-mono text-xs">
                            {tier.slug}
                          </Badge>
                          <Badge variant={tier.isActive ? "default" : "secondary"}>
                            {tier.isActive ? "active" : "inactive"}
                          </Badge>
                        </div>
                        {tier.description && (
                          <p className="text-sm text-muted-foreground mt-1">
                            {tier.description}
                          </p>
                        )}
                        <div className="flex gap-4 mt-3 text-sm">
                          <span className="font-semibold text-primary">
                            {formatCents(tier.priceMonthlyCents)}/mo
                          </span>
                          {tier.priceYearlyCents > 0 && (
                            <span className="text-muted-foreground">
                              {formatCents(tier.priceYearlyCents)}/yr
                            </span>
                          )}
                        </div>
                        {tier.features.length > 0 && (
                          <ul className="mt-3 space-y-1">
                            {tier.features.map((f, i) => (
                              <li
                                key={i}
                                className="text-sm text-muted-foreground flex items-center gap-2"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                                {f}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteTier(tier.id)}
                        aria-label="Delete tier"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="subscribers">
          <Card>
            <CardContent className="p-0">
              {loading ? (
                <div className="p-6 space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-12" />
                  ))}
                </div>
              ) : userSubs.length === 0 ? (
                <div className="p-12 text-center text-muted-foreground">
                  <Users className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p className="font-medium text-foreground">No subscribers yet</p>
                  <p className="text-sm mt-1">Members will appear here once they sign up.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        {["User", "Tier", "Status", "Expires", "Actions"].map((h) => (
                          <th
                            key={h}
                            className="text-left px-4 py-3 text-muted-foreground font-medium text-xs uppercase tracking-wider"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {userSubs.map((sub) => (
                        <tr
                          key={sub.id}
                          className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                        >
                          <td className="px-4 py-3">
                            <div className="font-medium">{sub.userName ?? "—"}</div>
                            <div className="text-muted-foreground text-xs">
                              {sub.userEmail ?? sub.userId.slice(0, 8)}
                            </div>
                          </td>
                          <td className="px-4 py-3">{sub.tierName ?? "—"}</td>
                          <td className="px-4 py-3">
                            <Badge variant={statusVariant(sub.status)}>{sub.status}</Badge>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {sub.currentPeriodEnd
                              ? new Date(sub.currentPeriodEnd).toLocaleDateString()
                              : "—"}
                          </td>
                          <td className="px-4 py-3">
                            <Select
                              value={sub.status}
                              onValueChange={(v) => updateSubStatus(sub.id, v)}
                            >
                              <SelectTrigger className="h-8 w-32 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="active">Active</SelectItem>
                                <SelectItem value="canceled">Canceled</SelectItem>
                                <SelectItem value="expired">Expired</SelectItem>
                                <SelectItem value="past_due">Past Due</SelectItem>
                              </SelectContent>
                            </Select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
