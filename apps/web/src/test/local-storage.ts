/**
 * happy-dom ships a non-functional `Storage` stub in this project, so code that
 * reads `window.localStorage` (e.g. the widget anonymous-token persistence layer)
 * can't be exercised against it directly. Install a minimal in-memory
 * localStorage on `window` instead.
 *
 * Call once at a test module's top level, then reset between tests with
 * `window.localStorage.clear()` in `beforeEach`. No-ops under a non-DOM
 * (node) environment.
 */
export function installInMemoryLocalStorage(): void {
  if (typeof window === 'undefined') return
  const store = new Map<string, string>()
  const mock: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => {
      store.delete(k)
    },
    setItem: (k, v) => {
      store.set(k, String(v))
    },
  }
  Object.defineProperty(window, 'localStorage', {
    value: mock,
    configurable: true,
    writable: true,
  })
}
