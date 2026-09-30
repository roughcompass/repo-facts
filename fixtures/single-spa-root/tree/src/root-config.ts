import { registerApplication, start, type LifeCycles } from "single-spa";

// registerApplication({ name: "decoy-commented", app: load, activeWhen: "/" });
const help = "registerApplication({ name: 'decoy-string' })";

export function registerFleetApplications() {
  registerApplication({
    name: "spa-orders",
    app: () => window.System.import<LifeCycles>("spa-orders"),
    activeWhen: () => true,
  });
  registerApplication({
    name: "spa-reports",
    app: () => window.System.import<LifeCycles>("spa-reports"),
    activeWhen: () => true,
  });
  start();
}
