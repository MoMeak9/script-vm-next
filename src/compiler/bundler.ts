/**
 * Module bundler for script-vm-next
 *
 * Resolves local and package ESM imports, inlines dependent modules into a single
 * source string, and converts import/export syntax into plain ES5 that the VM
 * can execute.
 *
 * CommonJS, builtin and explicitly external imports use the native ESM loader.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as parser from '@babel/parser'
import traverse from '@babel/traverse'
import * as types from '@babel/types'
import generator from '@babel/generator'
import type { ProgramArtifact } from './types'
import { resolveStaticImports, type ResolvedImport } from './module-resolution'

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
  imports?: Map<string, ResolvedImport>
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
  externals: Set<string>,
  entryDir: string
): Map<string, ModuleInfo> {
  const modules = new Map<string, ModuleInfo>()
  function visit(absPath: string) {
    const realPath = fs.realpathSync(absPath)
    const id = path.relative(entryDir, realPath)
    if (modules.has(id)) return
    const source = fs.readFileSync(realPath, 'utf-8')
    const ast = parseModule(source)
    const specifiers: string[] = []
    for (const node of ast.program.body) {
      if (types.isImportDeclaration(node) || types.isExportAllDeclaration(node)
        || types.isExportNamedDeclaration(node) && node.source) {
        if (node.attributes?.length || node.assertions?.length) {
          throw new Error(`Import attributes require a loader and are not supported in '${realPath}'`)
        }
        specifiers.push(node.source!.value)
      }
    }
    const imports = resolveStaticImports(specifiers, realPath, externals)
    const deps: string[] = []
    modules.set(id, { id, absPath: realPath, source, deps, imports })
    for (const resolved of imports.values()) {
      if (!resolved.filename) continue
      deps.push(path.relative(entryDir, resolved.filename))
      visit(resolved.filename)
    }
  }
  visit(entryPath)
  return modules
}

// ────────────────────────────────────────────────
// Dependency evaluation order with cycle detection
// ────────────────────────────────────────────────

function topoSort(modules: Map<string, ModuleInfo>, entryId: string, allowCycles: boolean): { sorted: string[]; cyclic: boolean } {
  const sorted: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>() // grey nodes for cycle detection
  let cyclic = false

  function dfs(id: string) {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      if (!allowCycles) throw new Error(`Circular dependency detected involving '${id}'`)
      cyclic = true
      return
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

  // Start at the entry: module discovery inserts dependencies first, which
  // would otherwise choose the wrong evaluation order within a cycle.
  dfs(entryId)
  for (const id of modules.keys()) dfs(id)

  return { sorted, cyclic }
}

/** Native imports run before the VM. Reject graphs that would reorder effects. */
function nativeDependencyOrder(modules: Map<string, ModuleInfo>, entryId: string, entryDir: string): string[] {
  const visited = new Set<string>()
  const native = new Set<string>()
  let completedModule: string | undefined
  const visit = (id: string) => {
    if (visited.has(id)) return
    visited.add(id)
    const mod = modules.get(id)!
    for (const [specifier, resolved] of mod.imports!) {
      if (resolved.filename) {
        visit(path.relative(entryDir, resolved.filename))
      } else if (!native.has(resolved.external!)) {
        if (completedModule !== undefined && !resolved.external!.startsWith('node:')) {
          throw new Error(`Cannot preserve module evaluation order: host external '${specifier}' in '${id}' would execute before inlined module '${completedModule}'. Keep this dependency in the inlined ESM graph instead of marking it external; CommonJS dependencies interleaved after inlined module evaluation require a loader that this compiler does not support`)
        }
        native.add(resolved.external!)
      }
    }
    completedModule = id
  }
  visit(entryId)
  return [...native]
}

// ────────────────────────────────────────────────
// Transform a single module's AST
// ────────────────────────────────────────────────

interface ExportBinding {
  local: string
  source?: string
  namespace?: boolean
  identity: string
  host?: { source: string; imported: string; namespace?: boolean }
}

type ModuleExports = Map<string, ExportBinding>

function exportName(node: types.Identifier | types.StringLiteral): string {
  return types.isIdentifier(node) ? node.name : node.value
}

function parseModule(source: string): types.File {
  return parser.parse(source, { sourceType: 'module' })
}

function dependencyId(specifier: string, moduleId: string, modules: Map<string, ModuleInfo>, entryDir: string): string {
  const resolved = modules.get(moduleId)!.imports!.get(specifier)!
  if (!resolved.filename) throw new Error(`Module '${specifier}' from '${moduleId}' is external`)
  return path.relative(entryDir, resolved.filename)
}

