import { useEffect, useState } from "react";

function getIsOnline() {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

export function ConnectivityBanner() {
  const [isOnline, setIsOnline] = useState(getIsOnline);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="assertive"
      className="fixed left-1/2 top-4 z-[10000] -translate-x-1/2 rounded-md border border-red-400/50 bg-red-950/90 px-4 py-2 text-sm font-medium text-red-100 shadow-lg"
    >
      Network disconnected. Playback and API updates may be delayed.
    </div>
  );
}
