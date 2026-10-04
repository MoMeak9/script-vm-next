import type { NodePath } from '@babel/traverse'
import * as t from '@babel/types'

function preserveDefaultName(parameter: t.Node): void {
  if (t.isAssignmentPattern(parameter)) {
    const value = parameter.right
    if (t.isIdentifier(parameter.left) &&
        (t.isArrowFunctionExpression(value) ||
          (t.isFunctionExpression(value) || t.isClassExpression(value)) && !value.id)) {
      value.extra = { ...value.extra, vmFunctionName: parameter.left.name }
    }
    preserveDefaultName(parameter.left)
  } else if (t.isObjectPattern(parameter)) {
    for (const property of parameter.properties) {
      preserveDefaultName(t.isRestElement(property) ? property.argument : property.value)
    }
  } else if (t.isArrayPattern(parameter)) {
    for (const element of parameter.elements) if (element) preserveDefaultName(element)
  } else if (t.isRestElement(parameter)) {
    preserveDefaultName(parameter.argument)
  }
}

/** Keep parameter bindings lexical until each initializer has completed. Body
 * bindings get distinct internal names, so defaults and their closures cannot
 * accidentally resolve a var/function/let declared in the function body. */
export function normalizeFunctionParameters(path: NodePath<t.Function>): void {
  const node = path.node
  if (!node.params.some((parameter) => !t.isIdentifier(parameter))) return
  if (!t.isBlockStatement(node.body)) {
    node.body = t.blockStatement([t.returnStatement(node.body)])
  }
  const body = node.body
  const originalParams = [...node.params]
  const parameterNames = new Set<string>()
  for (const parameter of originalParams) {
    preserveDefaultName(parameter)
    for (const name of Object.keys(t.getBindingIdentifiers(parameter))) parameterNames.add(name)
  }
  const bodyBindings = new Map<string, { function: boolean }>()
  const remember = (name: string, isFunction: boolean, declarationPath: NodePath) => {
    const binding = path.scope.getBinding(name)
    const declarationBinding = declarationPath.scope.getBinding(name)
    if (!binding || binding.scope !== path.scope || declarationBinding?.identifier !== binding.identifier) return
    const previous = bodyBindings.get(name)
    bodyBindings.set(name, { function: isFunction || Boolean(previous?.function) })
  }
  path.get('body').traverse({
    Function(innerPath) {
      if (innerPath.isFunctionDeclaration() && innerPath.node.id) {
        remember(innerPath.node.id.name, true, innerPath)
      }
      innerPath.skip()
    },
    Class(innerPath) {
      if (innerPath.isClassDeclaration() && innerPath.node.id) remember(innerPath.node.id.name, false, innerPath)
      innerPath.skip()
    },
    VariableDeclaration(innerPath) {
      for (const declaration of innerPath.node.declarations) {
        for (const name of Object.keys(t.getBindingIdentifiers(declaration.id))) remember(name, false, innerPath)
      }
    },
  })

  const bodyCopies: t.Statement[] = []
  for (const [name, binding] of bodyBindings) {
    const internal = path.scope.generateUidIdentifier(name)
    const originalBinding = path.scope.getBinding(name)
    // Restrict renaming to the original body and this exact binding. Defaults
    // remain outside it; a nested function's shadowing parameter is unrelated.
    path.get('body').traverse({
      'FunctionDeclaration|ClassDeclaration'(innerPath) {
        const declaration = innerPath.node as t.FunctionDeclaration | t.ClassDeclaration
        if (declaration.id?.name === name &&
            innerPath.scope.getBinding(name)?.identifier === originalBinding?.identifier) {
          declaration.extra = { ...declaration.extra, vmFunctionName: name }
        }
      },
      ObjectProperty(innerPath) {
        if (innerPath.node.shorthand && t.isIdentifier(innerPath.node.value, { name }) &&
            innerPath.scope.getBinding(name) === originalBinding) {
          innerPath.node.shorthand = false
        }
      },
      Identifier(innerPath) {
        const isReference: boolean = innerPath.isReferencedIdentifier()
        const isBinding: boolean = innerPath.isBindingIdentifier()
        if (innerPath.node.name === name &&
            (isReference || isBinding) &&
            innerPath.scope.getBinding(name) === originalBinding) {
          innerPath.node.name = internal.name
        }
      },
    })
    if ((parameterNames.has(name) || name === 'arguments' && !t.isArrowFunctionExpression(node)) && !binding.function) {
      bodyCopies.push(t.variableDeclaration('var', [
        t.variableDeclarator(t.cloneNode(internal), t.identifier(name)),
      ]))
    }
  }

  const prelude: t.Statement[] = []
  const rawParams: t.Identifier[] = []
  let length = originalParams.length
  let foundLength = false
  for (let index = 0; index < originalParams.length; index++) {
    const parameter = originalParams[index]
    if (!foundLength && (t.isAssignmentPattern(parameter) || t.isRestElement(parameter))) {
      length = index
      foundLength = true
    }
    let target: t.LVal
    let value: t.Expression
    if (t.isRestElement(parameter)) {
      target = parameter.argument as t.LVal
      const args = t.identifier('arguments')
      args.extra = { vmIntrinsicArguments: true }
      value = t.callExpression(t.identifier('@script-vm/intrinsic/ArraySlice'), [args, t.numericLiteral(index)])
    } else {
      const raw = path.scope.generateUidIdentifier('parameter')
      rawParams.push(raw)
      target = (t.isAssignmentPattern(parameter) ? parameter.left : parameter) as t.LVal
      value = t.isAssignmentPattern(parameter)
        ? t.conditionalExpression(
          t.binaryExpression('===', t.cloneNode(raw), t.unaryExpression('void', t.numericLiteral(0))),
          parameter.right,
          t.cloneNode(raw)
        )
        : t.cloneNode(raw)
    }
    prelude.push(t.variableDeclaration('let', [t.variableDeclarator(target, value)]))
  }
  const boundary = t.emptyStatement()
  boundary.extra = { vmParameterPreludeEnd: true }
  node.params = rawParams
  node.extra = { ...node.extra, vmFunctionLength: length, vmNonSimpleParameters: true }
  body.body = [...prelude, boundary, ...bodyCopies, ...body.body]
  path.scope.crawl()
}
