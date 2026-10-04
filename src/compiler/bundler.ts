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

interface ExportBinding {
  local: string
  source?: string
  namespace?: boolean
  identity: string
}

type ModuleExports = Map<string, ExportBinding>

function exportName(node: types.Identifier | types.StringLiteral): string {
  return types.isIdentifier(node) ? node.name : node.value
}

function parseModule(source: string): types.File {
  return parser.parse(source, { sourceType: 'module' })
}

function dependencyId(specifier: string, moduleId: string, entryDir: string): string {
  const resolved = resolveModulePath(specifier, path.dirname(path.resolve(entryDir, moduleId)))
  if (!resolved) throw new Error(`Cannot resolve module '${specifier}' from '${moduleId}'`)
  return path.relative(entryDir, fs.realpathSync(resolved))
}

/** Resolve the public names before rewriting, including ambiguous star exports. */
function collectModuleExports(
  modules: Map<string, ModuleInfo>,
  sortedIds: string[],
  externals: Set<string>,
  entryDir: string
): Map<string, ModuleExports> {
  const all = new Map<string, ModuleExports>()
  for (const id of sortedIds) {
    const ast = parseModule(modules.get(id)!.source)
    const explicit: ModuleExports = new Map()
    const imported = new Map<string, ExportBinding>()
    const stars: string[] = []
    const from = (source: string, local: string, namespace = false): ExportBinding => {
      const internal = isRelative(source) && !externals.has(source)
      const depId = internal ? dependencyId(source, id, entryDir) : source
      const original = internal && !namespace ? all.get(depId)?.get(local) : undefined
      if (internal && !namespace && !original) {
        throw new Error(`Module '${source}' has no unambiguous export named '${local}' (imported by '${id}')`)
      }
      return { source, local, namespace, identity: original?.identity ?? `${depId}:${namespace ? '*' : local}` }
    }
    for (const node of ast.program.body) {
      if (!types.isImportDeclaration(node)) continue
      for (const spec of node.specifiers) {
        const namespace = types.isImportNamespaceSpecifier(spec)
        const name = types.isImportSpecifier(spec) ? exportName(spec.imported) : 'default'
        imported.set(spec.local.name, from(node.source.value, name, namespace))
      }
    }
    for (const node of ast.program.body) {
      if (types.isExportAllDeclaration(node)) {
        stars.push(node.source.value)
      } else if (types.isExportDefaultDeclaration(node)) {
        const decl = node.declaration
        const local = (types.isFunctionDeclaration(decl) || types.isClassDeclaration(decl)) && decl.id
          ? decl.id.name : '*default*'
        explicit.set('default', { local, identity: `${id}:${local}` })
      } else if (types.isExportNamedDeclaration(node)) {
        if (node.declaration) {
          for (const name of Object.keys(types.getOuterBindingIdentifiers(node.declaration))) {
            explicit.set(name, { local: name, identity: `${id}:${name}` })
          }
        }
        for (const spec of node.specifiers) {
          const name = exportName(spec.exported)
          if (types.isExportNamespaceSpecifier(spec)) {
            explicit.set(name, from(node.source!.value, '*', true))
          } else if (types.isExportSpecifier(spec)) {
            const local = exportName(spec.local)
            explicit.set(name, node.source ? from(node.source.value, local)
              : imported.get(local) ?? { local, identity: `${id}:${local}` })
          }
        }
      }
    }
    const merged: ModuleExports = new Map(explicit)
    const ambiguous = new Set<string>()
    for (const source of stars) {
      if (!isRelative(source) || externals.has(source)) {
        throw new Error(`Star re-exports from external module '${source}' are unsupported; list the exported names explicitly`)
      }
      const exports = all.get(dependencyId(source, id, entryDir))!
      for (const [name, binding] of exports) {
        if (name === 'default' || explicit.has(name) || ambiguous.has(name)) continue
        const previous = merged.get(name)
        if (previous && previous.identity !== binding.identity) {
          merged.delete(name)
          ambiguous.add(name)
        } else {
          merged.set(name, { local: name, source, identity: binding.identity })
        }
      }
    }
    all.set(id, merged)
  }
  return all
}

/**
 * Keep local bindings in place and expose them through getters. Import reads are
 * rewritten at their binding's reference paths, so shadowed names remain local.
 * A write notification updates the native ESM wrapper after an exported binding
 * changes, including changes made by an asynchronous or escaped closure.
 */
