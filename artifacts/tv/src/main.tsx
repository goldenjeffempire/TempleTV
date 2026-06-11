import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { isTizen, isWebOS, isNativeTV } from "./lib/platform";

// Apply TV-platform body class early so CSS can adapt before React mounts
if (isNativeTV) {
  document.body.classList.add("tv-native");
}
if (isTizen) document.body.classList.add("tv-tizen");
if (isWebOS) document.body.classList.add("tv-webos");

// Register service worker for catalog + static asset caching.
// Skipped on native TV platforms (Tizen/webOS) where the SW API may not be
// available, and in development where instant HMR reloads are preferred over
// cache-first behaviour.
if (
  "serviceWorker" in navigator &&
  !isNativeTV &&
  import.meta.env.PROD
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => {
        // Non-fatal — the app works without the SW; log at debug level only.
        console.debug("[TV] service worker registration failed:", err);
      });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
