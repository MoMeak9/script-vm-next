import { parse } from '@babel/parser'
import traverseModule, { type NodePath } from '@babel/traverse'
import generateModule from '@babel/generator'
import * as t from '@babel/types'
import { BINARY_OPS, OPCODES, UNARY_OPS } from '../runtime/opcodes'
import type { RuntimeRequirements } from './types'

const traverse: typeof traverseModule = typeof traverseModule === 'function'
  ? traverseModule
  : (traverseModule as unknown as { default: typeof traverseModule }).default
const generate: typeof generateModule = typeof generateModule === 'function'
  ? generateModule
  : (generateModule as unknown as { default: typeof generateModule }).default

// This allowlist describes the native dependencies of our own runtime template,
// never names from user source. A misspelled/missing private helper must fail at
// compilation instead of accidentally becoming a lookup on the execution host.
const HOST_BINDINGS = new Set([
  'Array', 'Error', 'Function', 'Object', 'Proxy', 'ReferenceError', 'Reflect',
  'Symbol', 'TypeError', 'WeakMap', 'WeakSet', 'arguments', 'undefined',
])
const EXECUTORS = new Map([
  ['executeSync', 'sync'], ['executeAsync', 'async'],
  ['executeGenerator', 'generator'], ['executeAsyncGenerator', 'async-generator'],
])

let cachedTemplate: { source: string; ast: t.File } | undefined
const assembledSources = new Map<string, string>()
const CACHE_LIMIT = 64

function fail(message: string): never {
  throw new Error(`Invalid runtime template: ${message}`)
}

function memberName(node: t.Node | null | undefined, object: string): string | undefined {
  if (!t.isMemberExpression(node) || !t.isIdentifier(node.object, { name: object })) return undefined
  if (!node.computed && t.isIdentifier(node.property)) return node.property.name
  if (node.computed && t.isStringLiteral(node.property)) return node.property.value
  return undefined
}

function metaFlag(node: t.Node, flag: string): boolean {
  return memberName(node, 'meta') === flag
}

function pruneSwitch(
  statement: t.SwitchStatement,
  selected: ReadonlySet<string>,
  key: (test: t.Expression) => string | undefined,
  label: string,
): void {
  const available = new Set<string>()
  for (const branch of statement.cases) {
    if (!branch.test) continue
    const name = key(branch.test)
    if (name === undefined || available.has(name)) fail(`unrecognized or duplicate ${label} case`)
    available.add(name)
  }
  for (const name of selected) {
    if (!available.has(name)) fail(`missing ${label} handler ${name}`)
  }
  // The controlled template has one independent, terminating handler per case.
  // Reject fallthrough rather than silently removing its destination.
  for (const branch of statement.cases) {
    const last = branch.consequent.at(-1)
    const end = t.isBlockStatement(last) ? last.body.at(-1) : last
    if (!t.isBreakStatement(end) && !t.isReturnStatement(end) && !t.isThrowStatement(end)) {
      fail(`${label} handler must terminate without fallthrough`)
    }
  }
  statement.cases = statement.cases.filter(branch => !branch.test || selected.has(key(branch.test)!))
}

function pruneConstantTable(path: NodePath<t.VariableDeclarator>, table: Record<string, number>, names: ReadonlySet<string>): void {
  if (!t.isObjectExpression(path.node.init)) fail('opcode table must be an object literal')
  path.node.init.properties = Object.entries(table)
    .filter(([name]) => names.has(name))
    .map(([name, value]) => t.objectProperty(t.stringLiteral(name), t.numericLiteral(value)))
}

