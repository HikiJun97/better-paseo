/**
 * The prompt's rewind menu comes from the host (Paseo with RewindMenu): newer
 * patched hosts put it in `client/ui`, older ones only in the old
 * `client/react-native` entry. On a stock host neither has it and the menu is
 * borrowed from the host's bundle instead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";

afterEach(() => {
  vi.doUnmock("react-native");
  vi.doUnmock("@getpaseo/plugin/client/ui");
  vi.doUnmock("../../client/ui/legacy-host-entry");
});

async function load(menuIn: "none" | "ui" | "legacy") {
  vi.resetModules();
  const RewindMenu = vi.fn(() => null);
  vi.doMock("react-native", () => import("./helpers/rn-mock"));
  vi.doMock("@getpaseo/plugin/client/ui", () =>
    menuIn === "ui" ? { Icon: () => null, RewindMenu } : { Icon: () => null },
  );
  vi.doMock("../../client/ui/legacy-host-entry", () => ({
    LEGACY_HOST_ENTRY: menuIn === "legacy" ? { RewindMenu } : {},
  }));
  const module = await import("../../client/ui/host-rewind");
  return { module, RewindMenu };
}

describe("host rewind menu", () => {
  it("falls back to the bundled menu on a host without RewindMenu", async () => {
    const { module } = await load("none");
    const { BundledRewindMenu } = await import("../../client/ui/bundled-rewind");
    expect(module.HOST_REWIND_MENU).toBe(BundledRewindMenu);
  });

  it.each(["ui", "legacy"] as const)("is the host's component where the host provides it in %s", async (menuIn) => {
    const { module, RewindMenu } = await load(menuIn);
    expect(module.HOST_REWIND_MENU).toBe(RewindMenu);
  });

  it("refuses anything that is not a component", async () => {
    const { module } = await load("none");
    expect(module.resolveRewindMenu({ RewindMenu: 1 })).toBeNull();
    expect(module.resolveRewindMenu(null)).toBeNull();
    expect(module.resolveRewindMenu(undefined)).toBeNull();
    const component = () => null;
    expect(module.resolveRewindMenu({ RewindMenu: component })).toBe(component);
  });
});
