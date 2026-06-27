import React, { createContext, useContext, ReactNode } from "react";
import { useDownloads } from "@/hooks/useDownloads";
import type { DownloadItem } from "@/services/downloadManager";
import type { Sermon } from "@/types";

interface DownloadContextValue {
  downloads: DownloadItem[];
  completed: DownloadItem[];
  active: DownloadItem[];
  failed: DownloadItem[];
  paused: DownloadItem[];
  initialized: boolean;
  addDownload: (sermon: Sermon) => Promise<void>;
  pauseDownload: (videoId: string) => Promise<void>;
  resumeDownload: (videoId: string) => Promise<void>;
  cancelDownload: (videoId: string) => Promise<void>;
  retryDownload: (videoId: string) => Promise<void>;
  clearCompleted: () => Promise<void>;
  clearAll: () => Promise<void>;
  isDownloaded: (videoId: string) => boolean;
  getLocalPath: (videoId: string) => string | null;
  getDownloadItem: (videoId: string) => DownloadItem | undefined;
  isDownloadable: (sermon: Sermon) => boolean;
  getTotalStorageBytes: () => Promise<number>;
}

const DownloadContext = createContext<DownloadContextValue | null>(null);

export function DownloadProvider({ children }: { children: ReactNode }) {
  const value = useDownloads();
  return (
    <DownloadContext.Provider value={value}>
      {children}
    </DownloadContext.Provider>
  );
}

export function useDownloadContext(): DownloadContextValue {
  const ctx = useContext(DownloadContext);
  if (!ctx) throw new Error("useDownloadContext must be used inside DownloadProvider");
  return ctx;
}
