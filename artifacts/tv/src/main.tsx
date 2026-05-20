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

createRoot(document.getElementById("root")!).render(<App />);
