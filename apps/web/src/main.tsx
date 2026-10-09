import "./lib/theme-boot.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./fonts.css";
import "@spdex/ui/theme.css";
import "./backdrop.css";
import { App } from "./App.js";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
