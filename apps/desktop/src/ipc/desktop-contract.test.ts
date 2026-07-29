import { describe, expect, it } from "vitest";
import type { CodexCollabDesktopApiV1 as DashboardContract } from "../../../dashboard/src/shared/runtime/desktop-contract.js";
import type { CodexCollabDesktopApiV1 as DesktopContract } from "./ipc-contract.js";

describe("Dashboard/Desktop preload ABI", () => {
  it("remains assignable in both directions", () => {
    const dashboardAcceptsDesktop: DashboardContract = null as unknown as DesktopContract;
    const desktopAcceptsDashboard: DesktopContract = null as unknown as DashboardContract;
    expect(dashboardAcceptsDesktop).toBeNull();
    expect(desktopAcceptsDashboard).toBeNull();
  });
});
