import { DashboardView } from "./app/DashboardView.js";
import {
  DashboardController,
  type DashboardControllerProps,
} from "./app/DashboardController.js";

export type AppProps = Omit<DashboardControllerProps, "view">;

export function App(props: AppProps) {
  return <DashboardController {...props} view={DashboardView} />;
}
