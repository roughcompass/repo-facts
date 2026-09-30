const SHELL_ORIGIN = "http://127.0.0.1:9100";

export function sendHostMessage(type, payload) {
  window.parent.postMessage({ source: "legacy-portal", type, payload }, SHELL_ORIGIN);
}

// window.parent.postMessage({ type: "decoy" }, "http://decoy.example.test");
export function onHostMessage(listener) {
  window.addEventListener("message", listener);
}
