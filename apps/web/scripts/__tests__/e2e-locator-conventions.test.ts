import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Playwright's `filter({ has })` / `filter({ hasNot })` re-applies the INNER
 * locator's entire selector chain relative to each candidate element -- it does
 * not reuse the inner locator's own root. So an inner locator built from
 * anything other than `page` silently asks for a nested copy of that root:
 *
 *   const dialog = page.getByRole('dialog', { name: 'API Key Created' })
 *   dialog.locator('div').filter({ has: dialog.getByRole('button', ...) })
 *
 * compiles to `role=dialog >> role=button` applied INSIDE each candidate div,
 * so it needs a dialog nested in the div. It matches zero elements, always.
 *
 * That is a false-green hazard rather than a loud bug: the chain then reports
 * "element(s) not found", which is indistinguishable from the product genuinely
 * missing the element -- so it reads as a real regression and any assertion
 * downstream of it is unreachable. Two such helpers shipped here and cost four
 * red E2E tests before the cause was found.
 *
 * Rule: the inner locator of `has:`/`hasNot:` must be rooted at `page`. Scoping
 * is not lost -- the OUTER locator already constrains which elements are
 * considered as candidates.
 */

const E2E_ROOT = path.resolve(__dirname, '../../e2e')

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * Walk a member/call chain down to what it is rooted at.
 *
 * `locator.page()` is a legitimate page root -- it hands back the Page object,
 * so `modal.page().getByPlaceholder(...)` compiles to a bare selector exactly
 * like `page.getByPlaceholder(...)`. Treat reaching a `.page()` call as
 * reaching `page`, and keep walking otherwise.
 */
function chainRoot(node: ts.Expression): ts.Node | 'page' {
  let current: ts.Node = node
  for (;;) {
    if (ts.isCallExpression(current)) {
      if (
        ts.isPropertyAccessExpression(current.expression) &&
        current.expression.name.text === 'page' &&
        current.arguments.length === 0
      )
        return 'page'
      current = current.expression
    } else if (ts.isPropertyAccessExpression(current)) current = current.expression
    else if (ts.isElementAccessExpression(current)) current = current.expression
    else if (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current))
      current = current.expression
    else return current
  }
}

/** True when a resolved chain root is the Playwright Page. */
function isPageRoot(root: ts.Node | 'page'): boolean {
  return root === 'page' || (ts.isIdentifier(root) && root.text === 'page')
}

interface Violation {
  file: string
  line: number
  property: string
  root: string
}

function findViolations(file: string): Violation[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const violations: Violation[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'filter' &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const prop of node.arguments[0].properties) {
        if (
          !ts.isPropertyAssignment(prop) ||
          !ts.isIdentifier(prop.name) ||
          (prop.name.text !== 'has' && prop.name.text !== 'hasNot')
        )
          continue

        const root = chainRoot(prop.initializer)
        // A bare identifier initializer (`has: copyButton`) hides its own root,
        // so resolve one level: find `const copyButton = <expr>` in this file.
        let resolved = root
        if (ts.isIdentifier(prop.initializer)) {
          const name = prop.initializer.text
          let decl: ts.Expression | undefined
          const findDecl = (n: ts.Node): void => {
            if (
              ts.isVariableDeclaration(n) &&
              ts.isIdentifier(n.name) &&
              n.name.text === name &&
              n.initializer
            )
              decl = n.initializer
            ts.forEachChild(n, findDecl)
          }
          findDecl(source)
          if (decl) resolved = chainRoot(decl)
        }

        if (!isPageRoot(resolved)) {
          violations.push({
            file: path.relative(E2E_ROOT, file),
            line: source.getLineAndCharacterOfPosition(prop.getStart(source)).line + 1,
            property: prop.name.text,
            root: (resolved as ts.Node).getText(source),
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return violations
}

describe('Playwright filter({ has }) locator conventions', () => {
  const files = collectTsFiles(E2E_ROOT)

  it('scans a non-trivial number of e2e source files', () => {
    // Guards the guard: an empty or mis-resolved glob would make every
    // assertion below vacuously true.
    expect(files.length).toBeGreaterThan(10)
  })

  it('detects an inner locator that is not rooted at `page`', () => {
    // Non-vacuity: prove the detector actually fires on the broken shape.
    const fixture = path.join(E2E_ROOT, '__conventions_fixture__.ts')
    const broken = `
      const dialog = page.getByRole('dialog')
      dialog.locator('div').filter({ has: dialog.getByRole('button') })
    `
    const source = ts.createSourceFile(fixture, broken, ts.ScriptTarget.Latest, true)
    let found = 0
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'filter' &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        for (const prop of node.arguments[0].properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            if (!isPageRoot(chainRoot(prop.initializer))) found++
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(found).toBe(1)
  })

  it('roots every filter({ has }) inner locator at `page`', () => {
    const violations = files.flatMap(findViolations)
    expect(
      violations.map(
        (v) => `${v.file}:${v.line} — ${v.property}: rooted at \`${v.root}\`, not \`page\``
      )
    ).toEqual([])
  })
})
