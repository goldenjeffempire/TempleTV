import { useState } from "react";
import { Button } from "@/components/ui/button";
import { adminPost } from "@/services/adminApi";
import { CheckCircle2, AlertTriangle, Loader2, ShieldCheck } from "lucide-react";

type Status =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; bucket: string; region: string; etag: string | null }
  | { kind: "fail"; title: string; detail: string; remediation: string };

interface PresignResponse {
  presignedUrl: string;
  objectKey: string;
  bucket: string;
  region: string;
}

const TEST_PAYLOAD = new Blob(["temple-tv-cors-probe"], {
  type: "application/octet-stream",
});

async function runProbe(): Promise<Status> {
  let presign: PresignResponse;
  try {
    presign = await adminPost<PresignResponse>(
      "/api/admin/videos/upload/s3-cors-test",
      {},
    );
  } catch (err) {
    return {
      kind: "fail",
      title: "API server unreachable",
      detail: err instanceof Error ? err.message : String(err),
      remediation:
        "Check that the API server is running and you are signed in as an admin.",
    };
  }

  let putResp: Response;
  const started = performance.now();
  try {
    putResp = await fetch(presign.presignedUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: TEST_PAYLOAD,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const elapsed = Math.round(performance.now() - started);
    return {
      kind: "fail",
      title: "Browser blocked the PUT to S3",
      detail: `Network error after ${elapsed}ms: ${msg}`,
      remediation:
        "The S3 bucket's CORS policy is missing this admin's origin. Apply the CORS JSON shown in the docs and hard-refresh.",
    };
  }

  if (!putResp.ok) {
    const body = await putResp.text().catch(() => "");
    return {
      kind: "fail",
      title: `S3 returned HTTP ${putResp.status}`,
      detail: body.slice(0, 300) || putResp.statusText,
      remediation:
        putResp.status === 403
          ? "Bucket policy or IAM credentials reject this PUT. Check AWS_ACCESS_KEY_ID has s3:PutObject on this bucket."
          : "Inspect the S3 response body above for the precise reason.",
    };
  }

  const etag = putResp.headers.get("ETag");
  if (!etag) {
    return {
      kind: "fail",
      title: "PUT succeeded but ETag is hidden",
      detail:
        "The browser cannot read the ETag header of the response, which means multipart uploads will fail to assemble even though bytes uploaded successfully.",
      remediation:
        "Add `\"ETag\"` to the ExposeHeaders list in the bucket's CORS policy and hard-refresh.",
    };
  }

  return {
    kind: "ok",
    bucket: presign.bucket,
    region: presign.region,
    etag,
  };
}

export function S3CorsTestButton() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const onClick = async () => {
    setStatus({ kind: "running" });
    setStatus(await runProbe());
  };

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <ShieldCheck className="h-4 w-4" />
          <span>Verify S3 bucket CORS without a real upload.</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClick}
          disabled={status.kind === "running"}
        >
          {status.kind === "running" ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Testing…
            </>
          ) : (
            "Test S3 CORS"
          )}
        </Button>
      </div>

      {status.kind === "ok" && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-300">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <div className="font-medium">CORS policy is correct.</div>
            <div className="mt-0.5 text-emerald-300/80">
              Uploaded 1-byte test object to bucket{" "}
              <code className="font-mono">{status.bucket}</code> ({status.region}). ETag{" "}
              <code className="font-mono">{status.etag}</code> is readable.
            </div>
          </div>
        </div>
      )}

      {status.kind === "fail" && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="space-y-1">
            <div className="font-medium">{status.title}</div>
            <div className="text-amber-200/80">{status.detail}</div>
            <div className="pt-0.5 text-amber-100">
              <span className="font-medium">Fix: </span>
              {status.remediation}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
