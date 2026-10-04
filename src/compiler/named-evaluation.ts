import traverse from '@babel/traverse'
import * as t from '@babel/types'

/** NamedEvaluation attaches observable names to anonymous functions/classes
 * without creating a lexical self binding. Dynamic object keys are handled by
 * object normalization after evaluating the key exactly once. */
export function inferFunctionNames(file: t.File): void {
  traverse(file, {
    'FunctionExpression|ArrowFunctionExpression|ClassExpression'(path) {
      const node = path.node as t.FunctionExpression | t.ArrowFunctionExpression | t.ClassExpression
      if (!t.isArrowFunctionExpression(node) && node.id) return
      const parent = path.parent
      let name: string | undefined
      if (t.isVariableDeclarator(parent) && parent.init === node && t.isIdentifier(parent.id)) {
        name = parent.id.name
      } else if (t.isAssignmentExpression(parent, { operator: '=' }) && parent.right === node && t.isIdentifier(parent.left)) {
        name = parent.left.name
      } else if (t.isAssignmentPattern(parent) && parent.right === node && t.isIdentifier(parent.left)) {
        name = parent.left.name
      } else if (t.isObjectProperty(parent) && parent.value === node && !parent.computed) {
        if (t.isIdentifier(parent.key)) name = parent.key.name
        else if (t.isStringLiteral(parent.key) || t.isNumericLiteral(parent.key)) name = String(parent.key.value)
      }
      if (name !== undefined) node.extra = { ...node.extra, vmFunctionName: name }
    },
  })
}
