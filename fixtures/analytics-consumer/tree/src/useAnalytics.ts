import { init, track } from "@acme/analytics";

export function useAnalytics(sessionId: string) {
  init({ appId: "mf-admin", sessionId, endpoint: "/__analytics" });
  return (name: string, properties: Record<string, unknown>) => track(name, properties);
}
