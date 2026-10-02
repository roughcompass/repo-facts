import "@salt-ds/theme/index.css";
import "./global.css";
import { SaltProvider } from "@salt-ds/core";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <SaltProvider mode="light">
    <App />
  </SaltProvider>,
);
