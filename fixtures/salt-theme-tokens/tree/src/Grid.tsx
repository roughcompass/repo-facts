import "@salt-ds/theme/index.css";
import "./theme-tokens.css";
import { SaltProvider } from "@salt-ds/core";

export const Grid = () => (
  <SaltProvider>
    <div className="token-1">Grid</div>
  </SaltProvider>
);
