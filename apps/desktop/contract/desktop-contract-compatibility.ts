import type { CodexCollabDesktopApiV1 as DashboardContract } from "../../dashboard/src/shared/runtime/desktop-contract.js";
import type { CodexCollabDesktopApiV1 as DesktopContract } from "../src/ipc-contract.js";

declare const dashboardContract: DashboardContract;
declare const desktopContract: DesktopContract;

const dashboardAcceptsDesktop: DashboardContract = desktopContract;
const desktopAcceptsDashboard: DesktopContract = dashboardContract;

void dashboardAcceptsDesktop;
void desktopAcceptsDashboard;
