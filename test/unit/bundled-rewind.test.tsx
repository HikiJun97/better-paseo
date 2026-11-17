/**
 * On a stock host the rewind menu is borrowed from the host's own Metro bundle:
 * the module ids are read from the bundle text by export name, the three
 * exports are loaded through the host's `require`, and the prompt bubble wires
 * them up the way the host's own bubble does.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import "./helpers/quiet-renderer";
import {
  findModuleIds,
  readHostModules,
  ResolvedRewindMenu,
  type HostRewindModules,
} from "../../client/ui/bundled-rewind";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The three module lines from Paseo 0.15.4's web bundle, shortened. Their ids
// are the `},<id>,[` at the end of each line.
const BUNDLE = readFileSync(new URL("../fixtures/paseo-0.15.4-rewind-modules.js", import.meta.url), "utf8");
const IDS_0_15_4 = { menu: 5190, mutation: 5192, store: 3402 };

describe("findModuleIds", () => {
  it("reads the ids of the menu, mutation and session store modules", () => {
    expect(findModuleIds(BUNDLE)).toEqual(IDS_0_15_4);
  });

  it("takes the end of the module holding the export, not an earlier module", () => {
    const earlier = '__d(function(g,r,i,a,m,e,d){"use strict";e.other=1},7,[1]);\n';
    expect(findModuleIds(earlier + BUNDLE)).toEqual(IDS_0_15_4);
  });

  it("gives up when an export is missing", () => {
    const withoutStore = BUNDLE.split("\n").filter((line) => !line.includes('"useSessionStore"')).join("\n");
    expect(findModuleIds(withoutStore)).toBeNull();
  });
});

describe("readHostModules", () => {
  const ids = { menu: 1, mutation: 2, store: 3 };
  // The host's RewindMenu is wrapped in `memo`, which is an object, not a function.
  const memoMenu = { $$typeof: Symbol.for("react.memo"), type: () => null };
  const useRewindAgentMutation = () => ({ rewindAgent: async () => {}, isPending: false });
  const useSessionStore = () => null;

  it("returns the three exports, accepting a memo component", () => {
    const exports: Record<number, unknown> = {
      1: { RewindMenu: memoMenu },
      2: { useRewindAgentMutation },
      3: { useSessionStore },
    };
    expect(readHostModules((id) => exports[id], ids)).toEqual({
      RewindMenu: memoMenu,
      useRewindAgentMutation,
      useSessionStore,
    });
  });

  it("refuses a module whose export has the wrong shape", () => {
    const exports: Record<number, unknown> = { 1: { RewindMenu: 1 }, 2: { useRewindAgentMutation }, 3: { useSessionStore } };
    expect(readHostModules((id) => exports[id], ids)).toBeNull();
  });

  it("returns null when the host's require throws", () => {
    const require = () => {
      throw new Error('Requiring unknown module "1".');
    };
    expect(readHostModules(require, ids)).toBeNull();
  });
});

describe("ResolvedRewindMenu", () => {
  const capabilities = { supportsRewindConversation: true, supportsRewindFiles: true, supportsRewindBoth: true };
  const client = { name: "mac-client" };
  // Two hosts and two agents, so a lookup by the wrong key finds the wrong agent.
  const state = {
    sessions: {
      mac: { client, agents: new Map([["agent-1", { capabilities }], ["agent-2", { capabilities: {} }]]) },
      mini: { client: { name: "mini-client" }, agents: new Map([["agent-1", { capabilities: {} }]]) },
    },
  };

  function render(props: { hostId: string; agentId: string; messageId?: string; text: string }) {
    const RewindMenu = vi.fn((_props: Record<string, unknown>) => null);
    const rewindAgent = vi.fn(async () => {});
    const useRewindAgentMutation = vi.fn(() => ({ rewindAgent, isPending: true }));
    const modules = {
      RewindMenu,
      useRewindAgentMutation,
      useSessionStore: (selector: (s: typeof state) => unknown) => selector(state),
    } as unknown as HostRewindModules;
    act(() => {
      TestRenderer.create(<ResolvedRewindMenu {...props} modules={modules} />);
    });
    return { RewindMenu, rewindAgent, useRewindAgentMutation };
  }

  it("draws the host menu for the agent on its own host, wired to the host's rewind", () => {
    const { RewindMenu, rewindAgent, useRewindAgentMutation } = render({
      hostId: "mac",
      agentId: "agent-1",
      messageId: "msg_1",
      text: "the prompt",
    });
    expect(useRewindAgentMutation).toHaveBeenLastCalledWith({ serverId: "mac", agentId: "agent-1", client, messageId: "msg_1" });
    expect(RewindMenu).toHaveBeenCalledTimes(1);
    expect(RewindMenu.mock.calls[0]![0]).toEqual({
      capabilities,
      rewoundText: "the prompt",
      isPending: true,
      onRewind: rewindAgent,
    });
  });

  it("draws nothing for a prompt without a message id", () => {
    const { RewindMenu } = render({ hostId: "mac", agentId: "agent-1", text: "queued" });
    expect(RewindMenu).not.toHaveBeenCalled();
  });

  it("draws nothing for an agent the host has not loaded", () => {
    const { RewindMenu } = render({ hostId: "mac", agentId: "agent-9", messageId: "msg_1", text: "x" });
    expect(RewindMenu).not.toHaveBeenCalled();
  });
});
