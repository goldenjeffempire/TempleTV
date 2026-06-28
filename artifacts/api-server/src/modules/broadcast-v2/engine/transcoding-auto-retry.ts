export interface TranscodingAutoRetryStatus {
  enabled: boolean;
  lastRunAt: number | null;
  lastRunFound: number;
  lastRunQueued: number;
}

export function getTranscodingAutoRetryStatus(): TranscodingAutoRetryStatus {
  return { enabled: false, lastRunAt: null, lastRunFound: 0, lastRunQueued: 0 };
}

export async function transcodingAutoRetryScan(): Promise<void> {}
