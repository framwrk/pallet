import "./assets/main.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Settings } from "./windows/Settings";
import { initTheme } from "./lib/theme";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Settings />
  </StrictMode>,
);
