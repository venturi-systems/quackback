import { createContext, useContext, type ReactNode } from 'react'

/**
 * True inside a layout that already draws page chrome (the portal layout, the
 * admin layout, or PublicPageFrame). Error and not-found pages use it to add
 * the public header and footer only when nothing else does, so a nested route
 * error never shows a second header inside the portal or the admin.
 */
const InShellContext = createContext(false)

export function InShell({ children }: { children: ReactNode }) {
  return <InShellContext.Provider value={true}>{children}</InShellContext.Provider>
}

export function useInShell(): boolean {
  return useContext(InShellContext)
}
