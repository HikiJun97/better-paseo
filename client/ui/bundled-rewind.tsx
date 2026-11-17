import { useMemo, useSyncExternalStore, type ComponentType } from "react";
import type { HostRewindMenuProps } from "./host-rewind";

/**
 * The rewind menu on a stock host, borrowed from the host's own bundle.
 *
 * Released Paseo (0.15.4) does not hand plugins its rewind menu (paseo#6677),
 * and the SDK has no rewind call. The host's web bundle is a Metro bundle,
 * though: Metro puts its `require` on the global as `__r`, so the plugin can
 * load the very modules the host's own prompt bubble uses: the menu, the
 * rewind mutation (rewind, timeline refetch, composer restore, error toast)
 * and the session store that holds the daemon client and the agent's rewind
 * capabilities. Module ids change with every host build, so they are read from
 * the loaded bundle text by export name, not hard-coded.
 *
 * Desktop and web only: a native host runs Hermes bytecode with no bundle text
 * to read. Anything unexpected (no `__r`, no script, a missing export) leaves
 * the menu out, as before.
 */

type RewindMode = "conversation" | "files" | "both";
type RewindCapabilities = Record<string, unknown>;

interface HostSessionState {
  sessions: Record<string, { client?: unknown; agents?: Map<string, { capabilities?: RewindCapabilities }> } | undefined>;
}

export interface HostRewindModules {
  RewindMenu: ComponentType<{
    capabilities: RewindCapabilities;
    rewoundText: string;
    isPending: boolean;
    onRewind: (input: { mode: RewindMode }) => Promise<void>;
  }>;
  useRewindAgentMutation: (input: { serverId: string; agentId: string; client: unknown; messageId?: string }) => {
    rewindAgent: (input: { mode: RewindMode }) => Promise<void>;
    isPending: boolean;
  };
  useSessionStore: <T>(selector: (state: HostSessionState) => T) => T;
}

export interface HostModuleIds {
  menu: number;
  mutation: number;
  store: number;
}

const MARKERS: Record<keyof HostModuleIds, RegExp> = {
  menu: /defineProperty\(\w+,"RewindMenu",/,
  mutation: /\.useRewindAgentMutation=function/,
  store: /defineProperty\(\w+,"useSessionStore",/,
};

/** Metro writes one module per line and ends each with `},<id>,[<deps>]);`. */
const MODULE_END = /\},(\d+),\[[\d,]*\]\);\n/g;

/** The ids of the modules that export the menu, the mutation and the store, or null if any is missing. */
export function findModuleIds(bundle: string): HostModuleIds | null {
  const ids: Partial<HostModuleIds> = {};
  for (const key of Object.keys(MARKERS) as (keyof HostModuleIds)[]) {
    const marker = MARKERS[key].exec(bundle);
    if (!marker) return null;
    MODULE_END.lastIndex = marker.index;
    const end = MODULE_END.exec(bundle);
    if (!end) return null;
    ids[key] = Number(end[1]);
  }
  return ids as HostModuleIds;
}

function isComponent(value: unknown): boolean {
  // `memo` returns an object, a plain component is a function.
  return typeof value === "function" || (typeof value === "object" && value !== null && "$$typeof" in value);
}

/** The three exports, or null if a module does not have the expected shape. */
export function readHostModules(require: (id: number) => unknown, ids: HostModuleIds): HostRewindModules | null {
  try {
    const menu = (require(ids.menu) as Record<string, unknown> | null)?.RewindMenu;
    const mutation = (require(ids.mutation) as Record<string, unknown> | null)?.useRewindAgentMutation;
    const store = (require(ids.store) as Record<string, unknown> | null)?.useSessionStore;
    if (!isComponent(menu) || typeof mutation !== "function" || typeof store !== "function") return null;
    return {
      RewindMenu: menu as HostRewindModules["RewindMenu"],
      useRewindAgentMutation: mutation as HostRewindModules["useRewindAgentMutation"],
      useSessionStore: store as HostRewindModules["useSessionStore"],
    };
  } catch {
    return null;
  }
}

async function loadHostModules(): Promise<HostRewindModules | null> {
  const metroRequire = (globalThis as { __r?: unknown }).__r;
  if (typeof metroRequire !== "function" || typeof document === "undefined") return null;
  const script = document.querySelector<HTMLScriptElement>('script[src*="/_expo/static/js/web/index-"]');
  if (!script) return null;
  const response = await fetch(script.src);
  if (!response.ok) return null;
  const ids = findModuleIds(await response.text());
  return ids ? readHostModules(metroRequire as (id: number) => unknown, ids) : null;
}

// Loaded once, on the first prompt bubble that asks for it.
let modules: HostRewindModules | null = null;
let started = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) {
    started = true;
    void loadHostModules()
      .catch(() => null)
      .then((loaded) => {
        modules = loaded;
        for (const notify of listeners) notify();
      });
  }
  return () => listeners.delete(listener);
}

const getModules = () => modules;

export function ResolvedRewindMenu({ modules: host, hostId, agentId, messageId, text }: HostRewindMenuProps & { modules: HostRewindModules }) {
  const client = host.useSessionStore((state) => state.sessions[hostId]?.client ?? null);
  const capabilities = host.useSessionStore((state) => state.sessions[hostId]?.agents?.get(agentId)?.capabilities ?? null);
  const input = useMemo(() => ({ serverId: hostId, agentId, client, messageId }), [hostId, agentId, client, messageId]);
  const mutation = host.useRewindAgentMutation(input);
  // The host draws the menu only for a message with an id on an agent that reports capabilities.
  if (!capabilities || !messageId) return null;
  return (
    <host.RewindMenu
      capabilities={capabilities}
      rewoundText={text}
      isPending={mutation.isPending}
      onRewind={mutation.rewindAgent}
    />
  );
}

export function BundledRewindMenu(props: HostRewindMenuProps) {
  const host = useSyncExternalStore(subscribe, getModules, getModules);
  return host ? <ResolvedRewindMenu {...props} modules={host} /> : null;
}
