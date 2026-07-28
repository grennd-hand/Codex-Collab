import { createBrowserRuntime } from "./browser-runtime.js";
import { createDesktopRuntime } from "./desktop-runtime.js";
import type { DashboardRuntimeV1 } from "./types.js";

let activeRuntime: DashboardRuntimeV1 | null = null;

export async function initializeDashboardRuntime(): Promise<DashboardRuntimeV1> {
  const bridge = window.codexCollabDesktop;
  const runtime = bridge
    ? await createDesktopRuntime(bridge)
    : createBrowserRuntime();
  activeRuntime = runtime;
  return runtime;
}

export function setDashboardRuntime(runtime: DashboardRuntimeV1): void {
  activeRuntime = runtime;
}

export function getDashboardRuntime(): DashboardRuntimeV1 {
  if (!activeRuntime) {
    activeRuntime = createBrowserRuntime();
  }
  return activeRuntime;
}
