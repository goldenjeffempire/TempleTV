import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Smartphone, Plus, Trash2, Edit2, Send, CheckCircle, AlertTriangle, RefreshCw, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { toast } from "sonner";
import { api } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AppVersion {
  id:                   string;
  platform:             "ios" | "android" | "all";
  versionString:        string;
  versionCode:          number;
  channel:              "production" | "staging" | "preview";
  isMandatory:          boolean;
  minRequiredVersion:   string | null;
  releaseNotes:         string | null;
  storeUrlAndroid:      string | null;
  storeUrlIos:          string | null;
  pushNotificationSent: boolean;
  isActive:             boolean;
  createdAt:            string;
  updatedAt:            string;
}

interface CreateVersionBody {
  platform:           "ios" | "android" | "all";
  versionString:      string;
  versionCode:        number;
  channel:            "production" | "staging" | "preview";
  isMandatory:        boolean;
  minRequiredVersion: string | null;
  releaseNotes:       string | null;
  storeUrlAndroid:    string | null;
  storeUrlIos:        string | null;
  isActive:           boolean;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

const fetchVersions = () =>
  api.get<{ items: AppVersion[]; total: number }>("/admin/app/versions?limit=100");

const createVersion = (body: CreateVersionBody) =>
  api.post<AppVersion>("/admin/app/versions", body);

const updateVersion = (id: string, body: Partial<CreateVersionBody>) =>
  api.patch<AppVersion>(`/admin/app/versions/${id}`, body);

const deleteVersion = (id: string) =>
  api.delete<void>(`/admin/app/versions/${id}`);

const sendNotification = (id: string, body: { title: string; message: string }) =>
  api.post<{ ok: boolean; delivered: number }>(`/admin/app/versions/${id}/send-notification`, body);

// ─── Empty form state ─────────────────────────────────────────────────────────

const emptyForm = (): CreateVersionBody => ({
  platform:           "all",
  versionString:      "",
  versionCode:        0,
  channel:            "production",
  isMandatory:        false,
  minRequiredVersion: null,
  releaseNotes:       null,
  storeUrlAndroid:    null,
  storeUrlIos:        null,
  isActive:           true,
});

// ─── Platform badge ───────────────────────────────────────────────────────────

function PlatformBadge({ platform }: { platform: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    ios:     { label: "iOS",     cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20" },
    android: { label: "Android", cls: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20" },
    all:     { label: "All",     cls: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20" },
  };
  const { label, cls } = map[platform] ?? { label: platform, cls: "" };
  return <Badge variant="outline" className={`text-xs font-semibold ${cls}`}>{label}</Badge>;
}

function ChannelBadge({ channel }: { channel: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    production: { label: "Production", cls: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20" },
    staging:    { label: "Staging",    cls: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20" },
    preview:    { label: "Preview",    cls: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20" },
  };
  const { label, cls } = map[channel] ?? { label: channel, cls: "" };
  return <Badge variant="outline" className={`text-xs ${cls}`}>{label}</Badge>;
}

// ─── Version form dialog ──────────────────────────────────────────────────────

interface VersionFormDialogProps {
  open:     boolean;
  onClose:  () => void;
  initial?: AppVersion | null;
  onSave:   (body: CreateVersionBody) => void;
  loading:  boolean;
}

function VersionFormDialog({ open, onClose, initial, onSave, loading }: VersionFormDialogProps) {
  const [form, setForm] = useState<CreateVersionBody>(
    initial
      ? {
          platform:           initial.platform,
          versionString:      initial.versionString,
          versionCode:        initial.versionCode,
          channel:            initial.channel,
          isMandatory:        initial.isMandatory,
          minRequiredVersion: initial.minRequiredVersion,
          releaseNotes:       initial.releaseNotes,
          storeUrlAndroid:    initial.storeUrlAndroid,
          storeUrlIos:        initial.storeUrlIos,
          isActive:           initial.isActive,
        }
      : emptyForm(),
  );

  const set = <K extends keyof CreateVersionBody>(k: K, v: CreateVersionBody[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const isEdit = !!initial;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Version" : "New Version Record"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Version String *</Label>
              <Input
                placeholder="e.g. 1.0.18"
                value={form.versionString}
                onChange={(e) => set("versionString", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Version Code</Label>
              <Input
                type="number"
                placeholder="e.g. 58"
                value={form.versionCode}
                onChange={(e) => set("versionCode", parseInt(e.target.value, 10) || 0)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Platform</Label>
              <Select
                value={form.platform}
                onValueChange={(v) => set("platform", v as "ios" | "android" | "all")}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All platforms</SelectItem>
                  <SelectItem value="android">Android</SelectItem>
                  <SelectItem value="ios">iOS</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Channel</Label>
              <Select
                value={form.channel}
                onValueChange={(v) => set("channel", v as "production" | "staging" | "preview")}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="production">Production</SelectItem>
                  <SelectItem value="staging">Staging</SelectItem>
                  <SelectItem value="preview">Preview</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Minimum Required Version</Label>
            <Input
              placeholder="e.g. 1.0.10 — users below this MUST update"
              value={form.minRequiredVersion ?? ""}
              onChange={(e) => set("minRequiredVersion", e.target.value || null)}
            />
            <p className="text-xs text-muted-foreground">
              Users running a version lower than this will be blocked until they update (mandatory gate).
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Release Notes</Label>
            <Textarea
              rows={4}
              placeholder="What's new in this release…"
              value={form.releaseNotes ?? ""}
              onChange={(e) => set("releaseNotes", e.target.value || null)}
            />
          </div>

          <div className="grid grid-cols-1 gap-3">
            <div className="space-y-1.5">
              <Label>Google Play Store URL</Label>
              <Input
                placeholder="https://play.google.com/store/apps/details?id=com.templetv.jctm"
                value={form.storeUrlAndroid ?? ""}
                onChange={(e) => set("storeUrlAndroid", e.target.value || null)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Apple App Store URL</Label>
              <Input
                placeholder="https://apps.apple.com/app/id…"
                value={form.storeUrlIos ?? ""}
                onChange={(e) => set("storeUrlIos", e.target.value || null)}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3 gap-3">
            <div>
              <p className="text-sm font-medium">Mandatory Update</p>
              <p className="text-xs text-muted-foreground">
                Block app access until the user updates. Use for critical security / breaking changes.
              </p>
            </div>
            <Switch
              checked={form.isMandatory}
              onCheckedChange={(v) => set("isMandatory", v)}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3 gap-3">
            <div>
              <p className="text-sm font-medium">Active</p>
              <p className="text-xs text-muted-foreground">
                Inactive records are ignored by the version-check endpoint.
              </p>
            </div>
            <Switch
              checked={form.isActive}
              onCheckedChange={(v) => set("isActive", v)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button
            onClick={() => onSave(form)}
            disabled={loading || !form.versionString.trim()}
          >
            {loading ? "Saving…" : isEdit ? "Save Changes" : "Create Version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Send notification dialog ─────────────────────────────────────────────────

interface SendNotifDialogProps {
  open:      boolean;
  onClose:   () => void;
  version:   AppVersion | null;
  onSend:    (title: string, message: string) => void;
  loading:   boolean;
}

function SendNotifDialog({ open, onClose, version, onSend, loading }: SendNotifDialogProps) {
  const [title,   setTitle]   = useState("Temple TV Update Available");
  const [message, setMessage] = useState(
    version
      ? `Version ${version.versionString} is now available. Update now for the latest improvements.`
      : "A new version of Temple TV is ready. Update now.",
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell size={18} /> Send Update Notification
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {version && (
            <div className="rounded-lg bg-muted/50 p-3 text-sm">
              Sending push to all registered devices for{" "}
              <strong>v{version.versionString}</strong> ({version.platform} / {version.channel}).
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Notification Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </div>
          <div className="space-y-1.5">
            <Label>Message</Label>
            <Textarea
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground text-right">{message.length}/500</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button
            onClick={() => onSend(title, message)}
            disabled={loading || !title.trim() || !message.trim()}
            className="gap-2"
          >
            <Send size={14} />
            {loading ? "Sending…" : "Send to All Devices"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AppVersionsPage() {
  const qc      = useQueryClient();

  const [formOpen,     setFormOpen]     = useState(false);
  const [editTarget,   setEditTarget]   = useState<AppVersion | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AppVersion | null>(null);
  const [notifTarget,  setNotifTarget]  = useState<AppVersion | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-app-versions"],
    queryFn:  fetchVersions,
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: createVersion,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-app-versions"] });
      setFormOpen(false);
      toast.success("Version created");
    },
    onError: (err: Error) => toast.error("Failed to create", { description: err.message }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CreateVersionBody> }) =>
      updateVersion(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-app-versions"] });
      setEditTarget(null);
      toast.success("Version updated");
    },
    onError: (err: Error) => toast.error("Failed to update", { description: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteVersion,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-app-versions"] });
      setDeleteTarget(null);
      toast.success("Version deleted");
    },
    onError: (err: Error) => toast.error("Failed to delete", { description: err.message }),
  });

  const notifMutation = useMutation({
    mutationFn: ({ id, title, message }: { id: string; title: string; message: string }) =>
      sendNotification(id, { title, message }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["admin-app-versions"] });
      setNotifTarget(null);
      toast.success("Notification sent", { description: `Delivered to ${result.delivered} device(s)` });
    },
    onError: (err: Error) => toast.error("Failed to send", { description: err.message }),
  });

  const versions = data?.items ?? [];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="App Versions"
        description="Manage app releases, mandatory updates, and push notification announcements."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void qc.invalidateQueries({ queryKey: ["admin-app-versions"] })}
              className="gap-1.5"
            >
              <RefreshCw size={14} /> Refresh
            </Button>
            <Button size="sm" onClick={() => setFormOpen(true)} className="gap-1.5">
              <Plus size={14} /> New Version
            </Button>
          </>
        }
      />

      {/* How it works */}
      <Card className="border-blue-500/20 bg-blue-500/5">
        <CardContent className="p-4 text-sm text-blue-700 dark:text-blue-300 space-y-1">
          <p className="font-semibold">How version checks work</p>
          <p>
            The mobile app calls <code className="bg-blue-500/10 px-1 rounded">GET /api/app/version-check</code> periodically.
            The latest <strong>active</strong> record for the matching platform + channel is compared against the device's installed version.
          </p>
          <ul className="list-disc list-inside space-y-0.5 mt-1">
            <li><strong>Optional update</strong>: latest version &gt; device version — shows a dismissable banner.</li>
            <li><strong>Mandatory update</strong>: toggle on, or set min required version below device version — shows a blocking gate.</li>
            <li><strong>OTA updates</strong>: delivered via Expo EAS (JS bundle only); no store submission needed for minor fixes.</li>
          </ul>
        </CardContent>
      </Card>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total Records",  value: versions.length },
          { label: "Active",         value: versions.filter((v) => v.isActive).length },
          { label: "Mandatory",      value: versions.filter((v) => v.isMandatory).length },
          { label: "Notified",       value: versions.filter((v) => v.pushNotificationSent).length },
        ].map(({ label, value }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <p className="text-2xl font-bold">{value}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Version table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Version Records</CardTitle>
          <CardDescription>Most recent first. The latest active record per platform+channel wins the version check.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-12 text-center text-muted-foreground text-sm">Loading…</div>
          ) : error ? (
            <div className="py-12 text-center text-destructive text-sm">Failed to load versions</div>
          ) : versions.length === 0 ? (
            <div className="py-12 text-center space-y-3">
              <Smartphone size={32} className="mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No version records yet. Create one to start tracking updates.</p>
              <Button size="sm" onClick={() => setFormOpen(true)} className="gap-1.5">
                <Plus size={14} /> Create First Version
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {versions.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/30 transition-colors"
                >
                  {/* Status indicator */}
                  <div className="flex-shrink-0">
                    {v.isActive ? (
                      <CheckCircle size={16} className="text-green-500" />
                    ) : (
                      <div className="w-4 h-4 rounded-full bg-muted-foreground/30" />
                    )}
                  </div>

                  {/* Version info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm">v{v.versionString}</span>
                      {v.versionCode > 0 && (
                        <span className="text-xs text-muted-foreground">({v.versionCode})</span>
                      )}
                      <PlatformBadge platform={v.platform} />
                      <ChannelBadge channel={v.channel} />
                      {v.isMandatory && (
                        <Badge variant="destructive" className="text-xs gap-1">
                          <AlertTriangle size={10} /> Mandatory
                        </Badge>
                      )}
                      {v.pushNotificationSent && (
                        <Badge variant="outline" className="text-xs gap-1 text-green-600 border-green-500/30 bg-green-500/5">
                          <Bell size={10} /> Notified
                        </Badge>
                      )}
                      {!v.isActive && (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          Inactive
                        </Badge>
                      )}
                    </div>
                    {v.minRequiredVersion && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                        Min required: v{v.minRequiredVersion}
                      </p>
                    )}
                    {v.releaseNotes && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-sm">
                        {v.releaseNotes}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(v.createdAt).toLocaleDateString(undefined, {
                        year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                      })}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Send update notification"
                      onClick={() => setNotifTarget(v)}
                    >
                      <Send size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Edit"
                      onClick={() => setEditTarget(v)}
                    >
                      <Edit2 size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      title="Delete"
                      onClick={() => setDeleteTarget(v)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <VersionFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSave={(body) => createMutation.mutate(body)}
        loading={createMutation.isPending}
      />

      {/* Edit dialog */}
      <VersionFormDialog
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        initial={editTarget}
        onSave={(body) => {
          if (editTarget) updateMutation.mutate({ id: editTarget.id, body });
        }}
        loading={updateMutation.isPending}
      />

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete version record?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove{" "}
              <strong>v{deleteTarget?.versionString}</strong> ({deleteTarget?.platform} / {deleteTarget?.channel}).
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget.id); }}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Send notification dialog */}
      <SendNotifDialog
        open={!!notifTarget}
        onClose={() => setNotifTarget(null)}
        version={notifTarget}
        onSend={(title, message) => {
          if (notifTarget) notifMutation.mutate({ id: notifTarget.id, title, message });
        }}
        loading={notifMutation.isPending}
      />
    </div>
  );
}
