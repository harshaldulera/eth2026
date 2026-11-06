"use client";

import { useSyncExternalStore } from "react";
import { hasOperatorKeys, operatorKeyFor, OPERATOR_KEYS_EVENT } from "./operator-keys";

function subscribe(cb: () => void) {
  window.addEventListener(OPERATOR_KEYS_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(OPERATOR_KEYS_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** Does this browser hold any unit operator key? False on the server and until hydrated. */
export function useHasOperatorKeys(): boolean {
  return useSyncExternalStore(subscribe, hasOperatorKeys, () => false);
}

/** Does this browser hold `agentId`'s operator key (is it this red teamer's own unit)? */
export function useHoldsOperatorKey(agentId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => Boolean(operatorKeyFor(agentId)),
    () => false,
  );
}
