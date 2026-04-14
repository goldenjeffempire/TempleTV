import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { configureAdminAccess } from "@/lib/admin-access";

configureAdminAccess();
createRoot(document.getElementById("root")!).render(<App />);