/** Resolve names and binding identities independently of module evaluation. */
function collectModuleExports(
  modules: Map<string, ModuleInfo>,
  sortedIds: string[],
  externals: Set<string>,
  entryDir: string
): Map<string, ModuleExports> {
  const records = new Map<string, { explicit: ModuleExports; imports: ModuleExports; stars: string[] }>()
  const internal = (id: string, source: string) => Boolean(modules.get(id)!.imports!.get(source)?.filename)
  const from = (id: string, source: string, local: string, namespace = false): ExportBinding => {
    const external = modules.get(id)!.imports!.get(source)!.external
    return {
      source, local, namespace,
      identity: `${external ?? dependencyId(source, id, modules, entryDir)}:${namespace ? '*' : local}`,
      host: external ? { source: external, imported: local, namespace } : undefined,
    }
  }
  for (const [id, module] of modules) {
    const ast = parseModule(module.source)
    const explicit: ModuleExports = new Map()
    const imports: ModuleExports = new Map()
    const stars: string[] = []
    for (const node of ast.program.body) {
      if (!types.isImportDeclaration(node)) continue
      for (const spec of node.specifiers) {
        const namespace = types.isImportNamespaceSpecifier(spec)
        const name = types.isImportSpecifier(spec) ? exportName(spec.imported) : 'default'
        imports.set(spec.local.name, from(id, node.source.value, name, namespace))
      }
    }
    for (const node of ast.program.body) {
      if (types.isExportAllDeclaration(node)) {
        if (!internal(id, node.source.value)) {
          throw new Error(`Star re-exports from host external module '${node.source.value}' cannot be statically linked. Bundle an ESM dependency instead; CommonJS, builtin and explicitly external star exports are not supported`)
        }
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
            explicit.set(name, from(id, node.source!.value, '*', true))
          } else if (types.isExportSpecifier(spec)) {
            const local = exportName(spec.local)
            explicit.set(name, node.source ? from(id, node.source.value, local)
              : imports.get(local) ?? { local, identity: `${id}:${local}` })
          }
        }
      }
    }
    records.set(id, { explicit, imports, stars })
  }

  // Mirrors GetExportedNames/ResolveExport: visiting the same module/name pair
  // breaks a cyclic search, while distinct star bindings remain ambiguous.
  const namesOf = (id: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(id)) return new Set()
    seen.add(id)
    const record = records.get(id)!
    const names = new Set(record.explicit.keys())
    for (const source of record.stars) {
      for (const name of namesOf(dependencyId(source, id, modules, entryDir), seen)) {
        if (name !== 'default') names.add(name)
      }
    }
    return names
  }
  const ambiguous = Symbol('ambiguous export')
  type Resolution = ExportBinding | typeof ambiguous | null
  const resolve = (id: string, name: string, seen = new Set<string>()): Resolution => {
    const key = JSON.stringify([id, name])
    if (seen.has(key)) return null
    seen.add(key)
    const record = records.get(id)!
    const direct = record.explicit.get(name)
    if (direct) {
      if (!direct.source || direct.namespace || !internal(id, direct.source)) return direct
      const original = resolve(dependencyId(direct.source, id, modules, entryDir), direct.local, seen)
      return original && original !== ambiguous ? { ...direct, identity: original.identity, host: original.host } : original
    }
    if (name === 'default') return null
    let found: ExportBinding | null = null
    for (const source of record.stars) {
      const original = resolve(dependencyId(source, id, modules, entryDir), name, seen)
      if (original === ambiguous) return ambiguous
      if (!original) continue
      if (found && found.identity !== original.identity) return ambiguous
      found = { source, local: name, identity: original.identity, host: original.host }
    }
    return found
  }
  const all = new Map<string, ModuleExports>()
  for (const id of sortedIds) {
    const resolved: ModuleExports = new Map()
    for (const name of namesOf(id)) {
      const binding = resolve(id, name)
      if (binding && binding !== ambiguous) resolved.set(name, binding)
    }
    for (const binding of [...records.get(id)!.imports.values(), ...records.get(id)!.explicit.values()]) {
      if (!binding.source || binding.namespace || !internal(id, binding.source)) continue
      const original = resolve(dependencyId(binding.source, id, modules, entryDir), binding.local)
      if (!original || original === ambiguous) {
        throw new Error(`Module '${binding.source}' has no unambiguous export named '${binding.local}' (imported by '${id}')`)
      }
    }
    all.set(id, resolved)
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
  exportsIdentifier: string,
  instantiateBeforeEvaluation = false,
  modules: Map<string, ModuleInfo>,
  hostImports: Map<string, { index: number; names: Set<string> }>
): { code: string; exportNames: string[] } {
  const ast = parseModule(source)
  let program: import('@babel/traverse').NodePath<types.Program>
  traverse(ast, { Program(p) { program = p; p.stop() } })

  const prelude: types.Statement[] = []
  const namespaceFor = (specifier: string, name?: string): types.Expression => {
    const resolved = modules.get(moduleId)!.imports!.get(specifier)!
    if (resolved.filename) {
      return types.memberExpression(types.identifier(registryIdentifier), types.stringLiteral(dependencyId(specifier, moduleId, modules, entryDir)), true)
    }
    const url = resolved.external!
    if (!hostImports.has(url)) hostImports.set(url, { index: hostImports.size, names: new Set() })
    if (name !== undefined) hostImports.get(url)!.names.add(name)
    return types.memberExpression(
      types.memberExpression(types.identifier(notifyIdentifier), types.identifier('imports')),
      types.numericLiteral(hostImports.get(url)!.index), true,
    )
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
  // A notification after the entire pattern would miss writes observed by the
  // next default initializer/getter, or completed before a later target throws.
  // Setter references publish each individual binding write at its actual step.
  const publishedTarget = (node: types.Node, scope: import('@babel/traverse').Scope): types.Node => {
    if (types.isIdentifier(node) && changesExport(node, scope)) {
      const value = program!.scope.generateUidIdentifier('assigned')
      return types.memberExpression(types.objectExpression([
        types.objectMethod('set', types.identifier('value'), [value], types.blockStatement([
          types.expressionStatement(notify(types.assignmentExpression('=', types.cloneNode(node), types.cloneNode(value)))),
        ])),
      ]), types.identifier('value'))
    }
    if (types.isArrayPattern(node)) {
      node.elements = node.elements.map(item => item ? publishedTarget(item, scope) as typeof item : null)
    } else if (types.isObjectPattern(node)) {
      for (const property of node.properties) {
        if (types.isRestElement(property)) property.argument = publishedTarget(property.argument, scope) as typeof property.argument
        else {
          property.value = publishedTarget(property.value, scope) as typeof property.value
          property.shorthand = false
        }
      }
    } else if (types.isAssignmentPattern(node)) {
      node.left = publishedTarget(node.left, scope) as typeof node.left
    } else if (types.isRestElement(node)) {
      node.argument = publishedTarget(node.argument, scope) as typeof node.argument
    }
    return node
  }
  traverse(ast, {
    AssignmentExpression: {
      exit(p) {
        if (changesExport(p.node.left, p.scope)) {
          if (types.isPattern(p.node.left)) {
            p.node.left = publishedTarget(p.node.left, p.scope) as typeof p.node.left
          } else {
            p.replaceWith(notify(p.node))
          }
          p.skip()
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
          if (types.isVariableDeclaration(node.left)) {
            // Only function-scoped var declarations can refer to an exported
            // binding here. Retain their hoisting before replacing the target.
            const declarationScope = p.scope.getFunctionParent() ?? p.scope.getProgramParent()
            for (const name of Object.keys(types.getBindingIdentifiers(target))) {
              declarationScope.push({ id: types.identifier(name), kind: 'var' })
            }
          }
          node.left = publishedTarget(target, p.scope) as typeof node.left
          return
        }
        const body = types.isBlockStatement(node.body) ? node.body : types.blockStatement([node.body])
        body.body.unshift(types.expressionStatement(notify(types.unaryExpression('void', types.numericLiteral(0)))))
        node.body = body
      }
    },
  })

  const inModuleContext = (p: import('@babel/traverse').NodePath): boolean => {
    let child = p
    for (let parent = p.parentPath; parent; child = parent, parent = parent.parentPath) {
      if (parent.isStaticBlock()) return false
      if ((parent.isClassProperty() || parent.isClassPrivateProperty()) && child.key === 'value') return false
      if (parent.isFunction() && !parent.isArrowFunctionExpression() && child.key !== 'key') return false
    }
    return true
  }
  traverse(ast, {
    ThisExpression(p) {
      // Modules have an undefined top-level receiver, including arrows. A
      // strict script alone is insufficient because its top-level this is the
      // global object. Method keys are evaluated outside the method body;
      // class field initializers/static blocks establish their own receiver.
      if (inModuleContext(p)) p.replaceWith(types.unaryExpression('void', types.numericLiteral(0)))
    },
    ReferencedIdentifier(p) {
      // Module factories must not leak their own arguments object into source
      // that is lexically at module scope. Ordinary functions keep arguments.
      if (p.node.name !== 'arguments' || p.scope.getBinding('arguments') || !inModuleContext(p)) return
      const allowMissing = p.parentPath.isUnaryExpression({ operator: 'typeof' })
      p.replaceWith(types.callExpression(
        types.memberExpression(types.identifier(notifyIdentifier), types.identifier('getGlobal')),
        [types.stringLiteral('arguments'), types.booleanLiteral(allowMissing)],
      ))
    },
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
          access = property(namespaceFor(specifier, 'default'), 'default')
        } else {
          access = property(namespaceFor(specifier, exportName(spec.imported)), exportName(spec.imported))
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
      ? binding.namespace ? namespaceFor(binding.source) : property(namespaceFor(binding.source, binding.local), binding.local)
      : types.identifier(binding.local)
    getters.push(types.expressionStatement(types.callExpression(
      types.memberExpression(types.memberExpression(types.identifier(notifyIdentifier), types.identifier('Object')), types.identifier('defineProperty')),
      [types.identifier(exportsIdentifier), types.stringLiteral(name), types.objectExpression([
        types.objectProperty(types.identifier('enumerable'), types.booleanLiteral(true)),
        types.objectProperty(types.identifier('get'), types.functionExpression(null, [], types.blockStatement([types.returnStatement(value)]))),
      ])]
    )))
  }
  if (instantiateBeforeEvaluation) {
    // A suspended generator retains each module's lexical environment. Getter
    // installation and hoisted functions are available during instantiation;
    // let/const/class declarations remain in their temporal dead zones until
    // evaluation resumes after every dependency namespace has been linked.
    ast.program.body.unshift(...prelude, ...getters, types.expressionStatement(types.yieldExpression(types.identifier(exportsIdentifier))))
  } else {
    ast.program.body.unshift(...prelude, ...getters)
  }
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
  /** Native namespaces required by CommonJS, builtin and explicit externals. */
  hostImports?: ProgramArtifact['hostImports']
  hostExports?: ProgramArtifact['hostExports']
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
    : collectModules(absEntry, externals, entryDir)

  const entryId = path.relative(entryDir, absEntry)
  const { sorted: sortedIds, cyclic } = topoSort(modules, entryId, !isCJS)

  const nativeOrder = isCJS ? [] : nativeDependencyOrder(modules, entryId, entryDir)
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
  const hostImports = new Map(nativeOrder.map((url, index) => [url, { index, names: new Set<string>() }]))
  const transform = (source: string, id: string, entry: string, external: Set<string>, dir: string) =>
    isCJS ? transformCJSModule(source, id, entry, external, dir)
      : transformModule(source, id, entry, external, dir, moduleExports!.get(id)!, notifyIdentifier, registryIdentifier, exportsIdentifier, cyclic, modules, hostImports)
  const notifyMetadata = () => isCJS ? {} : {
    notifyIdentifier,
    exportsIdentifier,
    hostImports: [...hostImports].map(([source, item]) => ({ source, names: [...item.names] })),
    hostExports: [...moduleExports!.get(entryId)!].flatMap(([exported, binding]) => binding.host ? [{ exported, ...binding.host }] : []),
  }

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

  if (!isCJS && cyclic) {
    const instancesIdentifier = uniqueName('__moduleInstances')
    const parts = [`"use strict";`, `var ${registryIdentifier} = ${namespaceInit};`, `var ${instancesIdentifier} = ${namespaceInit};`]
    for (const id of sortedIds) {
      const mod = modules.get(id)!
      const { code } = transform(mod.source, id, entryId, externals, entryDir)
      parts.push(`${instancesIdentifier}[${JSON.stringify(id)}] = (function*() {
        var ${exportsIdentifier} = ${namespaceInit};
        ${code}
      })();`)
    }
    for (const id of sortedIds) {
      // The yield returns the namespace before any module body is evaluated.
      // Seal it only after getters have been installed by instantiation.
      parts.push(`(function() {
        var ${exportsIdentifier} = ${instancesIdentifier}[${JSON.stringify(id)}].next().value;
        ${registryIdentifier}[${JSON.stringify(id)}] = ${namespaceResult};
      })();`)
    }
    for (const id of sortedIds) parts.push(`${instancesIdentifier}[${JSON.stringify(id)}].next();`)
    parts.push(`var ${exportsIdentifier} = ${registryIdentifier}[${JSON.stringify(entryId)}];`)
    return { code: parts.join('\n'), entryExports: [...moduleExports!.get(entryId)!.keys()], ...notifyMetadata() }
  }

  // If only one module (no imports), just transform in-place
  if (sortedIds.length === 1) {
    const mod = modules.get(sortedIds[0])!
    const { code, exportNames } = transform(mod.source, mod.id, entryId, externals, entryDir)
    // Wrap with __exports for consistency
    const wrapped = `${isCJS ? '' : '"use strict";\n'}var ${exportsIdentifier} = ${namespaceInit};\n${code}\n${exportsIdentifier} = ${namespaceResult};\n`
    return { code: wrapped, entryExports: exportNames, ...notifyMetadata() }
  }

  // Build the bundled code
  const parts: string[] = isCJS ? [] : ['"use strict";']
  parts.push(`var ${registryIdentifier} = ${namespaceInit};`)

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

  return { code: parts.join('\n'), entryExports, ...notifyMetadata() }
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