function transformModule(
  source: string,
  moduleId: string,
  entryId: string,
  externals: Set<string>,
  entryDir: string,
  exports: ModuleExports,
  notifyIdentifier: string,
  registryIdentifier: string,
  exportsIdentifier: string
): { code: string; exportNames: string[] } {
  const ast = parseModule(source)
  let program: import('@babel/traverse').NodePath<types.Program>
  traverse(ast, { Program(p) { program = p; p.stop() } })

  const prelude: types.Statement[] = []
  const externalNamespaces = new Map<string, types.Identifier>()
  const namespaceFor = (specifier: string): types.Expression => {
    if (isRelative(specifier) && !externals.has(specifier)) {
      return types.memberExpression(types.identifier(registryIdentifier), types.stringLiteral(dependencyId(specifier, moduleId, entryDir)), true)
    }
    let temp = externalNamespaces.get(specifier)
    if (!temp) {
      temp = program!.scope.generateUidIdentifier('external')
      externalNamespaces.set(specifier, temp)
      prelude.push(types.variableDeclaration('var', [types.variableDeclarator(temp,
        types.callExpression(types.identifier('require'), [types.stringLiteral(specifier)]))]))
    }
    return types.cloneNode(temp)
  }
  const property = (object: types.Expression, name: string) =>
    types.memberExpression(object, types.stringLiteral(name), true)

  // Instrument local writes before removing the import/export declarations.
  const publishedBindings = new Set([...exports.values()]
    .filter(binding => !binding.source && binding.local !== '*default*')
    .map(binding => program!.scope.getBinding(binding.local)))
  const notify = (expression: types.Expression): types.CallExpression =>
    types.callExpression(types.identifier(notifyIdentifier), [expression])
  const changesExport = (node: types.Node, scope: import('@babel/traverse').Scope): boolean =>
    Object.keys(types.getBindingIdentifiers(node)).some(name => {
      const binding = scope.getBinding(name)
      return binding !== undefined && publishedBindings.has(binding)
    })
  traverse(ast, {
    AssignmentExpression: {
      exit(p) {
        if (changesExport(p.node.left, p.scope)) {
          if (types.isPattern(p.node.left)) {
            throw new Error(`Destructuring assignment to an exported binding is unsupported in '${moduleId}'; use separate assignments`)
          }
          p.replaceWith(notify(p.node)); p.skip()
        }
      },
    },
    UpdateExpression: {
      exit(p) {
        if (changesExport(p.node.argument, p.scope)) { p.replaceWith(notify(p.node)); p.skip() }
      },
    },
    'ForInStatement|ForOfStatement'(p) {
      const node = p.node as types.ForInStatement | types.ForOfStatement
      if (changesExport(node.left, p.scope)) {
        const target = types.isVariableDeclaration(node.left) ? node.left.declarations[0].id : node.left
        if (types.isPattern(target)) {
          throw new Error(`Destructuring loop assignment to an exported binding is unsupported in '${moduleId}'; use separate assignments`)
        }
        const body = types.isBlockStatement(node.body) ? node.body : types.blockStatement([node.body])
        body.body.unshift(types.expressionStatement(notify(types.unaryExpression('void', types.numericLiteral(0)))))
        node.body = body
      }
    },
  })

  traverse(ast, {
    ImportDeclaration(p) {
      const specifier = p.node.source.value
      const namespace = namespaceFor(specifier)
      for (const spec of p.node.specifiers) {
        const binding = p.scope.getBinding(spec.local.name)!
        if (binding.constantViolations.length) {
          throw new Error(`Cannot assign to imported binding '${spec.local.name}' in '${moduleId}'`)
        }
        let access: types.Expression
        if (types.isImportNamespaceSpecifier(spec)) {
          access = namespace
        } else if (types.isImportDefaultSpecifier(spec)) {
          // Preserve the existing CommonJS interoperability rule for externals.
          access = isRelative(specifier) && !externals.has(specifier) ? property(namespace, 'default') : namespace
        } else {
          access = property(namespace, exportName(spec.imported))
        }
        for (const reference of binding.referencePaths) {
          if (reference.parentPath.isExportSpecifier()) continue
          let replacement = types.cloneNode(access, true)
          if ((reference.parentPath.isCallExpression() || reference.parentPath.isOptionalCallExpression() || reference.parentPath.isTaggedTemplateExpression())
            && (reference.key === 'callee' || reference.key === 'tag')) {
            replacement = types.sequenceExpression([types.numericLiteral(0), replacement])
          }
          reference.replaceWith(replacement)
        }
      }
      p.remove()
    },
    ExportDefaultDeclaration(p) {
      const declaration = p.node.declaration
      if (types.isFunctionDeclaration(declaration) || types.isClassDeclaration(declaration)) {
        declaration.id ??= program!.scope.generateUidIdentifier('default')
        exports.get('default')!.local = declaration.id.name
        p.replaceWith(declaration)
      } else {
        const temp = program!.scope.generateUidIdentifier('default')
        exports.get('default')!.local = temp.name
        p.replaceWith(types.variableDeclaration('const', [types.variableDeclarator(temp, declaration as types.Expression)]))
      }
    },
    ExportNamedDeclaration(p) {
      if (p.node.declaration) p.replaceWith(p.node.declaration)
      else p.remove()
    },
    ExportAllDeclaration(p) { p.remove() },
  })

  const getters: types.Statement[] = []
  for (const [name, binding] of exports) {
    const value = binding.source
      ? binding.namespace ? namespaceFor(binding.source) : property(namespaceFor(binding.source), binding.local)
      : types.identifier(binding.local)
    getters.push(types.expressionStatement(types.callExpression(
      types.memberExpression(types.memberExpression(types.identifier(notifyIdentifier), types.identifier('Object')), types.identifier('defineProperty')),
      [types.identifier(exportsIdentifier), types.stringLiteral(name), types.objectExpression([
        types.objectProperty(types.identifier('enumerable'), types.booleanLiteral(true)),
        types.objectProperty(types.identifier('get'), types.functionExpression(null, [], types.blockStatement([types.returnStatement(value)]))),
      ])]
    )))
  }
  ast.program.body.unshift(...prelude, ...getters)
  return { code: generator(ast).code, exportNames: [...exports.keys()] }
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
  /** Private runtime hook used to refresh native ESM bindings. */
  notifyIdentifier?: string
  /** Generated name of the entry namespace returned by the VM. */
  exportsIdentifier?: string
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

  const moduleExports = isCJS ? undefined : collectModuleExports(modules, sortedIds, externals, entryDir)
  const usedNames = new Set<string>()
  if (!isCJS) {
    for (const mod of modules.values()) {
      traverse(parseModule(mod.source), { Identifier(p) { usedNames.add(p.node.name) }, noScope: true })
    }
  }
  const uniqueName = (preferred: string) => {
    let name = preferred
    while (usedNames.has(name)) name += '_'
    usedNames.add(name)
    return name
  }
  const notifyIdentifier = uniqueName('__scriptvmNotifyExports')
  const registryIdentifier = isCJS ? '__m' : uniqueName('__m')
  const exportsIdentifier = isCJS ? '__exports' : uniqueName('__exports')
  const transform = (source: string, id: string, entry: string, external: Set<string>, dir: string) =>
    isCJS ? transformCJSModule(source, id, entry, external, dir)
      : transformModule(source, id, entry, external, dir, moduleExports!.get(id)!, notifyIdentifier, registryIdentifier, exportsIdentifier)
  const notifyMetadata = isCJS ? {} : { notifyIdentifier, exportsIdentifier }

  // VM property stores use Reflect.set. A namespace proxy enforces the ESM
  // read-only contract even when a namespace escapes through a function call.
  // Host intrinsics come from the private bridge, avoiding user bindings while
  // preserving observable names of user function and class declarations.
  const hostObject = `${notifyIdentifier}.Object`
  const namespaceInit = isCJS ? '{}' : `${hostObject}.create(null)`
  const namespaceResult = isCJS ? exportsIdentifier : `new ${notifyIdentifier}.Proxy(${hostObject}.preventExtensions(${exportsIdentifier}), {
    set: function() { throw new ${notifyIdentifier}.TypeError('Cannot assign to a module namespace'); },
    deleteProperty: function(target, name) {
      if (${hostObject}.prototype.hasOwnProperty.call(target, name)) throw new ${notifyIdentifier}.TypeError('Cannot delete a module export');
      return true;
    }
  })`

  // If only one module (no imports), just transform in-place
  if (sortedIds.length === 1) {
    const mod = modules.get(sortedIds[0])!
    const { code, exportNames } = transform(mod.source, mod.id, entryId, externals, entryDir)
    // Wrap with __exports for consistency
    const wrapped = `var ${exportsIdentifier} = ${namespaceInit};\n${code}\n${exportsIdentifier} = ${namespaceResult};\n`
    return { code: wrapped, entryExports: exportNames, ...notifyMetadata }
  }

  // Build the bundled code
  const parts: string[] = []
  parts.push(`var ${registryIdentifier} = {};`)

  let entryExports: string[] = []

  for (const id of sortedIds) {
    const mod = modules.get(id)!
    const isEntry = id === entryId
    const { code, exportNames } = transform(mod.source, id, entryId, externals, entryDir)

    if (isEntry) {
      entryExports = exportNames
      // Entry module: inject __exports var, then inline code
      parts.push(`var ${exportsIdentifier} = ${namespaceInit};`)
      parts.push(code)
      parts.push(`${exportsIdentifier} = ${namespaceResult};`)
    } else {
      // Dependency module: wrap in IIFE, store in __m registry
      parts.push(
        `${registryIdentifier}[${JSON.stringify(id)}] = (function() {\n` +
        `  var ${exportsIdentifier} = ${namespaceInit};\n` +
        `  ${code}\n` +
        `  return ${namespaceResult};\n` +
        `})();`
      )
    }
  }

  return { code: parts.join('\n'), entryExports, ...notifyMetadata }
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
