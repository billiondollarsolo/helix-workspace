import { Store } from "@tanstack/store";
import { useSyncExternalStore } from "react";

interface ShellUiState {
  readonly rightRailOpenByRoute: Readonly<Record<string, boolean>>;
}

const initialShellUiState: ShellUiState = {
  rightRailOpenByRoute: {},
};

export const shellUiStore = new Store<ShellUiState>(initialShellUiState);

export function useShellUiStore<T>(selector: (state: ShellUiState) => T): T {
  return useSyncExternalStore(
    (onStoreChange) => {
      const subscription = shellUiStore.subscribe(onStoreChange);
      return () => subscription.unsubscribe();
    },
    () => selector(shellUiStore.state),
    () => selector(shellUiStore.state),
  );
}

export function setRightRailOpen(route: string, rightRailOpen: boolean) {
  shellUiStore.setState((state) => ({
    ...state,
    rightRailOpenByRoute: {
      ...state.rightRailOpenByRoute,
      [route]: rightRailOpen,
    },
  }));
}

export function toggleRightRailOpen(route: string) {
  setRightRailOpen(route, shellUiStore.state.rightRailOpenByRoute[route] !== true);
}

export function resetShellUiStoreForTest() {
  shellUiStore.setState(() => ({
    rightRailOpenByRoute: {},
  }));
}
