import { logger } from "../../infrastructure/logger.js";

export type TranscodingJobWithVideo = {
  id: string;
  videoId: string | null;
  status: string;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
};

export async function enqueueTranscode(_args: {
  videoId: string;
  objectKey?: string;
  priority?: number;
  reason?: string;
}): Promise<{ jobId: string; queued: boolean }> {
  logger.info("[transcoder-queue] enqueueTranscode no-op — MP4-only pipeline");
  return { jobId: "", queued: false };
}

export async function listJobs(_opts?: { limit?: number; status?: string }): Promise<TranscodingJobWithVideo[]> {
  return [];
}

export async function getJob(_id: string): Promise<TranscodingJobWithVideo | null> {
  return null;
}

export async function deleteJob(_id: string): Promise<boolean> {
  return false;
}

export async function clearJobsByStatus(_status: string): Promise<number> {
  return 0;
}

export async function retryAllFailed(): Promise<number> {
  return 0;
}

export async function retryJob(_id: string): Promise<boolean> {
  return false;
}

export async function cancelJob(_id: string): Promise<{ ok: boolean; reason?: string }> {
  return { ok: false, reason: "transcoding disabled" };
}

export async function boostTranscodePriority(_videoId: string): Promise<boolean> {
  return false;
}

export async function queueStats() {
  return { activeCount: 0, queuedCount: 0, completedToday: 0, failedToday: 0 };
}

export async function requeueFromDlq(_id: string): Promise<{ ok: boolean; reason?: string }> {
  return { ok: false, reason: "transcoding disabled" };
}

export async function purgeDlqEntry(_id: string): Promise<boolean> {
  return false;
}

export async function purgeDlqAll(): Promise<number> {
  return 0;
}
