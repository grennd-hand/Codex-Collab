import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DashboardController } from "../../dashboard/src/app/DashboardController.js";
import { initializeDashboardRuntime } from "../../dashboard/src/shared/runtime/index.js";
import { DesktopView } from "./app/DesktopView.js";
import "../../dashboard/src/styles.css";
import "./styles/desktop.css";

async function bootstrap(): Promise<void> {
  const runtime = await initializeDashboardRuntime();
  if (runtime.kind !== "desktop") {
    throw new Error("Desktop renderer requires the Electron preload runtime.");
  }
  const initialCredential = await runtime.credentials.load();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <DashboardController
        runtime={runtime}
        initialCredential={initialCredential}
        initialInviteToken={runtime.inviteToken}
        view={DesktopView}
      />
    </StrictMode>,
  );
}

void bootstrap();
