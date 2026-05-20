import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Settings2, Plus, Trash2, Save, RefreshCw, Info, Search,
} from "lucide-react";

interface ConfigEntry {
  key: string;
  value: string;
  updatedAt: string;
}

const SUGGESTED_KEYS = [
  { key: "broadcast.title", description: "Name shown on the live hero / player", example: "Temple TV Live" },
  { key: "broadcast.channel_id", description: "YouTube channel ID for live detection", example: "UCxxxxxxxxxx" },
  { key: "broadcast.youtube_api_key", description: "YouTube Data API v3 key for live detection", example: "AIza..." },
  { key: "site.name", description: "Platform display name", example: "Temple TV" },
  { key: "site.tagline", description: "Short tagline shown on screens", example: "JCTM Broadcasting Network" },
  { key: "notifications.push_enabled", description: "Enable web push notifications", example: "true" },
  { key: "notifications.expo_enabled", description: "Enable Expo push notifications", example: "true" },
  { key: "chat.max_message_length", description: "Max chars per chat message", example: "500" },
  { key: "chat.rate_limit_per_min", description: "Max messages per user per minute", example: "10" },
  { key: "upload.max_file_size_mb", description: "Max upload file size in MB", example: "500" },
  { key: "upload.chunk_size_mb", description: "Upload chunk size in MB (1–64)", example: "8" },
  { key: "feature.tv_app_enabled", description: "Enable Smart TV app", example: "true" },
  { key: "feature.mobile_app_enabled", description: "Enable mobile app", example: "true" },
  { key: "analytics.retention_days", description: "Days to retain analytics data", example: "90" },
];

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function SettingsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editMap, setEditMap] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin-system-settings"],
    queryFn: () => api.get<{ settings: ConfigEntry[] }>("/admin/system-settings"),
    staleTime: 30_000,
  });

  const upsertMutation = useMutation({
    mutationFn: (entry: { key: string; value: string }) =>
      api.put<ConfigEntry>("/admin/system-settings", entry),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["admin-system-settings"] });
      setEditMap((m) => { const n = { ...m }; delete n[saved.key]; return n; });
      toast({ title: "Setting saved", description: saved.key });
    },
    onError: (e) => toast({ title: "Save failed", description: String(e), variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) =>
      api.delete(`/admin/system-settings/${encodeURIComponent(key)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-system-settings"] });
      toast({ title: "Setting deleted" });
    },
    onError: (e) => toast({ title: "Delete failed", description: String(e), variant: "destructive" }),
  });

  const handleAdd = () => {
    if (!newKey.trim() || !newValue.trim()) {
      toast({ title: "Key and value are required", variant: "destructive" });
      return;
    }
    upsertMutation.mutate({ key: newKey.trim(), value: newValue.trim() });
    setNewKey("");
    setNewValue("");
  };

  const handleSaveEdit = (key: string) => {
    const value = editMap[key];
    if (value === undefined) return;
    upsertMutation.mutate({ key, value });
  };

  const handleSuggest = (key: string, example: string) => {
    setNewKey(key);
    setNewValue(example);
  };

  const settings = (data?.settings ?? []).filter((s) => {
    if (!search) return true;
    return s.key.toLowerCase().includes(search.toLowerCase()) || s.value.toLowerCase().includes(search.toLowerCase());
  });

  const existingKeys = new Set((data?.settings ?? []).map((s) => s.key));

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">System Settings</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Runtime configuration stored in the database. Changes take effect immediately.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2 flex-shrink-0">
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

      {/* Add new setting */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Plus size={16} className="text-primary" />
            Add / Update Setting
          </CardTitle>
          <CardDescription>
            Keys must be lowercase with dots, dashes, underscores, or slashes (e.g. <code className="text-xs bg-muted px-1 rounded">broadcast.title</code>).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-3 flex-col sm:flex-row">
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs">Key</Label>
              <Input
                placeholder="e.g. broadcast.title"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                className="h-9 font-mono text-sm"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs">Value</Label>
              <Input
                placeholder="Setting value"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                className="h-9"
                onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              />
            </div>
            <div className="flex items-end">
              <Button
                onClick={handleAdd}
                disabled={!newKey.trim() || !newValue.trim() || upsertMutation.isPending}
                className="gap-2 h-9"
              >
                <Save size={14} />
                Save
              </Button>
            </div>
          </div>

          {/* Suggested keys */}
          <div className="pt-1">
            <p className="text-xs text-muted-foreground mb-2">Suggested keys:</p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTED_KEYS.filter((s) => !existingKeys.has(s.key)).slice(0, 8).map((s) => (
                <button
                  key={s.key}
                  onClick={() => handleSuggest(s.key, s.example)}
                  title={s.description}
                  className="text-[11px] px-2 py-0.5 rounded-full bg-muted hover:bg-muted/80 text-muted-foreground font-mono transition-colors"
                >
                  {s.key}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Existing settings */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Current Settings</CardTitle>
              <CardDescription>{data?.settings.length ?? 0} entries in app_config</CardDescription>
            </div>
            {(data?.settings.length ?? 0) > 5 && (
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-7 h-8 w-44 text-xs"
                />
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="flex gap-3 items-center">
                  <Skeleton className="h-8 flex-1" />
                  <Skeleton className="h-8 flex-1" />
                  <Skeleton className="h-8 w-16" />
                </div>
              ))}
            </div>
          ) : settings.length === 0 ? (
            <div className="flex flex-col items-center py-16 gap-3">
              <Settings2 size={32} className="text-muted-foreground/30" />
              <p className="text-muted-foreground font-medium">
                {search ? "No matching settings" : "No settings configured yet"}
              </p>
              <p className="text-sm text-muted-foreground/60">
                {search ? "Clear the filter or add a new setting" : "Add a setting above to get started"}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {settings.map((entry) => {
                const isEditing = entry.key in editMap;
                const displayValue = isEditing ? editMap[entry.key]! : entry.value;
                const hint = SUGGESTED_KEYS.find((s) => s.key === entry.key);

                return (
                  <div key={entry.key} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors group">
                    {/* Key */}
                    <div className="w-64 flex-shrink-0">
                      <code className="text-xs font-mono text-foreground/90">{entry.key}</code>
                      {hint && (
                        <p className="text-[10px] text-muted-foreground/60 mt-0.5 flex items-center gap-1">
                          <Info size={9} />
                          {hint.description}
                        </p>
                      )}
                    </div>

                    {/* Value */}
                    <div className="flex-1 min-w-0">
                      <Input
                        value={displayValue}
                        onChange={(e) =>
                          setEditMap((m) => ({ ...m, [entry.key]: e.target.value }))
                        }
                        className="h-8 text-sm font-mono"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSaveEdit(entry.key);
                          if (e.key === "Escape") setEditMap((m) => { const n = { ...m }; delete n[entry.key]; return n; });
                        }}
                      />
                    </div>

                    {/* Updated at */}
                    <div className="w-20 text-right flex-shrink-0 hidden sm:block">
                      <p className="text-[10px] text-muted-foreground/50">{timeAgo(entry.updatedAt)}</p>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {isEditing && (
                        <Button
                          size="sm"
                          className="h-7 px-2 gap-1 text-xs"
                          onClick={() => handleSaveEdit(entry.key)}
                          disabled={upsertMutation.isPending}
                        >
                          <Save size={11} />
                          Save
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive/60 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => deleteMutation.mutate(entry.key)}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Reference section */}
      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
            <Info size={14} />
            Available Setting Keys
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {SUGGESTED_KEYS.map((s) => (
              <div
                key={s.key}
                className="flex flex-col gap-0.5 p-2 rounded-md border border-border/40 bg-muted/20 cursor-pointer hover:bg-muted/40 transition-colors"
                onClick={() => handleSuggest(s.key, s.example)}
              >
                <code className="text-[11px] font-mono text-foreground/80">{s.key}</code>
                <p className="text-[10px] text-muted-foreground">{s.description}</p>
                <p className="text-[10px] text-muted-foreground/50">e.g. {s.example}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
