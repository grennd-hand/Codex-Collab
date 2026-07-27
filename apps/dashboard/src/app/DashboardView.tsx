import { FluentProvider } from "@fluentui/react-components";
import type { DashboardViewModel } from "./dashboard-view-model.js";
import { DashboardDialogs } from "./DashboardDialogs.js";
import { DashboardWorkspaceView } from "./DashboardWorkspaceView.js";
import { darkTheme, lightTheme } from "./shell/theme.js";

export function DashboardView({ model }: { model: DashboardViewModel }) {
  return (
    <FluentProvider
      theme={model.themeMode === "dark" ? darkTheme : lightTheme}
      className="app-provider"
    >
      <div className="app-frame">
        <DashboardWorkspaceView model={model} />
      </div>
      <DashboardDialogs model={model} />
    </FluentProvider>
  );
}