function specializeDispatch(ast: t.File, requirements: RuntimeRequirements): void {
  const opcodes = new Set<string>(requirements.opcodes)
  const binary = new Set(requirements.binaryOperators)
  const unary = new Set(requirements.unaryOperators)
  const intrinsics = new Set(requirements.intrinsics)
  const kinds = new Set<string>(requirements.functionKinds)
  const seenExecutors = new Set<string>()
  let intrinsicDispatch = false

  traverse(ast, {
    FunctionDeclaration(path) {
      const name = path.node.id?.name ?? ''
      const kind = EXECUTORS.get(name)
      if (kind) {
        seenExecutors.add(kind)
        // Removing these declarations also prevents unnecessary traversal of the
        // discarded execution loops. Their references are removed below.
        if (!kinds.has(kind)) path.remove()
      }
    },
    VariableDeclarator(path) {
      const name = t.isIdentifier(path.node.id) ? path.node.id.name : undefined
      if (name === 'OPCODES') pruneConstantTable(path, OPCODES, opcodes)
      if (name === 'BINARY_OPS') pruneConstantTable(path, BINARY_OPS, binary)
      if (name === 'UNARY_OPS') pruneConstantTable(path, UNARY_OPS, unary)
    },
    SwitchStatement(path) {
      const owner = path.getFunctionParent()
      const name = owner?.isFunctionDeclaration() ? owner.node.id?.name : undefined
      if (name === 'readGlobal') {
        intrinsicDispatch = true
        pruneSwitch(path.node, intrinsics, test => t.isStringLiteral(test) ? test.value : undefined, 'intrinsic')
        if (intrinsics.size === 0) path.replaceWithMultiple(path.node.cases[0].consequent)
      } else if (name === 'binary') {
        pruneSwitch(path.node, binary, test => memberName(test, 'BINARY_OPS'), 'binary operator')
      } else if (name === 'unary') {
        pruneSwitch(path.node, unary, test => memberName(test, 'UNARY_OPS'), 'unary operator')
      } else if (name === 'run' && t.isIdentifier(path.node.discriminant, { name: 'op' })) {
        pruneSwitch(path.node, opcodes, test => memberName(test, 'OPCODES'), 'opcode')
      }
    },
    IfStatement: {
      exit(path) {
        const owner = path.getFunctionParent()
        const name = owner?.isFunctionDeclaration() ? owner.node.id?.name : undefined
        if (name === 'createClosure') {
          if (metaFlag(path.node.test, 'generator') && !kinds.has('generator') && !kinds.has('async-generator')) {
            if (!path.node.alternate) fail('generator closure branch has no fallback')
            path.replaceWith(path.node.alternate)
          } else if (metaFlag(path.node.test, 'async') && !kinds.has('async')) {
            if (!path.node.alternate) fail('async closure branch has no fallback')
            path.replaceWith(path.node.alternate)
          }
        }
        if (name === 'createEnv' && !requirements.needsArguments
          && t.isBinaryExpression(path.node.test)
          && memberName(path.node.test.left, 'meta') === 'argumentsSlot') {
          path.remove()
        }
      },
    },
    ConditionalExpression(path) {
      const owner = path.getFunctionParent()
      if (owner?.isFunctionDeclaration() && owner.node.id?.name === 'createClosure' && metaFlag(path.node.test, 'async')) {
        if (!kinds.has('async-generator')) path.replaceWith(path.node.alternate)
        else if (!kinds.has('generator')) path.replaceWith(path.node.consequent)
      }
    },
    ExpressionStatement(path) {
      if (requirements.needsArguments) return
      const owner = path.getFunctionParent()
      const expr = path.node.expression
      if (owner?.isFunctionDeclaration() && owner.node.id?.name === 'createEnv'
        && t.isAssignmentExpression(expr) && memberName(expr.left, 'env') === 'args'
        && t.isCallExpression(expr.right) && t.isIdentifier(expr.right.callee, { name: 'createArguments' })) {
        path.remove()
      }
    },
  })
  for (const kind of kinds) if (!seenExecutors.has(kind)) fail(`missing ${kind} executor`)
  if (!intrinsicDispatch) fail('missing intrinsic dispatch')
}

/** Resolve lexical references after specialization, including dependencies from
 * nested functions and initializers. This derives transitive helper dependencies
 * from the implementation itself, so adding a helper call cannot omit an edge in
 * a hand-maintained registry. Only the controlled template is analyzed here. */
function linkRuntime(ast: t.File): void {
  traverse(ast, {
    FunctionDeclaration(runtime) {
      if (runtime.node.id?.name !== '__scriptvmRun') return
      runtime.scope.crawl()
      const declarations = new Map<string, NodePath<t.FunctionDeclaration | t.VariableDeclarator>>()
      const roots: NodePath[] = []
      for (const statement of runtime.get('body.body')) {
        if (statement.isFunctionDeclaration() && statement.node.id) declarations.set(statement.node.id.name, statement)
        else if (statement.isVariableDeclaration()) {
          for (const declaration of statement.get('declarations')) {
            if (!t.isIdentifier(declaration.node.id)) fail('top-level destructuring declaration')
            declarations.set(declaration.node.id.name, declaration)
          }
        } else if (statement.isReturnStatement()) roots.push(statement)
        else fail(`unexpected top-level ${statement.node.type}`)
      }

      const needed = new Set<string>()
      const pending: NodePath[] = [...roots]
      while (pending.length) {
        const node = pending.pop()!
        node.traverse({
          ReferencedIdentifier(path) {
            const name = path.node.name
            const binding = path.scope.getBinding(name)
            if (!binding) {
              if (!HOST_BINDINGS.has(name)) fail(`unbound helper ${name}`)
              return
            }
            if (binding.scope !== runtime.scope || !declarations.has(name) || needed.has(name)) return
            // Top-level runtime declarations are immutable captures/functions.
            // A future top-level reassignment needs explicit linking semantics.
            if (!binding.constant) fail(`mutable top-level binding ${name}`)
            needed.add(name)
            pending.push(declarations.get(name)!)
          },
        })
      }
      for (const [name, declaration] of declarations) if (!needed.has(name)) declaration.remove()
      runtime.skip()
    },
  })
  // Rebuild scopes once more to catch any missing dependency after pruning.
  traverse(ast, {
    Program(path) { path.scope.crawl() },
    ReferencedIdentifier(path) {
      if (!path.scope.getBinding(path.node.name) && !HOST_BINDINGS.has(path.node.name)) {
        fail(`unbound helper ${path.node.name}`)
      }
    },
  })
}

/** Assemble a self-contained runtime at compile time; no loader is emitted. */
export function assembleRuntimeSource(source: string, requirements: RuntimeRequirements): string {
  if (cachedTemplate?.source !== source) {
    const ast = parse(source, { sourceType: 'script' })
    if (ast.program.body.length !== 1 || !t.isFunctionDeclaration(ast.program.body[0])
      || ast.program.body[0].id?.name !== '__scriptvmRun') fail('expected one __scriptvmRun declaration')
    cachedTemplate = { source, ast }
    assembledSources.clear()
  }
  const key = JSON.stringify(requirements)
  const existing = assembledSources.get(key)
  if (existing !== undefined) return existing
  const ast = t.cloneNode(cachedTemplate.ast, true, true)
  specializeDispatch(ast, requirements)
  linkRuntime(ast)
  const output = generate(ast, { comments: false }).code
  if (assembledSources.size >= CACHE_LIMIT) assembledSources.delete(assembledSources.keys().next().value!)
  assembledSources.set(key, output)
  return output
}
