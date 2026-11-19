import "@salt-ds/theme/index.css";
import { SaltProvider } from "@salt-ds/core";
import { ThemeProvider } from "@mui/material";
import { createRoot } from "react-dom/client";
import { Desk } from "./Desk";

createRoot(document.getElementById("root")!).render(
  <SaltProvider mode="dark" density="high">
    <ThemeProvider theme={{}}>
      <Desk />
    </ThemeProvider>
  </SaltProvider>,
);
