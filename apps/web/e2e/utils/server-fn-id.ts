import { createHash } from 'node:crypto'

/**
 * Server-function ids as @tanstack/start-plugin-core 1.171.47 assigns them
 * (dist/esm/start-compiler/compiler.js, generateFunctionId):
 * - dev (Vite): base64url JSON `{ file, export }`, where `file` is the module
 *   specifier the dev server serves;
 * - build (the compiled image CI runs): SHA-256 hex of
 *   `${file relative to apps/web}--${export}`.
 *
 * Specs that pick a server function out of /_serverFn/ traffic must accept
 * both, because CI serves the compiled image (E2E_SERVER_MODE=image) and local
 * runs keep the Vite dev server.
 */
export function builtServerFnId(relativeFile: string, exportName: string): string {
  return createHash('sha256').update(`${relativeFile}--${exportName}`).digest('hex')
}

/** The exported handler name the compiler gives `export const name = createServerFn(...)`. */
export function serverFnExport(variableName: string): string {
  return `${variableName}_createServerFn_handler`
}

/** True when the suite is talking to the compiled image rather than Vite. */
export function servesCompiledImage(): boolean {
  return process.env.E2E_SERVER_MODE === 'image'
}

/** Whether a /_serverFn/ id names `exportName` of `relativeFile` in either mode. */
export function isServerFnId(id: string, relativeFile: string, exportName: string): boolean {
  if (id === builtServerFnId(relativeFile, exportName)) return true
  try {
    const decoded = JSON.parse(
      Buffer.from(decodeURIComponent(id), 'base64url').toString('utf8')
    ) as {
      file?: unknown
      export?: unknown
    }
    return (
      decoded.export === exportName &&
      typeof decoded.file === 'string' &&
      decoded.file.includes(relativeFile)
    )
  } catch {
    return false
  }
}
