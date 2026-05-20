import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { RefreshCw, Settings, CheckCircle2 } from "lucide-react";

interface PlaybackState {
  mode: string;
  cdnEnabled: boolean;
  adaptiveBitrate: boolean;
  maxBitrate?: number;
  defaultQuality?: string;
  cacheEnabled?: boolean;
  hlsSegmentDuration?: number;
}

export default function PlaybackPage() {
  const qc = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["playback-state"],
    queryFn: () => api.get<PlaybackState>("/admin/playback/config"),
    refetchInterval: 30_000,
  });

  const updateMutation = useMutation({
    mutationFn: (body: Partial<PlaybackState>) => api.patch("/admin/playback/config", body),
    onSuccess: () => { toast.success("Playback settings updated"); void qc.invalidateQueries({ queryKey: ["playback-state"] }); },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to update"),
  });

  const fields = data ? [
    { label: "Mode", value: data.mode ?? "—", badge: true },
    { label: "CDN Enabled", value: data.cdnEnabled ? "Yes" : "No", ok: data.cdnEnabled },
    { label: "Adaptive Bitrate", value: data.adaptiveBitrate ? "Enabled" : "Disabled", ok: data.adaptiveBitrate },
    { label: "Max Bitrate", value: data.maxBitrate ? `${data.maxBitrate} Kbps` : "Unlimited" },
    { label: "Default Quality", value: data.defaultQuality ?? "auto" },
    { label: "Cache", value: data.cacheEnabled ? "Enabled" : "Disabled", ok: data.cacheEnabled },
    { label: "HLS Segment Duration", value: data.hlsSegmentDuration ? `${data.hlsSegmentDuration}s` : "—" },
  ] : [];

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <PageHeader
        title="Playback Engine"
        description="HLS delivery configuration, CDN settings, and adaptive bitrate controls."
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
            <RefreshCw size={13} /> Refresh
          </Button>
        }
      />

      {error && (
        <ErrorAlert
          message={(error as Error).message}
          onRetry={() => void refetch()}
          transient={isTransientError(error)}
        />
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Settings size={15} /> Playback Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : fields.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No playback configuration available</p>
          ) : (
            <div className="divide-y">
              {fields.map(f => (
                <div key={f.label} className="flex items-center justify-between py-3">
                  <span className="text-sm text-muted-foreground">{f.label}</span>
                  <div className="flex items-center gap-2">
                    {"ok" in f && f.ok !== undefined && (
                      <CheckCircle2 size={13} className={f.ok ? "text-green-500" : "text-muted-foreground/30"} />
                    )}
                    <Badge variant="outline" className="capitalize text-xs">{f.value}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {data && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => updateMutation.mutate({ cdnEnabled: !data.cdnEnabled })}
            disabled={updateMutation.isPending}
            size="sm"
          >
            {data.cdnEnabled ? "Disable CDN" : "Enable CDN"}
          </Button>
          <Button
            variant="outline"
            onClick={() => updateMutation.mutate({ adaptiveBitrate: !data.adaptiveBitrate })}
            disabled={updateMutation.isPending}
            size="sm"
          >
            {data.adaptiveBitrate ? "Disable ABR" : "Enable ABR"}
          </Button>
        </div>
      )}
    </div>
  );
}
