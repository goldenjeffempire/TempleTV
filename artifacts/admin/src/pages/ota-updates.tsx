import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Rocket, RefreshCw, CheckCircle2, XCircle, Clock, AlertTriangle,
  ExternalLink, Loader2, Radio, Smartphone, Tv2, Zap, ChevronDown,
  ChevronUp, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/shared/page-header";
import { toast } from "sonner";
import { api } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

interface EasUpdateEntry {
  id:             string;
  group:          string;
  message:        string | null;
  createdAt:      string;
  runtimeVersion: string;
  platform:       string;
  actor:          string | null;
}

interface EasBranch {
  id:      string;
  name:    string;
  updates: EasUpdateEntry[];
}

interface WorkflowRun {
  id:         number;
  name:       string;
  status:     string;
  conclusion: string | null;
  html_url:   string;
  created_at: string;
  updated_at: string;
  message:    string | null;
}

interface OtaStatus {
  configured: {
    expoToken:  boolean;
    github:     boolean;
    githubRepo: string | null;
  };
  branches:     EasBranch[];
  workflowRuns: WorkflowRun[];
  error:        string | null;
}

interface PublishResult {
  ok:     boolean;
  queued: boolean;
  note:   string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

type Channel = "production" | "staging" | "preview" | "firetv" | "androidtv" | "appletv";

const CHANNELS: { value: Channel; label: string; icon: React.ReactNode; description: string }[] = [
  { value: "production", label: "Production",  icon: <Rocket  size={14} />, description: "Live App Store / Play Store users" },
  { value: "staging",    label: "Staging",     icon: <Zap     size={14} />, description: "Internal staging builds" },
  { value: "preview",    label: "Preview",     icon: <Radio   size={14} />, description: "Internal preview / QA builds" },
  { value: "firetv",     label: "Fire TV",     icon: <Tv2     size={14} />, description: "Amazon Fire TV APK" },
  { value: "androidtv",  label: "Android TV",  icon: <Tv2     size={14} />, description: "Android TV bundle" },
  { value: "appletv",    label: "Apple TV",    icon: <Smartphone size={14} />, description: "tvOS build" },
];

// ─── API helpers ──────────────────────────────────────────────────────────────

const fetchStatus = () => api.get<OtaStatus>("/admin/ota/status");

const triggerPublish = (body: { channel: Channel; message: string }) =>
  api.post<PublishResult>("/admin/ota/publish", body);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function RunStatusBadge({ status, conclusion }: { status: string; conclusion: string | null }) {
  if (status === "completed") {
    if (conclusion === "success")
      return <Badge className="gap-1 bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20"><CheckCircle2 size={11} /> Success</Badge>;
    if (conclusion === "failure")
      return <Badge className="gap-1 bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20"><XCircle size={11} /> Failed</Badge>;
    if (conclusion === "cancelled")
      return <Badge className="gap-1 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/20"><XCircle size={11} /> Cancelled</Badge>;
  }
  if (status === "in_progress")
    return <Badge className="gap-1 bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20"><Loader2 size={11} className="animate-spin" /> Running</Badge>;
  if (status === "queued" || status === "waiting")
    return <Badge className="gap-1 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20"><Clock size={11} /> Queued</Badge>;
  return <Badge variant="outline" className="capitalize">{conclusion ?? status}</Badge>;
}

// ─── Branch update history panel ──────────────────────────────────────────────

function BranchPanel({ branch }: { branch: EasBranch }) {
  const [expanded, setExpanded] = useState(false);
  const ch = CHANNELS.find((c) => c.value === branch.name);

  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{ch?.icon ?? <Rocket size={14} />}</span>
          <span className="font-medium capitalize">{branch.name}</span>
          <Badge variant="outline" className="text-xs">{branch.updates.length} update{branch.updates.length !== 1 ? "s" : ""}</Badge>
        </div>
        {expanded ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="border-t">
          {branch.updates.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No updates published yet.</p>
          ) : (
            <div className="divide-y">
              {branch.updates.map((u) => (
                <div key={u.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {u.message ?? <span className="italic text-muted-foreground">No message</span>}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{relativeTime(u.createdAt)}</span>
                        <span>·</span>
                        <span className="capitalize">{u.platform}</span>
                        <span>·</span>
                        <span>Runtime {u.runtimeVersion}</span>
                        {u.actor && (
                          <>
                            <span>·</span>
                            <span>by {u.actor}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                      {u.id.slice(0, 8)}
                    </code>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OtaUpdatesPage() {
  const qc = useQueryClient();

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey:    ["ota-status"],
    queryFn:     fetchStatus,
    refetchInterval: 30_000,
    staleTime:   15_000,
  });

  const [channel, setChannel] = useState<Channel>("production");
  const [message, setMessage] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { mutate: publish, isPending } = useMutation({
    mutationFn: triggerPublish,
    onSuccess: (result) => {
      toast.success("OTA update queued", {
        description: result.note,
        duration:    8000,
      });
      setMessage("");
      setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["ota-status"] });
      }, 3000);
    },
    onError: (err: unknown) => {
      const msg = (err as { message?: string })?.message ?? "Unknown error";
      toast.error("Failed to trigger OTA update", { description: msg });
    },
  });

  const canTrigger  = data?.configured.github ?? false;
  const channelInfo = CHANNELS.find((c) => c.value === channel)!;

  return (
    <div className="space-y-6">
      <PageHeader
        title="OTA Updates"
        description="Push JS-only updates to deployed devices without a store release"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching
              ? <Loader2 size={14} className="animate-spin mr-1" />
              : <RefreshCw size={14} className="mr-1" />}
            Refresh
          </Button>
        }
      />

      {/* ── Configuration status ───────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card className={data?.configured.expoToken ? "border-green-500/30" : "border-amber-500/30"}>
          <CardContent className="flex items-center gap-3 p-4">
            {data?.configured.expoToken
              ? <CheckCircle2 size={18} className="shrink-0 text-green-500" />
              : <AlertTriangle size={18} className="shrink-0 text-amber-500" />}
            <div className="min-w-0">
              <p className="text-sm font-medium">Expo Access Token</p>
              <p className="text-xs text-muted-foreground">
                {data?.configured.expoToken
                  ? "Configured — update history available"
                  : "Not set. Add EXPO_ACCESS_TOKEN to Secrets."}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className={data?.configured.github ? "border-green-500/30" : "border-amber-500/30"}>
          <CardContent className="flex items-center gap-3 p-4">
            {data?.configured.github
              ? <CheckCircle2 size={18} className="shrink-0 text-green-500" />
              : <AlertTriangle size={18} className="shrink-0 text-amber-500" />}
            <div className="min-w-0">
              <p className="text-sm font-medium">GitHub Actions</p>
              <p className="truncate text-xs text-muted-foreground">
                {data?.configured.github
                  ? `${data.configured.githubRepo} — dispatch enabled`
                  : "Set GITHUB_TOKEN + GITHUB_REPO to enable triggering."}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── EAS API error banner ──────────────────────────────────────────────── */}
      {data?.error && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{data.error}</span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Trigger panel ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Rocket size={16} />
              Trigger OTA Update
            </CardTitle>
            <CardDescription>
              Bundles the current JS code and publishes it to the selected channel.
              Devices will download the update silently on next foreground resume.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!canTrigger && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
                <Info size={13} className="mt-0.5 shrink-0" />
                <span>
                  Set <code className="rounded bg-amber-500/10 px-1 font-mono">GITHUB_TOKEN</code> (fine-grained,{" "}
                  <code className="rounded bg-amber-500/10 px-1 font-mono">actions:write</code>) and{" "}
                  <code className="rounded bg-amber-500/10 px-1 font-mono">GITHUB_REPO</code> (e.g.{" "}
                  <code className="rounded bg-amber-500/10 px-1 font-mono">templeapp/temple-tv</code>) in Secrets to enable
                  this button.
                </span>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="channel-select">Channel</Label>
              <Select value={channel} onValueChange={(v) => setChannel(v as Channel)}>
                <SelectTrigger id="channel-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNELS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      <div className="flex items-center gap-2">
                        {c.icon}
                        <span>{c.label}</span>
                        <span className="text-muted-foreground text-xs">— {c.description}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ota-message">Release message</Label>
              <Textarea
                id="ota-message"
                placeholder="e.g. Fix mini player visibility on Android 15"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                maxLength={500}
              />
              <p className="text-right text-xs text-muted-foreground">{message.length}/500</p>
            </div>

            <Button
              className="w-full gap-2"
              disabled={!canTrigger || !message.trim() || isPending || isLoading}
              onClick={() => setConfirmOpen(true)}
            >
              {isPending
                ? <><Loader2 size={14} className="animate-spin" /> Queuing…</>
                : <><Rocket size={14} /> Publish to {channelInfo.label}</>}
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              GitHub Actions will bundle and publish within ~3 minutes.
              Only JS and asset changes are included — no native rebuild.
            </p>
          </CardContent>
        </Card>

        {/* ── Workflow runs ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock size={16} />
              Recent Workflow Runs
            </CardTitle>
            <CardDescription>
              Last 10 OTA update jobs from GitHub Actions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 size={20} className="animate-spin text-muted-foreground" />
              </div>
            )}
            {isError && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Could not load workflow runs.
              </p>
            )}
            {!data?.configured.github && !isLoading && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Configure GitHub credentials to see run history.
              </p>
            )}
            {data?.workflowRuns && data.workflowRuns.length === 0 && data.configured.github && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No workflow runs found.
              </p>
            )}
            <div className="space-y-2">
              {data?.workflowRuns.map((run) => (
                <div
                  key={run.id}
                  className="flex items-start justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="line-clamp-1 text-sm font-medium">
                      {run.message?.split("\n")[0] ?? "OTA Update"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {relativeTime(run.created_at)}
                      {run.status === "in_progress" && (
                        <span className="ml-1 text-blue-500">· in progress</span>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <RunStatusBadge status={run.status} conclusion={run.conclusion} />
                    <a
                      href={run.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      title="Open in GitHub"
                    >
                      <ExternalLink size={13} />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── EAS update history per channel ───────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Smartphone size={16} />
            EAS Update History by Channel
          </CardTitle>
          <CardDescription>
            Last 5 published updates per channel, fetched from the Expo EAS API.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          )}
          {!data?.configured.expoToken && !isLoading && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Add <code className="rounded bg-muted px-1 font-mono text-xs">EXPO_ACCESS_TOKEN</code> to see update history.
            </p>
          )}
          {data?.branches && data.branches.length === 0 && data.configured.expoToken && !data.error && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No update branches found. Publish an update to get started.
            </p>
          )}
          <div className="space-y-2">
            {data?.branches.map((branch) => (
              <BranchPanel key={branch.id} branch={branch} />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── How it works callout ─────────────────────────────────────────────── */}
      <Card className="bg-muted/30">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <Info size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
            <div className="space-y-1 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">How OTA updates work</p>
              <p>
                Clicking "Publish" triggers the <code className="rounded bg-muted px-1 font-mono text-xs">ota-update.yml</code>{" "}
                GitHub Actions workflow via <code className="rounded bg-muted px-1 font-mono text-xs">workflow_dispatch</code>.
                The workflow checks out the latest code, runs <code className="rounded bg-muted px-1 font-mono text-xs">eas update</code>,
                and uploads the new JS bundle to Expo's CDN.
              </p>
              <p>
                Devices on the selected channel download the bundle silently on their next app foreground (within 30 min).
                The <strong>runtime version policy is</strong> <code className="rounded bg-muted px-1 font-mono text-xs">appVersion</code> —
                OTA updates only reach devices running the same native version.
                If you've changed native code, a full store build is required.
              </p>
              <Separator className="my-2" />
              <p>
                <strong>Required secrets:</strong>{" "}
                <code className="rounded bg-muted px-1 font-mono text-xs">GITHUB_TOKEN</code> (fine-grained PAT, <em>actions:write</em>),{" "}
                <code className="rounded bg-muted px-1 font-mono text-xs">GITHUB_REPO</code> (owner/repo),{" "}
                <code className="rounded bg-muted px-1 font-mono text-xs">EXPO_ACCESS_TOKEN</code> (for update history).
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Confirm dialog ───────────────────────────────────────────────────── */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish OTA update to {channelInfo.label}?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                This will trigger the GitHub Actions workflow and publish the current JS bundle
                to all devices on the <strong>{channelInfo.label}</strong> channel.
              </span>
              <span className="block font-medium text-foreground">
                "{message}"
              </span>
              <span className="block">
                Devices will receive the update silently on next app foreground.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => publish({ channel, message: message.trim() })}
              className="gap-1"
            >
              <Rocket size={13} /> Publish now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
