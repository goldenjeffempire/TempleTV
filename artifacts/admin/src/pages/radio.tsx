import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError } from "@/lib/api";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Radio, Wifi, WifiOff, Play, Square, CheckCircle2,
  AlertCircle, Loader2, Save, ExternalLink,
} from "lucide-react";

interface RadioConfig {
  streamUrl:   string | null;
  title:       string;
  description: string;
  isActive:    boolean;
}

async function fetchRadioConfig(): Promise<RadioConfig> {
  return api.get<RadioConfig>("/v1/admin/radio");
}

async function updateRadioConfig(patch: Partial<RadioConfig>): Promise<RadioConfig> {
  return api.patch<RadioConfig>("/v1/admin/radio", patch);
}

export default function RadioPage() {
  const qc = useQueryClient();

  const { data: config, isLoading, error } = useQuery<RadioConfig>({
    queryKey:  ["admin", "radio"],
    queryFn:   fetchRadioConfig,
    staleTime: 30_000,
    retry:     2,
  });

  const mutation = useMutation({
    mutationFn: updateRadioConfig,
    onSuccess: (data) => {
      qc.setQueryData(["admin", "radio"], data);
      setDirty(false);
      toast.success("Radio settings saved");
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to save radio settings"),
  });

  // Form state
  const [streamUrl,   setStreamUrl]   = useState("");
  const [title,       setTitle]       = useState("");
  const [description, setDescription] = useState("");
  const [isActive,    setIsActive]    = useState(false);
  const [dirty,       setDirty]       = useState(false);
  const initialized = useRef(false);

  // Sync server state → form (once on first load)
  if (config && !initialized.current) {
    initialized.current = true;
    setStreamUrl(config.streamUrl ?? "");
    setTitle(config.title);
    setDescription(config.description);
    setIsActive(config.isActive);
  }

  // ── Live stream test ────────────────────────────────────────────────────────
  const [testState, setTestState]     = useState<"idle" | "loading" | "playing" | "error">("idle");
  const audioRef  = useRef<HTMLAudioElement | null>(null);

  // Stop audio and null out handlers when the page unmounts so the `playing`
  // and `error` event listener closures (which call setTestState) don't fire
  // against an unmounted component and leak memory.
  useEffect(() => {
    return () => stopAudio();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Warn the browser before the tab closes / navigates away when there are
  // unsaved changes so the operator doesn't accidentally lose their edits.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  function stopAudio() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current.onplaying = null;
      audioRef.current.onerror = null;
      audioRef.current = null;
    }
  }

  function testStream() {
    const url = streamUrl.trim();
    if (!url) return;

    if (testState === "playing" || testState === "loading") {
      stopAudio();
      setTestState("idle");
      return;
    }

    stopAudio();
    setTestState("loading");
    const audio = new window.Audio(url);
    audio.onplaying = () => setTestState("playing");
    audio.onerror   = () => setTestState("error");
    audio.play().catch(() => setTestState("error"));
    audioRef.current = audio;
  }

  function handleSave() {
    const patch: Partial<RadioConfig> = {};
    const trimmed = streamUrl.trim();
    if (trimmed !== (config?.streamUrl ?? "")) patch.streamUrl   = trimmed || null;
    if (title       !== config?.title)         patch.title       = title;
    if (description !== config?.description)   patch.description = description;
    if (isActive    !== config?.isActive)      patch.isActive    = isActive;
    if (Object.keys(patch).length === 0)       return;
    mutation.mutate(patch);
  }

  // ── Active toggle quick-save ──────────────────────────────────────────────
  function handleActiveToggle(checked: boolean) {
    setIsActive(checked);
    setDirty(true);
    mutation.mutate({ isActive: checked });
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 sm:p-6">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Failed to load radio config: {String(error)}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const isUrlValid = streamUrl.trim().length === 0 || /^https?:\/\/.+/.test(streamUrl.trim());
  const canSave = dirty && isUrlValid && !mutation.isPending;

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Radio className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Radio Station</h1>
            <p className="text-sm text-muted-foreground">
              Configure the live audio stream broadcast to all listeners
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {config?.isActive ? (
            <Badge className="bg-green-500/15 text-green-600 border-green-500/30 gap-1.5">
              <Wifi className="h-3 w-3" />
              Active
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1.5">
              <WifiOff className="h-3 w-3" />
              Inactive
            </Badge>
          )}
        </div>
      </div>

      {/* On-air toggle card */}
      <Card>
        <CardContent className="pt-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-full ${isActive ? "bg-green-500/15" : "bg-muted"}`}>
                {isActive ? (
                  <Radio className="h-4 w-4 text-green-600 animate-pulse" />
                ) : (
                  <Radio className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <div>
                <p className="font-semibold text-sm">Radio Mode</p>
                <p className="text-xs text-muted-foreground">
                  {isActive
                    ? "Stream is live — all listeners are receiving the broadcast"
                    : "Stream is offline — listeners see an inactive state"}
                </p>
              </div>
            </div>
            <Switch
              checked={isActive}
              onCheckedChange={handleActiveToggle}
              disabled={!config?.streamUrl || mutation.isPending}
              aria-label="Toggle radio active"
            />
          </div>
          {!config?.streamUrl && (
            <p className="text-xs text-amber-600 mt-3 flex items-center gap-1.5">
              <AlertCircle className="h-3 w-3 flex-shrink-0" />
              Configure a stream URL below before going live
            </p>
          )}
        </CardContent>
      </Card>

      {/* Stream configuration */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Stream Configuration</CardTitle>
          <CardDescription>
            Set the URL of your live audio stream. Supports HLS (.m3u8), MP3, AAC,
            and Icecast/SHOUTcast streams.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Stream URL */}
          <div className="space-y-2">
            <Label htmlFor="stream-url">Stream URL</Label>
            <div className="flex gap-2">
              <Input
                id="stream-url"
                type="url"
                placeholder="https://stream.example.com/live/radio.m3u8"
                value={streamUrl}
                onChange={(e) => { setStreamUrl(e.target.value); setDirty(true); }}
                className={!isUrlValid ? "border-destructive" : ""}
              />
              <Button
                variant="outline"
                size="default"
                onClick={testStream}
                disabled={!streamUrl.trim() || !isUrlValid}
                className="shrink-0 gap-1.5"
              >
                {testState === "loading" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {testState === "playing" && <Square className="h-3.5 w-3.5 text-red-500" />}
                {(testState === "idle" || testState === "error") && <Play className="h-3.5 w-3.5" />}
                {testState === "playing" ? "Stop" : "Test"}
              </Button>
            </div>
            {!isUrlValid && (
              <p className="text-xs text-destructive">Must be a valid http:// or https:// URL</p>
            )}
            {testState === "playing" && (
              <p className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Stream is playing — audio is live in this browser tab
              </p>
            )}
            {testState === "error" && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> Could not play stream — check the URL and CORS headers
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              The stream must allow cross-origin requests (CORS) from this admin domain.
            </p>
          </div>

          <Separator />

          {/* Station metadata */}
          <div className="space-y-2">
            <Label htmlFor="station-title">Station Title</Label>
            <Input
              id="station-title"
              placeholder="Temple TV Radio"
              value={title}
              onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
              maxLength={100}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="station-description">Description</Label>
            <Textarea
              id="station-description"
              placeholder="Live 24/7 Christian broadcast"
              value={description}
              onChange={(e) => { setDescription(e.target.value); setDirty(true); }}
              maxLength={400}
              rows={2}
            />
          </div>
        </CardContent>
      </Card>

      {/* Save */}
      {dirty && (
        <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
          <p className="text-sm text-muted-foreground">You have unsaved changes</p>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStreamUrl(config?.streamUrl ?? "");
                setTitle(config?.title ?? "Temple TV Radio");
                setDescription(config?.description ?? "");
                setIsActive(config?.isActive ?? false);
                setDirty(false);
              }}
            >
              Discard
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!canSave} className="gap-1.5">
              {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save Changes
            </Button>
          </div>
        </div>
      )}

      {mutation.isError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{String(mutation.error)}</AlertDescription>
        </Alert>
      )}

      {mutation.isSuccess && !dirty && (
        <Alert className="border-green-500/30 bg-green-500/10">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-700">
            Radio configuration saved successfully.
          </AlertDescription>
        </Alert>
      )}

      {/* Info panel */}
      <Card className="bg-muted/30">
        <CardContent className="pt-5 space-y-3">
          <p className="text-sm font-medium flex items-center gap-2">
            <ExternalLink className="h-4 w-4 text-muted-foreground" />
            How it works
          </p>
          <ul className="text-xs text-muted-foreground space-y-1.5 ml-6 list-disc">
            <li>All listeners connect to the same stream URL in real time — no desync between devices.</li>
            <li>Toggle <strong>Radio Mode</strong> ON/OFF from any surface (mobile Radio tab, etc.) to start or stop playback instantly.</li>
            <li>When Radio Mode is turned off, audio resources are released immediately — no background playback.</li>
            <li>Reconnection is automatic on network drops (exponential backoff: 2 s → 4 s → 8 s → 16 s → 30 s).</li>
            <li>Supported formats: HLS (`.m3u8`), MP3, AAC, Icecast/SHOUTcast HTTP streams.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
