import type { PersistStorage, StorageValue } from "zustand/middleware";

/**
 * In-memory cache for tree state to avoid expensive JSON serialization
 * on every single state mutation. The cache is the source of truth for reads,
 * and writes to sessionStorage are debounced.
 */
const memoryCache = new Map<string, StorageValue<unknown>>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

const DEBOUNCE_MS = 2000; // Only persist to sessionStorage every 2 seconds

/**
 * Inject a tree state directly into the in-memory cache.
 * Called from createTab() to bypass the JSON.stringify → sessionStorage → JSON.parse round-trip.
 */
export function injectTreeState<S>(name: string, state: S, version = 0): void {
  memoryCache.set(name, { state, version });
}

/**
 * Create a debounced storage adapter for zustand's persist middleware.
 *
 * - getItem: returns from in-memory cache (instant), falls back to sessionStorage
 * - setItem: updates in-memory cache immediately, debounces sessionStorage write
 * - removeItem: clears both immediately
 *
 * This eliminates:
 * 1. The initial JSON.stringify when creating a tab (use injectTreeState instead)
 * 2. The JSON.parse on store hydration (reads from memory cache)
 * 3. JSON.stringify on every single mutation (debounced to every 2s)
 */
export function createDebouncedStorage<S>(): PersistStorage<S> {
  return {
    getItem(name: string): StorageValue<S> | null {
      // Check in-memory cache first
      const cached = memoryCache.get(name);
      if (cached) {
        return cached as StorageValue<S>;
      }

      // Fall back to sessionStorage (only on cold start / page reload)
      try {
        const str = sessionStorage.getItem(name);
        if (str) {
          const parsed = JSON.parse(str) as StorageValue<S>;
          // Populate cache for future reads
          memoryCache.set(name, parsed as StorageValue<unknown>);
          return parsed;
        }
      } catch {
        // Corrupted or too-large data
      }
      return null;
    },

    setItem(name: string, value: StorageValue<S>): void {
      // Always update in-memory cache immediately
      memoryCache.set(name, value as StorageValue<unknown>);

      // Debounce the expensive sessionStorage write
      const existing = debounceTimers.get(name);
      if (existing) {
        clearTimeout(existing);
      }
      debounceTimers.set(
        name,
        setTimeout(() => {
          debounceTimers.delete(name);
          try {
            sessionStorage.setItem(name, JSON.stringify(value));
          } catch {
            // sessionStorage might be full — the in-memory cache still works
            console.warn(
              `[treeStorage] Failed to persist "${name}" to sessionStorage (may be too large)`,
            );
          }
        }, DEBOUNCE_MS),
      );
    },

    removeItem(name: string): void {
      memoryCache.delete(name);
      const timer = debounceTimers.get(name);
      if (timer) {
        clearTimeout(timer);
        debounceTimers.delete(name);
      }
      try {
        sessionStorage.removeItem(name);
      } catch {
        // ignore
      }
    },
  };
}
