export interface ConnectivityResult {
  online: boolean;
  /** True when internet is up but only the app API probe failed. */
  apiUnreachable: boolean;
}

/**
 * The app API is the authoritative connectivity signal. Third-party probes
 * are only needed to distinguish an API outage from a full internet outage.
 */
export function deriveConnectivityStatus(
  apiAvailable: boolean,
  fallbackResults: readonly boolean[],
): ConnectivityResult {
  if (apiAvailable) {
    return { online: true, apiUnreachable: false };
  }

  if (fallbackResults.some(Boolean)) {
    return { online: false, apiUnreachable: true };
  }

  return { online: false, apiUnreachable: false };
}