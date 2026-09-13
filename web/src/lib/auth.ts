import { useSyncExternalStore } from "react";

/**
 * The bearer token for `/api`, and whether the server has asked for one. The API client flips
 * `needsAuth` on any 401; the token gate watches it and swaps in the token form.
 */
const KEY = "ragdown.token";

let needsAuth = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // Storage denied: the token is lost on reload, and the gate asks again.
  }
  needsAuth = false;
  emit();
}

export function clearToken() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored, then.
  }
}

/** Called by the API client whenever a request comes back 401. */
export function requireAuth() {
  if (needsAuth) return;
  needsAuth = true;
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useNeedsAuth = () => useSyncExternalStore(subscribe, () => needsAuth);
