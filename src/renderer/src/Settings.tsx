import "@/assets/main.css";

import { Settings } from "@/windows/Settings";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "@/lib/theme.utils";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Settings />
  </StrictMode>,
);
