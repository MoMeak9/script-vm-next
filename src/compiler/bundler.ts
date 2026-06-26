/**
 * Module bundler for script-vm-next
 *
 * Resolves relative-path imports, inlines all dependent modules into a single
 * source string, and converts import/export syntax into plain ES5 that the VM
 * can execute.
 *
 * External (bare) imports are converted to require() calls.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as parser from '@babel/parser'
import traverse from '@babel/traverse'
import * as types from '@babel/types'
import generator from '@babel/generator'

export interface BundleOptions {
  /** Extra module names to treat as external (not inlined) */
  external?: string[]
  /** Base path for resolving relative imports. Defaults to entry file's directory */
  basePath?: string
  /** Source type hint: 'module' for ESM, 'script' for CJS. Auto-detected if omitted. */
  sourceType?: 'module' | 'script'
}

interface ModuleInfo {
  id: string // normalised relative path used as key
  absPath: string
  source: string
  deps: string[] // ids of modules this module imports
}

// ────────────────────────────────────────────────
// Module resolution
// ────────────────────────────────────────────────

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

const EXTENSIONS = ['.js', '.ts', '.mjs', '.cjs', '']

function resolveModulePath(specifier: string, fromDir: string): string | null {
  const base = path.resolve(fromDir, specifier)

  // Try exact path first, then with extensions, then as directory/index
  for (const ext of EXTENSIONS) {
    const candidate = base + ext
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }
  // Try directory index
  for (const ext of ['.js', '.ts', '.mjs', '.cjs']) {
    const candidate = path.join(base, 'index' + ext)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

// ────────────────────────────────────────────────
// Dependency graph building
// ────────────────────────────────────────────────

function collectModules(
  entryPath: string,
  externals: Set<string>
): Map<string, ModuleInfo> {
  const modules = new Map<string, ModuleInfo>()
  const visited = new Set<string>()

  function visit(absPath: string) {
    const realPath = fs.realpathSync(absPath)
    if (visited.has(realPath)) return
    visited.add(realPath)

    const source = fs.readFileSync(realPath, 'utf-8')
    const entryDir = path.dirname(realPath)
    const id = path.relative(path.dirname(entryPath), realPath)

    const ast = parser.parse(source, {
      sourceType: 'module',
      plugins: [
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'optionalChaining',
        'nullishCoalescingOperator',
      ],
    })

    const deps: string[] = []

    traverse(ast, {
      ImportDeclaration(p) {
        const spec = p.node.source.value
        if (!isRelative(spec) || externals.has(spec)) return
        const resolved = resolveModulePath(spec, entryDir)
        if (!resolved) {
          throw new Error(`Cannot resolve module '${spec}' from '${realPath}'`)
        }
        const depId = path.relative(path.dirname(entryPath), resolved)
        deps.push(depId)
        visit(resolved)
      },
      // Handle re-exports: export { x } from './foo'
      ExportNamedDeclaration(p) {
        if (!p.node.source) return
        const spec = p.node.source.value
        if (!isRelative(spec) || externals.has(spec)) return
        const resolved = resolveModulePath(spec, entryDir)
        if (!resolved) {
          throw new Error(`Cannot resolve module '${spec}' from '${realPath}'`)
        }
        const depId = path.relative(path.dirname(entryPath), resolved)
        deps.push(depId)
        visit(resolved)
      },
      ExportAllDeclaration(p) {
        const spec = p.node.source.value
        if (!isRelative(spec) || externals.has(spec)) return
        const resolved = resolveModulePath(spec, entryDir)
        if (!resolved) {
          throw new Error(`Cannot resolve module '${spec}' from '${realPath}'`)
        }
        const depId = path.relative(path.dirname(entryPath), resolved)
        deps.push(depId)
        visit(resolved)
      },
    })

    modules.set(id, { id, absPath: realPath, source, deps })
  }

  visit(entryPath)
  return modules
}

// ────────────────────────────────────────────────
// Topological sort with cycle detection
// ────────────────────────────────────────────────

function topoSort(modules: Map<string, ModuleInfo>): string[] {
  const sorted: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>() // grey nodes for cycle detection

  function dfs(id: string) {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      throw new Error(`Circular dependency detected involving '${id}'`)
    }
    visiting.add(id)
    const mod = modules.get(id)
    if (mod) {
      for (const dep of mod.deps) {
        dfs(dep)
      }
    }
    visiting.delete(id)
    visited.add(id)
    sorted.push(id)
  }

  for (const id of modules.keys()) {
    dfs(id)
  }

  return sorted
}

// ────────────────────────────────────────────────
// Transform a single module's AST
// ────────────────────────────────────────────────

/**
 * Transform a module's source:
 *  - import { foo } from './x' → var foo = __m['x'].foo
 *  - import bar from './x'     → var bar = __m['x']['default']
 *  - import * as ns from './x' → var ns = __m['x']
 *  - import './x'              → (removed, side-effect handled by execution order)
 *  - import ext from 'lodash'  → var ext = require('lodash')
 *  - export function foo(){}   → function foo(){} __exports.foo = foo
 *  - export default expr       → __exports['default'] = expr
 *  - export const x = 1        → const x = 1; __exports.x = x
 *  - export { a, b as c }      → __exports.a = a; __exports.c = b
 *  - export { a } from './x'   → __exports.a = __m['x'].a
 */
function transformModule(
  source: string,
  moduleId: string,
  entryId: string,
  externals: Set<string>,
  entryDir: string
): { code: string; exportNames: string[] } {
  const ast = parser.parse(source, {
    sourceType: 'module',
    plugins: [
      'classProperties',
      'classPrivateProperties',
      'classPrivateMethods',
      'optionalChaining',
      'nullishCoalescingOperator',
    ],
  })

  const exportNames: string[] = []
  const moduleDir = path.dirname(path.resolve(entryDir, moduleId))

  traverse(ast, {
    ImportDeclaration(p) {
      const spec = p.node.source.value
      const specifiers = p.node.specifiers

      if (isRelative(spec) && !externals.has(spec)) {
        // Relative import — reference __m registry
        const resolved = resolveModulePath(spec, moduleDir)
        const depId = path.relative(entryDir, resolved!)
        const replacements: types.Statement[] = []

        for (const s of specifiers) {
          if (types.isImportDefaultSpecifier(s)) {
            // import bar from './x' → var bar = __m['depId']['default']
            replacements.push(
              types.variableDeclaration('var', [
                types.variableDeclarator(
                  s.local,
                  types.memberExpression(
                    types.memberExpression(
                      types.identifier('__m'),
                      types.stringLiteral(depId),
                      true
                    ),
                    types.stringLiteral('default'),
                    true
                  )
                ),
              ])
            )
          } else if (types.isImportNamespaceSpecifier(s)) {
            // import * as ns from './x' → var ns = __m['depId']
            replacements.push(
              types.variableDeclaration('var', [
                types.variableDeclarator(
                  s.local,
                  types.memberExpression(
                    types.identifier('__m'),
                    types.stringLiteral(depId),
                    true
                  )
                ),
              ])
            )
          } else if (types.isImportSpecifier(s)) {
            // import { foo } from './x' → var foo = __m['depId'].foo
            const imported = types.isIdentifier(s.imported) ? s.imported.name : s.imported.value
            replacements.push(
              types.variableDeclaration('var', [
                types.variableDeclarator(
                  s.local,
                  types.memberExpression(
                    types.memberExpression(
                      types.identifier('__m'),
                      types.stringLiteral(depId),
                      true
                    ),
                    types.identifier(imported)
                  )
                ),
              ])
            )
          }
        }

        if (replacements.length > 0) {
          p.replaceWithMultiple(replacements)
        } else {
          // Side-effect-only import
          p.remove()
        }
      } else {
        // External (bare) import → require()
        const replacements: types.Statement[] = []
        const reqCall = types.callExpression(types.identifier('require'), [
          types.stringLiteral(spec),
        ])

        if (specifiers.length === 0) {
          // import 'lodash' → require('lodash')
          replacements.push(types.expressionStatement(reqCall))
        } else if (
          specifiers.length === 1 &&
          types.isImportDefaultSpecifier(specifiers[0])
        ) {
          // import lodash from 'lodash' → var lodash = require('lodash')
          replacements.push(
            types.variableDeclaration('var', [
              types.variableDeclarator(specifiers[0].local, reqCall),
            ])
          )
        } else if (
          specifiers.length === 1 &&
          types.isImportNamespaceSpecifier(specifiers[0])
        ) {
          // import * as _ from 'lodash' → var _ = require('lodash')
          replacements.push(
            types.variableDeclaration('var', [
              types.variableDeclarator(specifiers[0].local, reqCall),
            ])
          )
        } else {
          // import { ref, computed } from 'vue' → var _vue = require('vue'); var ref = _vue.ref; ...
          const tmpId = types.identifier('_ext_' + spec.replace(/[^a-zA-Z0-9]/g, '_'))
          replacements.push(
            types.variableDeclaration('var', [types.variableDeclarator(tmpId, reqCall)])
          )
          for (const s of specifiers) {
            if (types.isImportSpecifier(s)) {
              const imported = types.isIdentifier(s.imported) ? s.imported.name : s.imported.value
              replacements.push(
                types.variableDeclaration('var', [
                  types.variableDeclarator(
                    s.local,
                    types.memberExpression(tmpId, types.identifier(imported))
                  ),
                ])
              )
            }
          }
        }

        p.replaceWithMultiple(replacements)
      }
    },

    ExportDefaultDeclaration(p) {
      const decl = p.node.declaration
      exportNames.push('default')

      if (
        types.isFunctionDeclaration(decl) ||
        types.isClassDeclaration(decl)
      ) {
        // export default function foo(){} → function foo(){} __exports['default'] = foo
        const name = decl.id ? decl.id.name : '_default'
        if (!decl.id) {
          decl.id = types.identifier('_default')
        }
        p.replaceWithMultiple([
          decl as types.Statement,
          types.expressionStatement(
            types.assignmentExpression(
              '=',
              types.memberExpression(
                types.identifier('__exports'),
                types.stringLiteral('default'),
                true
              ),
              types.identifier(name)
            )
          ),
        ])
      } else {
        // export default expr → __exports['default'] = expr
        p.replaceWith(
          types.expressionStatement(
            types.assignmentExpression(
              '=',
              types.memberExpression(
                types.identifier('__exports'),
                types.stringLiteral('default'),
                true
              ),
              decl as types.Expression
            )
          )
        )
      }
    },

    ExportNamedDeclaration(p) {
      const { declaration, specifiers, source: src } = p.node

      if (src) {
        // Re-export: export { a, b as c } from './x'
        const spec = src.value
        const replacements: types.Statement[] = []

        if (isRelative(spec) && !externals.has(spec)) {
          const resolved = resolveModulePath(spec, moduleDir)
          const depId = path.relative(entryDir, resolved!)
          for (const s of specifiers) {
            if (types.isExportSpecifier(s)) {
              const local = s.local.name
              const exported = types.isIdentifier(s.exported) ? s.exported.name : (s.exported as types.StringLiteral).value
              exportNames.push(exported)
              replacements.push(
                types.expressionStatement(
                  types.assignmentExpression(
                    '=',
                    types.memberExpression(
                      types.identifier('__exports'),
                      types.identifier(exported)
                    ),
                    types.memberExpression(
                      types.memberExpression(
                        types.identifier('__m'),
                        types.stringLiteral(depId),
                        true
                      ),
                      types.identifier(local)
                    )
                  )
                )
              )
            }
          }
        } else {
          // Re-export from external
          const tmpId = types.identifier('_ext_' + spec.replace(/[^a-zA-Z0-9]/g, '_'))
          replacements.push(
            types.variableDeclaration('var', [
              types.variableDeclarator(
                tmpId,
                types.callExpression(types.identifier('require'), [types.stringLiteral(spec)])
              ),
            ])
          )
          for (const s of specifiers) {
            if (types.isExportSpecifier(s)) {
              const local = s.local.name
              const exported = types.isIdentifier(s.exported) ? s.exported.name : (s.exported as types.StringLiteral).value
              exportNames.push(exported)
              replacements.push(
                types.expressionStatement(
                  types.assignmentExpression(
                    '=',
                    types.memberExpression(
                      types.identifier('__exports'),
                      types.identifier(exported)
                    ),
                    types.memberExpression(tmpId, types.identifier(local))
                  )
                )
              )
            }
          }
        }

        p.replaceWithMultiple(replacements)
        return
      }

      if (declaration) {
        // export function foo(){} or export const x = 1
        const replacements: types.Statement[] = [declaration]

        if (types.isVariableDeclaration(declaration)) {
          for (const d of declaration.declarations) {
            if (types.isIdentifier(d.id)) {
              exportNames.push(d.id.name)
              replacements.push(
                types.expressionStatement(
                  types.assignmentExpression(
                    '=',
                    types.memberExpression(
                      types.identifier('__exports'),
                      types.identifier(d.id.name)
                    ),
                    d.id
                  )
                )
              )
            }
          }
        } else if (
          types.isFunctionDeclaration(declaration) ||
          types.isClassDeclaration(declaration)
        ) {
          const name = declaration.id!.name
          exportNames.push(name)
          replacements.push(
            types.expressionStatement(
              types.assignmentExpression(
                '=',
                types.memberExpression(
                  types.identifier('__exports'),
                  types.identifier(name)
                ),
                types.identifier(name)
              )
            )
          )
        }

        p.replaceWithMultiple(replacements)
        return
      }

      // export { a, b as c }
      const replacements: types.Statement[] = []
      for (const s of specifiers) {
        if (types.isExportSpecifier(s)) {
          const local = s.local.name
          const exported = types.isIdentifier(s.exported) ? s.exported.name : (s.exported as types.StringLiteral).value
          exportNames.push(exported)
          replacements.push(
            types.expressionStatement(
              types.assignmentExpression(
                '=',
                types.memberExpression(
                  types.identifier('__exports'),
                  types.identifier(exported)
                ),
                types.identifier(local)
              )
            )
          )
        }
      }
      p.replaceWithMultiple(replacements)
    },

    ExportAllDeclaration(p) {
      const spec = p.node.source.value
      if (isRelative(spec) && !externals.has(spec)) {
        const resolved = resolveModulePath(spec, moduleDir)
        const depId = path.relative(entryDir, resolved!)
        // export * from './x' → Object.assign(__exports, __m['depId'])
        p.replaceWith(
          types.expressionStatement(
            types.callExpression(
              types.memberExpression(types.identifier('Object'), types.identifier('assign')),
              [
                types.identifier('__exports'),
                types.memberExpression(
                  types.identifier('__m'),
                  types.stringLiteral(depId),
                  true
                ),
              ]
            )
          )
        )
      } else {
        p.replaceWith(
          types.expressionStatement(
            types.callExpression(
              types.memberExpression(types.identifier('Object'), types.identifier('assign')),
              [
                types.identifier('__exports'),
                types.callExpression(types.identifier('require'), [
                  types.stringLiteral(spec),
                ]),
              ]
            )
          )
        )
      }
    },
  })

  return { code: generator(ast).code, exportNames }
}

// ────────────────────────────────────────────────
// CJS dependency graph building
// ────────────────────────────────────────────────

function collectCJSModules(
  entryPath: string,
  externals: Set<string>
): Map<string, ModuleInfo> {
  const modules = new Map<string, ModuleInfo>()
  const visited = new Set<string>()

  function visit(absPath: string) {
    const realPath = fs.realpathSync(absPath)
    if (visited.has(realPath)) return
    visited.add(realPath)

    const source = fs.readFileSync(realPath, 'utf-8')
    const entryDir = path.dirname(realPath)
    const id = path.relative(path.dirname(entryPath), realPath)

    const ast = parser.parse(source, {
      sourceType: 'script',
      plugins: [
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'optionalChaining',
        'nullishCoalescingOperator',
      ],
    })

    const deps: string[] = []

    traverse(ast, {
      CallExpression(p) {
        if (
          types.isIdentifier(p.node.callee, { name: 'require' }) &&
          p.node.arguments.length === 1 &&
          types.isStringLiteral(p.node.arguments[0])
        ) {
          const spec = p.node.arguments[0].value
          if (!isRelative(spec) || externals.has(spec)) return
          const resolved = resolveModulePath(spec, entryDir)
          if (!resolved) {
            throw new Error(`Cannot resolve module '${spec}' from '${realPath}'`)
          }
          const depId = path.relative(path.dirname(entryPath), resolved)
          deps.push(depId)
          visit(resolved)
        }
      },
    })

    modules.set(id, { id, absPath: realPath, source, deps })
  }

  visit(entryPath)
  return modules
}

// ────────────────────────────────────────────────
// Transform a single CJS module's AST
// ────────────────────────────────────────────────

/**
 * Transform a CJS module's source:
 *  - require('./helper')              → __m['helper']
 *  - const x = require('./helper')    → var x = __m['helper']
 *  - const { a, b } = require('./x')  → var a = __m['x'].a; var b = __m['x'].b
 *  - require('lodash')                → require('lodash') (preserved)
 *  - module.exports = expr            → __exports['default'] = expr
 *  - module.exports = { a, b }        → __exports.a = a; __exports.b = b
 *  - module.exports.xxx = expr        → __exports.xxx = expr
 *  - exports.xxx = expr               → __exports.xxx = expr
 */
function transformCJSModule(
  source: string,
  moduleId: string,
  entryId: string,
  externals: Set<string>,
  entryDir: string
): { code: string; exportNames: string[] } {
  const ast = parser.parse(source, {
    sourceType: 'script',
    plugins: [
      'classProperties',
      'classPrivateProperties',
      'classPrivateMethods',
      'optionalChaining',
      'nullishCoalescingOperator',
    ],
  })

  const exportNames: string[] = []
  const moduleDir = path.dirname(path.resolve(entryDir, moduleId))

  traverse(ast, {
    CallExpression(p) {
      // Only handle require('string')
      if (
        !types.isIdentifier(p.node.callee, { name: 'require' }) ||
        p.node.arguments.length !== 1 ||
        !types.isStringLiteral(p.node.arguments[0])
      ) {
        return
      }

      const spec = p.node.arguments[0].value

      if (!isRelative(spec) || externals.has(spec)) {
        // External require — keep as-is
        return
      }

      // Relative require → __m['depId']
      const resolved = resolveModulePath(spec, moduleDir)
      const depId = path.relative(entryDir, resolved!)
      const depAccess = types.memberExpression(
        types.identifier('__m'),
        types.stringLiteral(depId),
        true
      )

      const parentNode = p.parent

      // Check for destructuring: const { a, b } = require('./x')
      if (
        types.isVariableDeclarator(parentNode) &&
        types.isObjectPattern(parentNode.id)
      ) {
        const replacements: types.Statement[] = []
        for (const prop of parentNode.id.properties) {
          if (types.isObjectProperty(prop) && types.isIdentifier(prop.value)) {
            const key = types.isIdentifier(prop.key) ? prop.key.name : (prop.key as types.StringLiteral).value
            replacements.push(
              types.variableDeclaration('var', [
                types.variableDeclarator(
                  types.identifier(prop.value.name),
                  types.memberExpression(
                    types.memberExpression(types.identifier('__m'), types.stringLiteral(depId), true),
                    types.identifier(key)
                  )
                ),
              ])
            )
          } else if (types.isRestElement(prop) && types.isIdentifier(prop.argument)) {
            replacements.push(
              types.variableDeclaration('var', [
                types.variableDeclarator(prop.argument, depAccess),
              ])
            )
          }
        }
        // Replace the entire VariableDeclaration (parent of VariableDeclarator)
        const declPath = p.parentPath?.parentPath
        if (declPath && types.isVariableDeclaration(declPath.node)) {
          declPath.replaceWithMultiple(replacements)
        }
        return
      }

      // Simple: const x = require('./y') or bare require('./y')
      p.replaceWith(depAccess)
    },

    AssignmentExpression(p) {
      const left = p.node.left

      // module.exports = expr
      if (
        types.isMemberExpression(left) &&
        !left.computed &&
        types.isIdentifier(left.object, { name: 'module' }) &&
        types.isIdentifier(left.property, { name: 'exports' })
      ) {
        const right = p.node.right

        // module.exports = { a, b, c } — expand object literal
        if (types.isObjectExpression(right)) {
          const replacements: types.Statement[] = []
          for (const prop of right.properties) {
            if (types.isObjectProperty(prop)) {
              const key = types.isIdentifier(prop.key)
                ? prop.key.name
                : types.isStringLiteral(prop.key)
                  ? prop.key.value
                  : null
              if (key) {
                exportNames.push(key)
                replacements.push(
                  types.expressionStatement(
                    types.assignmentExpression(
                      '=',
                      types.memberExpression(types.identifier('__exports'), types.identifier(key)),
                      prop.value as types.Expression
                    )
                  )
                )
              }
            }
          }
          if (replacements.length > 0) {
            // If this is an ExpressionStatement, replace it
            if (p.parentPath && types.isExpressionStatement(p.parentPath.node)) {
              p.parentPath.replaceWithMultiple(replacements)
            } else {
              // Fallback: replace the assignment itself with a sequence
              const assigns = replacements.map((r) => (r as types.ExpressionStatement).expression)
              p.replaceWith(types.sequenceExpression(assigns))
            }
            return
          }
        }

        // module.exports = expr (non-object-literal)
        exportNames.push('default')
        p.node.left = types.memberExpression(
          types.identifier('__exports'),
          types.stringLiteral('default'),
          true
        )
        return
      }

      // module.exports.xxx = expr
      if (
        types.isMemberExpression(left) &&
        types.isMemberExpression(left.object) &&
        !left.object.computed &&
        types.isIdentifier(left.object.object, { name: 'module' }) &&
        types.isIdentifier(left.object.property, { name: 'exports' })
      ) {
        const propName = left.computed
          ? null
          : types.isIdentifier(left.property)
            ? left.property.name
            : types.isStringLiteral(left.property)
              ? left.property.value
              : null
        if (propName) exportNames.push(propName)
        // Replace module.exports.xxx with __exports.xxx
        p.node.left = types.memberExpression(
          types.identifier('__exports'),
          left.property,
          left.computed
        )
        return
      }

      // exports.xxx = expr
      if (
        types.isMemberExpression(left) &&
        types.isIdentifier(left.object, { name: 'exports' })
      ) {
        const propName = left.computed
          ? null
          : types.isIdentifier(left.property)
            ? left.property.name
            : types.isStringLiteral(left.property)
              ? left.property.value
              : null
        if (propName) exportNames.push(propName)
        // Replace exports.xxx with __exports.xxx
        p.node.left = types.memberExpression(
          types.identifier('__exports'),
          left.property,
          left.computed
        )
      }
    },
  })

  // Deduplicate export names
  const uniqueExports = [...new Set(exportNames)]

  return { code: generator(ast).code, exportNames: uniqueExports }
}

// ────────────────────────────────────────────────
// Main bundle function
// ────────────────────────────────────────────────

export interface BundleResult {
  /** The bundled source code (single string, no import/export) */
  code: string
  /** Export names from the entry module (for ESM output wrapping) */
  entryExports: string[]
}

/**
 * Bundle modules starting from entryPath into a single source string.
 * Returns the merged code with all import/export statements resolved.
 */
export function bundle(entryPath: string, options: BundleOptions = {}): BundleResult {
  const absEntry = fs.realpathSync(path.resolve(entryPath))
  const entryDir = options.basePath ? path.resolve(options.basePath) : path.dirname(absEntry)
  const externals = new Set(options.external || [])
  const isCJS = options.sourceType === 'script'

  // Build dependency graph (ESM or CJS)
  const modules = isCJS
    ? collectCJSModules(absEntry, externals)
    : collectModules(absEntry, externals)

  // Topological sort
  const sortedIds = topoSort(modules)
  const entryId = path.relative(entryDir, absEntry)

  // Choose transform function
  const transform = isCJS ? transformCJSModule : transformModule

  // If only one module (no imports), just transform in-place
  if (sortedIds.length === 1) {
    const mod = modules.get(sortedIds[0])!
    const { code, exportNames } = transform(mod.source, mod.id, entryId, externals, entryDir)
    // Wrap with __exports for consistency
    const wrapped = `var __exports = {};\n${code}\n`
    return { code: wrapped, entryExports: exportNames }
  }

  // Build the bundled code
  const parts: string[] = []
  parts.push('var __m = {};')

  let entryExports: string[] = []

  for (const id of sortedIds) {
    const mod = modules.get(id)!
    const isEntry = id === entryId
    const { code, exportNames } = transform(mod.source, id, entryId, externals, entryDir)

    if (isEntry) {
      entryExports = exportNames
      // Entry module: inject __exports var, then inline code
      parts.push(`var __exports = {};`)
      parts.push(code)
    } else {
      // Dependency module: wrap in IIFE, store in __m registry
      parts.push(
        `__m[${JSON.stringify(id)}] = (function() {\n` +
        `  var __exports = {};\n` +
        `  ${code}\n` +
        `  return __exports;\n` +
        `})();`
      )
    }
  }

  return { code: parts.join('\n'), entryExports }
}

/**
 * Check if source code contains import/export syntax.
 */
export function hasModuleSyntax(source: string): boolean {
  try {
    const ast = parser.parse(source, {
      sourceType: 'module',
      plugins: ['optionalChaining', 'nullishCoalescingOperator'],
    })
    let found = false
    traverse(ast, {
      ImportDeclaration() { found = true },
      ExportDefaultDeclaration() { found = true },
      ExportNamedDeclaration() { found = true },
      ExportAllDeclaration() { found = true },
      noScope: true,
    })
    return found
  } catch {
    return false
  }
}

/**
 * Check if source code contains CommonJS syntax (require / module.exports / exports.xxx).
 */
export function hasCJSSyntax(source: string): boolean {
  try {
    const ast = parser.parse(source, {
      sourceType: 'script',
      plugins: ['optionalChaining', 'nullishCoalescingOperator'],
    })
    let found = false
    traverse(ast, {
      CallExpression(p) {
        // require('xxx') — static string argument, callee is bare `require` identifier
        if (
          types.isIdentifier(p.node.callee, { name: 'require' }) &&
          p.node.arguments.length === 1 &&
          types.isStringLiteral(p.node.arguments[0])
        ) {
          found = true
        }
      },
      AssignmentExpression(p) {
        const left = p.node.left
        // module.exports = xxx
        if (
          types.isMemberExpression(left) &&
          types.isIdentifier(left.object, { name: 'module' }) &&
          types.isIdentifier(left.property, { name: 'exports' })
        ) {
          found = true
          return
        }
        // module.exports.xxx = xxx
        if (
          types.isMemberExpression(left) &&
          types.isMemberExpression(left.object) &&
          types.isIdentifier(left.object.object, { name: 'module' }) &&
          types.isIdentifier(left.object.property, { name: 'exports' })
        ) {
          found = true
          return
        }
        // exports.xxx = xxx
        if (
          types.isMemberExpression(left) &&
          types.isIdentifier(left.object, { name: 'exports' })
        ) {
          found = true
        }
      },
      noScope: true,
    })
    return found
  } catch {
    return false
  }
}

/**
 * Walk up the directory tree from `startDir` to find the nearest package.json
 * and return its "type" field value.
 */
export function findPackageJsonType(startDir: string): 'module' | 'commonjs' | null {
  let dir = path.resolve(startDir)
  const root = path.parse(dir).root
  while (true) {
    const candidate = path.join(dir, 'package.json')
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'))
        if (pkg.type === 'module') return 'module'
        if (pkg.type === 'commonjs') return 'commonjs'
        return null // package.json exists but no "type" field
      } catch {
        return null
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir || dir === root) break
    dir = parent
  }
  return null
}

export type ModuleFormat = 'esm' | 'cjs' | 'iife'

/**
 * Detect the module format of a source file.
 *
 * Priority:
 *   1. File extension: .mjs → esm, .cjs → cjs
 *   2. Nearest package.json "type" field
 *   3. Source content analysis (hasModuleSyntax / hasCJSSyntax)
 *   4. Default to iife (plain script)
 */
export function detectModuleFormat(filePath: string, sourceCode: string): ModuleFormat {
  const ext = path.extname(filePath).toLowerCase()

  // 1. Extension-based detection
  if (ext === '.mjs') return 'esm'
  if (ext === '.cjs') return 'cjs'

  // 2. package.json "type" field (for .js and other extensions)
  const pkgType = findPackageJsonType(path.dirname(filePath))
  if (pkgType === 'module') return 'esm'
  if (pkgType === 'commonjs') return 'cjs'

  // 3. Content analysis
  if (hasModuleSyntax(sourceCode)) return 'esm'
  if (hasCJSSyntax(sourceCode)) return 'cjs'

  // 4. Default
  return 'iife'
}
