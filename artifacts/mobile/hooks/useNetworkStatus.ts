/**
 * useNetworkStatus — thin consumer of the singleton NetworkContext.
 *
 * This hook used to contain its own polling logic. That logic now lives in
 * NetworkContext (context/NetworkContext.tsx) so the whole app shares a single
 * interval instead of every screen starting its own. This file is kept as a
 * re-export shim so existing imports continue to work unchanged.
 */

import { useNetworkContext } from "@/context/NetworkContext";

export function useNetworkStatus() {
  return useNetworkContext();
}
