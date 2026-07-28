import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializeDashboardRuntime } from "./shared/runtime/index.js";
import "./styles.css";

async function bootstrap(): Promise<void> {
  const runtime = await initializeDashboardRuntime();
  const initialCredential = await runtime.credentials.load();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App
        runtime={runtime}
        initialCredential={initialCredential}
        initialInviteToken={runtime.inviteToken}
      />
    </StrictMode>,
  );
}

void bootstrap();
