export interface DownloadNetwork {
  type?: string;
  isConnected?: boolean;
  isInternetReachable?: boolean;
}

/** Unknown transports and VPNs are blocked, not assumed to be free Wi-Fi. */
export function mayPrepareBroadcast(
  apiOnline: boolean, network: DownloadNetwork, allowCellular = false, broadcastVisible = true,
): boolean {
  return broadcastVisible && apiOnline && network.isConnected === true && network.isInternetReachable !== false &&
    (network.type === "WIFI" || network.type === "ETHERNET" ||
      (allowCellular && network.type === "CELLULAR"));
}

/** MP4 standby slots must not consume cellular data; an actual handoff must load. */
export function mayLoadBroadcastBuffer(input: {
  kind?: string; active: boolean; local: boolean; preload: boolean; required: boolean;
}): boolean {
  return input.kind !== "mp4" || input.active || input.local || input.preload || input.required;
}
