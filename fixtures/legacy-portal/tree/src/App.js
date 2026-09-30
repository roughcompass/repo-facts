import { sendHostMessage } from "./runtime";
export function App() {
  sendHostMessage("ready", {});
  return null;
}
