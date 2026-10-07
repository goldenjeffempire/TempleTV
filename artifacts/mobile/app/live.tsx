import React, { useEffect } from "react";
import { safeNavReplace } from "@/lib/safeNavPush";

/**
 * Compatibility alias for Android notification/deep-link payloads that use
 * /live. Keep this route visually empty: replacing in an effect avoids a
 * broken placeholder screen flashing before the canonical player mounts.
 */
export default function LiveAliasRoute() {
  useEffect(() => {
    safeNavReplace(
      "/player",
      {
        isLive: "true",
        title: "Live Broadcast",
        preacher: "JCTM Ministries",
      },
      "live-alias",
    );
  }, []);

  return null;
}