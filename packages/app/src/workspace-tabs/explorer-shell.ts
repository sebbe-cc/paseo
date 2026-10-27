import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  closedExplorerViewKeys,
  explorerShellsEqual,
  readExplorerShellFromLayout,
  type ExplorerShell,
} from "@/workspace-tabs/explorer-shell-layout";

const ExplorerViewSchema = z.union([
  z.strictObject({ kind: z.enum(["files", "changes_tree", "working_diff"]) }),
  z.strictObject({
    kind: z.literal("plugin"),
    pluginId: z.string().min(1),
    panelId: z.string().min(1),
  }),
]);

const ExplorerShellPersistedStateSchema = z.strictObject({
  shell: z
    .strictObject({
      open: z.boolean(),
      views: z.array(ExplorerViewSchema),
      activeView: z.string().nullable(),
      width: z.number().positive().nullable(),
    })
    .nullable(),
});

interface ExplorerShellStore {
  /** Null until a workspace is first recorded, so upgrading keeps the Explorer it had. */
  shell: ExplorerShell | null;
  setShell: (shell: ExplorerShell) => void;
}

export function createExplorerShellStore() {
  return create<ExplorerShellStore>()(
    persist(
      (set) => ({
        shell: null,
        setShell: (shell) => set({ shell }),
      }),
      {
        name: "paseo-explorer-shell",
        version: 1,
        storage: createValidatedPersistStorage(AsyncStorage, ExplorerShellPersistedStateSchema),
        partialize: (state) => ({ shell: state.shell }),
      },
    ),
  );
}

export const useExplorerShellStore = createExplorerShellStore();

type LayoutStore = typeof useWorkspaceLayoutStore;
type LayoutState = ReturnType<LayoutStore["getState"]>;
type ShellStore = typeof useExplorerShellStore;

/** Applies the shell to the workspace being focused and records that workspace's changes back. */
export function createExplorerShellSync(layoutStore: LayoutStore, shellStore: ShellStore) {
  let focusedKey: string | null = null;
  let applying = false;

  const record = (workspaceKey: string, state: LayoutState, before: LayoutState | null) => {
    const layout = state.layoutByWorkspace[workspaceKey];
    const explorerPaneId = layout ? selectExplorerSidebarPaneId(state, workspaceKey) : null;
    if (!layout || !explorerPaneId) return;
    const previous = shellStore.getState().shell;
    const next = readExplorerShellFromLayout({
      layout,
      explorerPaneId,
      width: state.explorerSidebarWidthByWorkspace[workspaceKey],
      previous,
      closedViewKeys: closedExplorerViewKeys(before?.layoutByWorkspace[workspaceKey], layout),
    });
    if (next && !explorerShellsEqual(previous, next)) shellStore.getState().setShell(next);
  };

  const apply = () => {
    if (!focusedKey || !shellStore.persist.hasHydrated()) return;
    const shell = shellStore.getState().shell;
    if (!shell) {
      record(focusedKey, layoutStore.getState(), null);
      return;
    }
    applying = true;
    try {
      layoutStore.getState().applyExplorerShell(focusedKey, shell);
    } finally {
      applying = false;
    }
  };

  const unsubscribeLayout = layoutStore.subscribe((state, before) => {
    if (applying || !focusedKey || !shellStore.persist.hasHydrated()) return;
    if (
      state.layoutByWorkspace[focusedKey] !== before.layoutByWorkspace[focusedKey] ||
      state.explorerSidebarWidthByWorkspace[focusedKey] !==
        before.explorerSidebarWidthByWorkspace[focusedKey]
    ) {
      record(focusedKey, state, before);
    }
  });
  const unsubscribeHydration = shellStore.persist.onFinishHydration(apply);

  return {
    /** Returns the matching deactivation, which is a no-op once another workspace took over. */
    activate: (workspaceKey: string) => {
      focusedKey = workspaceKey;
      apply();
      return () => {
        if (focusedKey === workspaceKey) focusedKey = null;
      };
    },
    dispose: () => {
      unsubscribeLayout();
      unsubscribeHydration();
    },
  };
}

let defaultSync: ReturnType<typeof createExplorerShellSync> | null = null;

export function activateExplorerShell(workspaceKey: string): () => void {
  defaultSync ??= createExplorerShellSync(useWorkspaceLayoutStore, useExplorerShellStore);
  return defaultSync.activate(workspaceKey);
}
