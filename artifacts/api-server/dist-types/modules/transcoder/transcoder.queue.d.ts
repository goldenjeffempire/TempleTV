export type TranscodingJobWithVideo = {
    id: string;
    videoId: string | null;
    status: string;
    priority: number;
    createdAt: Date;
    updatedAt: Date;
};
export declare function enqueueTranscode(_args: {
    videoId: string;
    objectKey?: string;
    priority?: number;
    reason?: string;
}): Promise<{
    jobId: string;
    queued: boolean;
}>;
export declare function listJobs(_opts?: {
    limit?: number;
    status?: string;
}): Promise<TranscodingJobWithVideo[]>;
export declare function getJob(_id: string): Promise<TranscodingJobWithVideo | null>;
export declare function deleteJob(_id: string): Promise<boolean>;
export declare function clearJobsByStatus(_status: string): Promise<number>;
export declare function retryAllFailed(): Promise<number>;
export declare function retryJob(_id: string): Promise<boolean>;
export declare function cancelJob(_id: string): Promise<{
    ok: boolean;
    reason?: string;
}>;
export declare function boostTranscodePriority(_videoId: string): Promise<boolean>;
export declare function queueStats(): Promise<{
    activeCount: number;
    queuedCount: number;
    completedToday: number;
    failedToday: number;
}>;
export declare function requeueFromDlq(_id: string): Promise<{
    ok: boolean;
    reason?: string;
}>;
export declare function purgeDlqEntry(_id: string): Promise<boolean>;
export declare function purgeDlqAll(): Promise<number>;
