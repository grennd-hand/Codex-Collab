import { FluentProvider } from "@fluentui/react-components";
import { DashboardDialogs } from "../../../dashboard/src/app/DashboardDialogs.js";
import type { DashboardViewModel } from "../../../dashboard/src/app/dashboard-view-model.js";
import {
  darkTheme,
  lightTheme,
} from "../../../dashboard/src/app/shell/theme.js";
import { DesktopWorkspaceShell } from "../shell/DesktopWorkspaceShell.js";

export function DesktopView({ model }: { model: DashboardViewModel }) {
  return (
    <FluentProvider
      theme={model.themeMode === "dark" ? darkTheme : lightTheme}
      className="desktop-provider"
    >
      <DesktopWorkspaceShell model={model} />
      <DashboardDialogs model={model} />
    </FluentProvider>
  );
}
