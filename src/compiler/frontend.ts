import * as parser from '@babel/parser'
import traverse from '@babel/traverse'
import * as t from '@babel/types'
import { detectModuleFormat } from './bundler'
import type { ModuleFormat } from './types'

const PARSER_PLUGINS: parser.ParserPlugin[] = [
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'classStaticBlock',
  'optionalChaining',
  'nullishCoalescingOperator',
  'bigInt',
  'dynamicImport',
]

export function parseSource(source: string, sourceType: 'module' | 'script'): t.File {
  return parser.parse(source, {
    sourceType,
    plugins: PARSER_PLUGINS,
  })
}

function transformSuperCalls(bodyStatements: t.Statement[]) {
  const ast = t.file(
    t.program([
      t.functionDeclaration(t.identifier('_tmp'), [], t.blockStatement(bodyStatements)),
    ])
  )

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee
      if (t.isSuper(callee)) {
        path.replaceWith(
          t.callExpression(
            t.memberExpression(t.identifier('_super'), t.identifier('call')),
            [t.thisExpression(), ...path.node.arguments]
          )
        )
        path.skip()
        return
      }

      if (t.isMemberExpression(callee) && t.isSuper(callee.object)) {
        path.replaceWith(
          t.callExpression(
            t.memberExpression(
              t.memberExpression(
                t.memberExpression(t.identifier('_super'), t.identifier('prototype')),
                callee.property,
                callee.computed
              ),
              t.identifier('call')
            ),
            [t.thisExpression(), ...path.node.arguments]
          )
        )
        path.skip()
      }
    },
    MemberExpression(path) {
      if (t.isSuper(path.node.object) && !path.parentPath.isCallExpression()) {
        path.replaceWith(
          t.memberExpression(
            t.memberExpression(t.identifier('_super'), t.identifier('prototype')),
            path.node.property,
            path.node.computed
          )
        )
      }
    },
  })

  const transformed = [...(ast.program.body[0] as t.FunctionDeclaration).body.body]
  bodyStatements.length = 0
  bodyStatements.push(...transformed)
}

interface PrivateDescriptor {
  name: string
  static: boolean
  kind: 'field' | 'method' | 'accessor'
  storageId: t.Identifier
  brandId?: t.Identifier
  implId?: t.Identifier
  getterId?: t.Identifier
  setterId?: t.Identifier
}

function createPrivateHelpers(): t.Statement[] {
  return [
    t.functionDeclaration(
      t.identifier('__privateFieldGet'),
      [t.identifier('map'), t.identifier('receiver')],
      t.blockStatement([
        t.ifStatement(
          t.unaryExpression('!', t.callExpression(
            t.memberExpression(t.identifier('map'), t.identifier('has')),
            [t.identifier('receiver')]
          )),
          t.blockStatement([
            t.throwStatement(
              t.newExpression(t.identifier('TypeError'), [t.stringLiteral('Cannot read private member from an object whose class did not declare it')])
            ),
          ])
        ),
        t.returnStatement(
          t.callExpression(t.memberExpression(t.identifier('map'), t.identifier('get')), [t.identifier('receiver')])
        ),
      ])
    ),
    t.functionDeclaration(
      t.identifier('__privateFieldSet'),
      [t.identifier('map'), t.identifier('receiver'), t.identifier('value')],
      t.blockStatement([
        t.ifStatement(
          t.unaryExpression('!', t.callExpression(
            t.memberExpression(t.identifier('map'), t.identifier('has')),
            [t.identifier('receiver')]
          )),
          t.blockStatement([
            t.throwStatement(
              t.newExpression(t.identifier('TypeError'), [t.stringLiteral('Cannot write private member to an object whose class did not declare it')])
            ),
          ])
        ),
        t.expressionStatement(
          t.callExpression(
            t.memberExpression(t.identifier('map'), t.identifier('set')),
            [t.identifier('receiver'), t.identifier('value')]
          )
        ),
        t.returnStatement(t.identifier('value')),
      ])
    ),
    t.functionDeclaration(
      t.identifier('__privateFieldInit'),
      [t.identifier('map'), t.identifier('receiver'), t.identifier('value')],
      t.blockStatement([
        t.ifStatement(
          t.callExpression(
            t.memberExpression(t.identifier('map'), t.identifier('has')),
            [t.identifier('receiver')]
          ),
          t.blockStatement([
            t.throwStatement(
              t.newExpression(t.identifier('TypeError'), [t.stringLiteral('Cannot initialize the same private elements twice on an object')])
            ),
          ])
        ),
        t.expressionStatement(
          t.callExpression(
            t.memberExpression(t.identifier('map'), t.identifier('set')),
            [t.identifier('receiver'), t.identifier('value')]
          )
        ),
        t.returnStatement(t.identifier('value')),
      ])
    ),
    t.functionDeclaration(
      t.identifier('__privateMethod'),
      [t.identifier('receiver'), t.identifier('brand'), t.identifier('fn')],
      t.blockStatement([
        t.ifStatement(
          t.unaryExpression('!', t.callExpression(
            t.memberExpression(t.identifier('brand'), t.identifier('has')),
            [t.identifier('receiver')]
          )),
          t.blockStatement([
            t.throwStatement(
              t.newExpression(t.identifier('TypeError'), [t.stringLiteral('Cannot access private method on an object whose class did not declare it')])
            ),
          ])
        ),
        t.returnStatement(t.identifier('fn')),
      ])
    ),
    t.functionDeclaration(
      t.identifier('__privateAccessorGet'),
      [t.identifier('receiver'), t.identifier('brand'), t.identifier('getter')],
      t.blockStatement([
        t.ifStatement(
          t.logicalExpression(
            '&&',
            t.identifier('brand'),
            t.unaryExpression(
              '!',
              t.callExpression(
                t.memberExpression(t.identifier('brand'), t.identifier('has')),
                [t.identifier('receiver')]
              )
            )
          ),
          t.blockStatement([
            t.throwStatement(
              t.newExpression(t.identifier('TypeError'), [t.stringLiteral('Cannot access private accessor on an object whose class did not declare it')])
            ),
          ])
        ),
        t.returnStatement(
          t.callExpression(
            t.memberExpression(t.identifier('getter'), t.identifier('call')),
            [t.identifier('receiver')]
          )
        ),
      ])
    ),
    t.functionDeclaration(
      t.identifier('__privateAccessorSet'),
      [t.identifier('receiver'), t.identifier('brand'), t.identifier('setter'), t.identifier('value')],
      t.blockStatement([
        t.ifStatement(
          t.logicalExpression(
            '&&',
            t.identifier('brand'),
            t.unaryExpression(
              '!',
              t.callExpression(
                t.memberExpression(t.identifier('brand'), t.identifier('has')),
                [t.identifier('receiver')]
              )
            )
          ),
          t.blockStatement([
            t.throwStatement(
              t.newExpression(t.identifier('TypeError'), [t.stringLiteral('Cannot access private accessor on an object whose class did not declare it')])
            ),
          ])
        ),
        t.expressionStatement(
          t.callExpression(
            t.memberExpression(t.identifier('setter'), t.identifier('call')),
            [t.identifier('receiver'), t.identifier('value')]
          )
        ),
        t.returnStatement(t.identifier('value')),
      ])
    ),
  ]
}

function transformPrivateReferences(targetNode: t.Node, descriptors: Map<string, PrivateDescriptor>, classId: t.Identifier) {
  const ast = t.file(t.program([t.expressionStatement(t.numericLiteral(0))]))
  ;(ast.program.body[0] as t.ExpressionStatement).expression = targetNode as t.Expression

  traverse(ast, {
    UpdateExpression(path) {
      if (!t.isMemberExpression(path.node.argument) || !t.isPrivateName(path.node.argument.property)) return
      const descriptor = descriptors.get(path.node.argument.property.id.name)
      if (!descriptor || descriptor.kind !== 'field') return
      const op = path.node.operator === '++' ? '+' : '-' as '+' | '-'
      path.replaceWith(
        t.assignmentExpression(
          '=',
          t.cloneNode(path.node.argument),
          t.binaryExpression(op, t.cloneNode(path.node.argument), t.numericLiteral(1))
        )
      )
    },
    CallExpression(path) {
      const callee = path.node.callee
      if (!t.isMemberExpression(callee) || !t.isPrivateName(callee.property)) {
        return
      }
      const descriptor = descriptors.get(callee.property.id.name)
      if (!descriptor || descriptor.kind !== 'method') {
        return
      }

      const receiver = callee.object as t.Expression
      if (descriptor.static) {
        const args = path.node.arguments.map((arg) =>
          t.isExpression(arg) ? transformPrivateReferences(t.cloneNode(arg, true), descriptors, classId) as t.Expression : arg
        )
        path.replaceWith(
          t.callExpression(
            t.memberExpression(descriptor.storageId, t.identifier('call')),
            [receiver, ...args]
          )
        )
      } else {
        const args = path.node.arguments.map((arg) =>
          t.isExpression(arg) ? transformPrivateReferences(t.cloneNode(arg, true), descriptors, classId) as t.Expression : arg
        )
        path.replaceWith(
          t.callExpression(
            t.memberExpression(
              t.callExpression(
                t.identifier('__privateMethod'),
                [receiver, descriptor.brandId!, descriptor.implId!]
              ),
              t.identifier('call')
            ),
            [receiver, ...args]
          )
        )
      }
      path.skip()
    },
    AssignmentExpression(path) {
      if (!t.isMemberExpression(path.node.left) || !t.isPrivateName(path.node.left.property)) {
        return
      }
      const descriptor = descriptors.get(path.node.left.property.id.name)
      if (!descriptor) {
        return
      }
      const receiver = path.node.left.object as t.Expression
      const value = transformPrivateReferences(t.cloneNode(path.node.right, true), descriptors, classId) as t.Expression
      if (descriptor.kind === 'accessor') {
        if (!descriptor.setterId) {
          throw new Error(`Private accessor #${descriptor.name} has no setter`)
        }
        path.replaceWith(
          t.callExpression(
            t.identifier('__privateAccessorSet'),
            [receiver, descriptor.static ? t.nullLiteral() : descriptor.brandId!, descriptor.setterId, value]
          )
        )
      } else if (descriptor.kind === 'field') {
        path.replaceWith(
          descriptor.static
            ? t.assignmentExpression('=', descriptor.storageId, value)
            : t.callExpression(t.identifier('__privateFieldSet'), [descriptor.storageId, receiver, value])
        )
      }
      path.skip()
    },
    MemberExpression(path) {
      if (!t.isPrivateName(path.node.property)) {
        return
      }
      if (
        path.parentPath.isCallExpression({ callee: path.node }) ||
        (path.parentPath.isAssignmentExpression() && path.parentPath.node.left === path.node)
      ) {
        return
      }

      const descriptor = descriptors.get(path.node.property.id.name)
      if (!descriptor) {
        return
      }

      const receiver = path.node.object as t.Expression
      if (descriptor.kind === 'accessor') {
        if (!descriptor.getterId) {
          throw new Error(`Private accessor #${descriptor.name} has no getter`)
        }
        path.replaceWith(
          t.callExpression(
            t.identifier('__privateAccessorGet'),
            [receiver, descriptor.static ? t.nullLiteral() : descriptor.brandId!, descriptor.getterId]
          )
        )
      } else if (descriptor.kind === 'field') {
        path.replaceWith(
          descriptor.static
            ? descriptor.storageId
            : t.callExpression(t.identifier('__privateFieldGet'), [descriptor.storageId, receiver])
        )
      } else {
        path.replaceWith(
          descriptor.static
            ? descriptor.storageId
            : t.callExpression(
                t.memberExpression(
                  t.callExpression(
                    t.identifier('__privateMethod'),
                    [receiver, descriptor.brandId!, descriptor.implId!]
                  ),
                  t.identifier('bind')
                ),
                [receiver]
              )
        )
      }
      path.skip()
    },
  })

  return (ast.program.body[0] as t.ExpressionStatement).expression
}

function transformPrivateBody(bodyStatements: t.Statement[], descriptors: Map<string, PrivateDescriptor>, classId: t.Identifier) {
  const ast = t.file(
    t.program([
      t.functionDeclaration(t.identifier('_tmp_private'), [], t.blockStatement(bodyStatements)),
    ])
  )
  traverse(ast, {
    UpdateExpression(path) {
      if (!t.isMemberExpression(path.node.argument) || !t.isPrivateName(path.node.argument.property)) return
      const descriptor = descriptors.get(path.node.argument.property.id.name)
      if (!descriptor || descriptor.kind !== 'field') return
      const op = path.node.operator === '++' ? '+' : '-' as '+' | '-'
      path.replaceWith(
        t.assignmentExpression(
          '=',
          t.cloneNode(path.node.argument),
          t.binaryExpression(op, t.cloneNode(path.node.argument), t.numericLiteral(1))
        )
      )
    },
    CallExpression(path) {
      const callee = path.node.callee
      if (!t.isMemberExpression(callee) || !t.isPrivateName(callee.property)) return
      const descriptor = descriptors.get(callee.property.id.name)
      if (!descriptor || descriptor.kind !== 'method') return
      const receiver = callee.object as t.Expression
      if (descriptor.static) {
        const args = path.node.arguments.map((arg) =>
          t.isExpression(arg) ? transformPrivateReferences(t.cloneNode(arg, true), descriptors, classId) as t.Expression : arg
        )
        path.replaceWith(
          t.callExpression(
            t.memberExpression(descriptor.storageId, t.identifier('call')),
            [receiver, ...args]
          )
        )
      } else {
        const args = path.node.arguments.map((arg) =>
          t.isExpression(arg) ? transformPrivateReferences(t.cloneNode(arg, true), descriptors, classId) as t.Expression : arg
        )
        path.replaceWith(
          t.callExpression(
            t.memberExpression(
              t.callExpression(t.identifier('__privateMethod'), [receiver, descriptor.brandId!, descriptor.implId!]),
              t.identifier('call')
            ),
            [receiver, ...args]
          )
        )
      }
      path.skip()
    },
    AssignmentExpression(path) {
      if (!t.isMemberExpression(path.node.left) || !t.isPrivateName(path.node.left.property)) return
      const descriptor = descriptors.get(path.node.left.property.id.name)
      if (!descriptor) return
      const receiver = path.node.left.object as t.Expression
      const value = transformPrivateReferences(t.cloneNode(path.node.right, true), descriptors, classId) as t.Expression
      if (descriptor.kind === 'accessor') {
        if (!descriptor.setterId) {
          throw new Error(`Private accessor #${descriptor.name} has no setter`)
        }
        path.replaceWith(
          t.callExpression(
            t.identifier('__privateAccessorSet'),
            [receiver, descriptor.static ? t.nullLiteral() : descriptor.brandId!, descriptor.setterId, value]
          )
        )
      } else if (descriptor.kind === 'field') {
        path.replaceWith(
          descriptor.static
            ? t.assignmentExpression('=', descriptor.storageId, value)
            : t.callExpression(t.identifier('__privateFieldSet'), [descriptor.storageId, receiver, value])
        )
      }
      path.skip()
    },
    MemberExpression(path) {
      if (!t.isPrivateName(path.node.property)) return
      if (
        path.parentPath.isCallExpression({ callee: path.node }) ||
        (path.parentPath.isAssignmentExpression() && path.parentPath.node.left === path.node)
      ) {
        return
      }
      const descriptor = descriptors.get(path.node.property.id.name)
      if (!descriptor) return
      const receiver = path.node.object as t.Expression
      if (descriptor.kind === 'accessor') {
        if (!descriptor.getterId) {
          throw new Error(`Private accessor #${descriptor.name} has no getter`)
        }
        path.replaceWith(
          t.callExpression(
            t.identifier('__privateAccessorGet'),
            [receiver, descriptor.static ? t.nullLiteral() : descriptor.brandId!, descriptor.getterId]
          )
        )
      } else if (descriptor.kind === 'field') {
        path.replaceWith(
          descriptor.static
            ? descriptor.storageId
            : t.callExpression(t.identifier('__privateFieldGet'), [descriptor.storageId, receiver])
        )
      } else {
        path.replaceWith(
          descriptor.static
            ? descriptor.storageId
            : t.callExpression(
                t.memberExpression(
                  t.callExpression(t.identifier('__privateMethod'), [receiver, descriptor.brandId!, descriptor.implId!]),
                  t.identifier('bind')
                ),
                [receiver]
              )
        )
      }
      path.skip()
    },
  })

  const transformed = [...(ast.program.body[0] as t.FunctionDeclaration).body.body]
  bodyStatements.length = 0
  bodyStatements.push(...transformed)
}

function buildClassIife(node: t.ClassDeclaration | t.ClassExpression, classId: t.Identifier): t.Expression {
  const superClass = node.superClass
  const body = node.body.body
  const statements: t.Statement[] = []
  const superParam = superClass ? t.identifier('_super') : null
  const methodInitializers: t.Statement[] = []
  const privateDescriptors = new Map<string, PrivateDescriptor>()
  const helperStatements = createPrivateHelpers()

  if (body.some((member) => t.isClassAccessorProperty(member) || t.isClassPrivateProperty(member) && member.static && !member.value && false)) {
    // keep placeholder to avoid unsupported syntax slipping through silently
  }

  for (const member of body) {
    if (t.isClassPrivateMethod(member)) {
      const name = member.key.id.name
      if (member.kind === 'get' || member.kind === 'set') {
        // Private accessor: get #x() / set #x()
        let descriptor = privateDescriptors.get(name)
        if (!descriptor) {
          const brandId = member.static ? undefined : t.identifier(`_${classId.name}_${name}_brand`)
          descriptor = {
            name,
            static: member.static,
            kind: 'accessor',
            storageId: brandId ?? t.identifier(`_${classId.name}_${name}_storage`),
            brandId,
          }
          privateDescriptors.set(name, descriptor)
          if (!member.static) {
            helperStatements.push(
              t.variableDeclaration('var', [t.variableDeclarator(brandId!, t.newExpression(t.identifier('WeakSet'), []))])
            )
            methodInitializers.push(
              t.expressionStatement(
                t.callExpression(t.memberExpression(brandId!, t.identifier('add')), [t.thisExpression()])
              )
            )
          }
        }

        const accessorImplId = t.identifier(`_${classId.name}_${member.kind}_${name}`)
        if (member.kind === 'get') {
          descriptor.getterId = accessorImplId
        } else {
          descriptor.setterId = accessorImplId
        }

        const methodBody = t.cloneNode(member.body, true)
        transformPrivateBody(methodBody.body, privateDescriptors, classId)
        const fn = t.functionExpression(null, member.params as t.Identifier[], methodBody, member.generator, member.async)
        helperStatements.push(
          t.variableDeclaration('var', [t.variableDeclarator(accessorImplId, fn)])
        )
        continue
      }
      const implId = t.identifier(`_${classId.name}_${name}_impl`)
      if (member.static) {
        privateDescriptors.set(name, {
          name,
          static: true,
          kind: 'method',
          storageId: implId,
        })
      } else {
        const brandId = t.identifier(`_${classId.name}_${name}_brand`)
        privateDescriptors.set(name, {
          name,
          static: false,
          kind: 'method',
          storageId: brandId,
          brandId,
          implId,
        })
        helperStatements.push(
          t.variableDeclaration('var', [t.variableDeclarator(brandId, t.newExpression(t.identifier('WeakSet'), []))])
        )
        methodInitializers.push(
          t.expressionStatement(
            t.callExpression(t.memberExpression(brandId, t.identifier('add')), [t.thisExpression()])
          )
        )
      }

      const methodBody = t.cloneNode(member.body, true)
      transformPrivateBody(methodBody.body, privateDescriptors, classId)
      const fn = t.functionExpression(null, member.params as t.Identifier[], methodBody, member.generator, member.async)
      helperStatements.push(
        t.variableDeclaration('var', [t.variableDeclarator(implId, fn)])
      )
      continue
    }

    if (t.isClassPrivateProperty(member)) {
      const name = member.key.id.name
      const storageId = t.identifier(`_${classId.name}_${name}`)
      privateDescriptors.set(name, {
        name,
        static: member.static,
        kind: 'field',
        storageId,
      })

      if (member.static) {
        helperStatements.push(
          t.variableDeclaration('var', [t.variableDeclarator(storageId)])
        )
      } else {
        helperStatements.push(
          t.variableDeclaration('var', [t.variableDeclarator(storageId, t.newExpression(t.identifier('WeakMap'), []))])
        )
      }
    }
  }

  statements.push(...helperStatements)

  const constructorMethod = body.find((member) => t.isClassMethod(member) && member.kind === 'constructor') as t.ClassMethod | undefined

  let constructorParams: t.Identifier[] = []
  let constructorBody: t.Statement[] = []

  if (constructorMethod) {
    constructorParams = constructorMethod.params.map((param) => {
      if (!t.isIdentifier(param)) {
        throw new Error('Constructor params should be desugared before class lowering')
      }
      return param
    })
    constructorBody = [...constructorMethod.body.body]
    if (superClass) {
      transformSuperCalls(constructorBody)
    }
    transformPrivateBody(constructorBody, privateDescriptors, classId)
  } else if (superClass) {
    constructorBody = [
      t.expressionStatement(
        t.callExpression(
          t.memberExpression(t.identifier('_super'), t.identifier('apply')),
          [t.thisExpression(), t.identifier('arguments')]
        )
      ),
    ]
  }

  const orderedInstanceInitializers = [...methodInitializers]
  const orderedStaticAssignments: t.Statement[] = []

  for (const member of body) {
    if (t.isClassPrivateProperty(member)) {
      const descriptor = privateDescriptors.get(member.key.id.name)!
      const initExpr = member.value
        ? transformPrivateReferences(t.cloneNode(member.value, true), privateDescriptors, classId) as t.Expression
        : t.identifier('undefined')

      if (member.static) {
        orderedStaticAssignments.push(
          t.expressionStatement(t.assignmentExpression('=', descriptor.storageId, initExpr))
        )
      } else {
        orderedInstanceInitializers.push(
          t.expressionStatement(
            t.callExpression(t.identifier('__privateFieldInit'), [descriptor.storageId, t.thisExpression(), initExpr])
          )
        )
      }
      continue
    }

    if (t.isClassProperty(member)) {
      const value = member.value
        ? transformPrivateReferences(t.cloneNode(member.value, true), privateDescriptors, classId) as t.Expression
        : t.identifier('undefined')
      if (member.static) {
        orderedStaticAssignments.push(
          t.expressionStatement(
            t.assignmentExpression(
              '=',
              t.memberExpression(classId, member.key as t.Expression, member.computed),
              value
            )
          )
        )
      } else {
        const left = t.memberExpression(t.thisExpression(), member.key as t.Expression, member.computed)
        orderedInstanceInitializers.push(
          t.expressionStatement(t.assignmentExpression('=', left, value))
        )
      }
    }

    if ((t as any).isStaticBlock && (t as any).isStaticBlock(member)) {
      const blockBody = (member as any).body as t.Statement[]
      const transformedBody = blockBody.map(stmt => {
        const cloned = t.cloneNode(stmt, true)
        transformPrivateBody([cloned], privateDescriptors, classId)
        return cloned
      })
      orderedStaticAssignments.push(
        t.expressionStatement(
          t.callExpression(
            t.memberExpression(
              t.functionExpression(null, [], t.blockStatement(transformedBody)),
              t.identifier('call')
            ),
            [t.cloneNode(classId)]
          )
        )
      )
    }
  }

  const ctorInitializers = orderedInstanceInitializers
  if (ctorInitializers.length > 0) {
    if (superClass) {
      const insertIndex = constructorBody.findIndex(
        (statement) =>
          t.isExpressionStatement(statement) &&
          t.isCallExpression(statement.expression) &&
          t.isMemberExpression(statement.expression.callee) &&
          t.isIdentifier(statement.expression.callee.object, { name: '_super' })
      )
      if (insertIndex >= 0) {
        constructorBody.splice(insertIndex + 1, 0, ...ctorInitializers)
      } else {
        constructorBody.unshift(...ctorInitializers)
      }
    } else {
      constructorBody.unshift(...ctorInitializers)
    }
  }

  statements.push(
    t.functionDeclaration(
      t.identifier(classId.name),
      constructorParams,
      t.blockStatement(constructorBody)
    )
  )

  if (superClass) {
    statements.push(
      t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.memberExpression(classId, t.identifier('prototype')),
          t.callExpression(
            t.memberExpression(t.identifier('Object'), t.identifier('create')),
            [t.memberExpression(t.identifier('_super'), t.identifier('prototype'))]
          )
        )
      )
    )
    statements.push(
      t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.memberExpression(
            t.memberExpression(classId, t.identifier('prototype')),
            t.identifier('constructor')
          ),
          classId
        )
      )
    )
  }

  for (const member of body) {
    if (t.isClassProperty(member) || t.isClassPrivateProperty(member) || t.isClassPrivateMethod(member)) continue

    if (!t.isClassMethod(member) || member.kind === 'constructor') {
      continue
    }

    const methodBody = t.cloneNode(member.body, true)
    if (superClass) {
      transformSuperCalls(methodBody.body)
    }
    transformPrivateBody(methodBody.body, privateDescriptors, classId)
    const fn = t.functionExpression(
      null,
      member.params as t.Identifier[],
      methodBody,
      member.generator,
      member.async
    )

    if (member.kind === 'get' || member.kind === 'set') {
      statements.push(
        t.expressionStatement(
          t.callExpression(
            t.memberExpression(t.identifier('Object'), t.identifier('defineProperty')),
            [
              member.static ? classId : t.memberExpression(classId, t.identifier('prototype')),
              member.computed ? (member.key as t.Expression) : t.stringLiteral((member.key as t.Identifier).name),
              t.objectExpression([t.objectProperty(t.identifier(member.kind), fn)]),
            ]
          )
        )
      )
      continue
    }

    statements.push(
      t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.memberExpression(
            member.static ? classId : t.memberExpression(classId, t.identifier('prototype')),
            member.key as t.Expression,
            member.computed
          ),
          fn
        )
      )
    )
  }

  statements.push(...orderedStaticAssignments)

  statements.push(t.returnStatement(classId))

  return t.callExpression(
    t.functionExpression(null, superParam ? [superParam] : [], t.blockStatement(statements)),
    superClass ? [superClass as t.Expression] : []
  )
}

function desugarPattern(
  pattern: t.ObjectPattern | t.ArrayPattern,
  source: t.Expression,
  kind: 'var' | 'let' | 'const',
  statements: t.Statement[],
  nextId: () => string
) {
  if (t.isObjectPattern(pattern)) {
    const restExcludes: string[] = []
    for (const prop of pattern.properties) {
      if (t.isRestElement(prop)) {
        const restTarget = prop.argument as t.Identifier
        const restTmp = t.identifier(nextId())
        const keysTmp = t.identifier(nextId())
        const iTmp = t.identifier(nextId())
        statements.push(t.variableDeclaration('var', [t.variableDeclarator(restTmp, t.objectExpression([]))]))
        statements.push(t.variableDeclaration('var', [
          t.variableDeclarator(keysTmp, t.callExpression(
            t.memberExpression(t.identifier('Object'), t.identifier('keys')),
            [source]
          ))
        ]))
        const excludeChecks = restExcludes.map(k =>
          t.binaryExpression('!==', t.memberExpression(keysTmp, iTmp, true), t.stringLiteral(k))
        )
        let condition: t.Expression = excludeChecks.length > 0
          ? (excludeChecks as t.Expression[]).reduce((a, b) => t.logicalExpression('&&', a, b))
          : t.booleanLiteral(true)
        statements.push(t.forStatement(
          t.variableDeclaration('var', [t.variableDeclarator(iTmp, t.numericLiteral(0))]),
          t.binaryExpression('<', iTmp, t.memberExpression(keysTmp, t.identifier('length'))),
          t.updateExpression('++', iTmp),
          t.blockStatement([
            t.ifStatement(condition, t.blockStatement([
              t.expressionStatement(t.assignmentExpression('=',
                t.memberExpression(restTmp, t.memberExpression(keysTmp, iTmp, true), true),
                t.memberExpression(source, t.memberExpression(keysTmp, iTmp, true), true)
              ))
            ]))
          ])
        ))
        statements.push(t.variableDeclaration(kind, [t.variableDeclarator(restTarget, restTmp)]))
        continue
      }

      const objProp = prop as t.ObjectProperty
      const keyName = !objProp.computed && t.isIdentifier(objProp.key) ? objProp.key.name : null
      if (keyName) restExcludes.push(keyName)

      const accessExpr = objProp.computed
        ? t.memberExpression(source, objProp.key as t.Expression, true)
        : t.isIdentifier(objProp.key)
          ? t.memberExpression(source, t.stringLiteral(objProp.key.name), true)
          : t.memberExpression(source, objProp.key as t.Expression, true)

      const target = objProp.value

      if (t.isAssignmentPattern(target)) {
        const valTmp = t.identifier(nextId())
        statements.push(t.variableDeclaration('var', [t.variableDeclarator(valTmp, accessExpr)]))
        const withDefault = t.conditionalExpression(
          t.binaryExpression('!==', valTmp, t.identifier('undefined')),
          valTmp,
          target.right
        )
        if (t.isIdentifier(target.left)) {
          statements.push(t.variableDeclaration(kind, [t.variableDeclarator(target.left, withDefault)]))
        } else if (t.isObjectPattern(target.left) || t.isArrayPattern(target.left)) {
          const nestedTmp = t.identifier(nextId())
          statements.push(t.variableDeclaration('var', [t.variableDeclarator(nestedTmp, withDefault)]))
          desugarPattern(target.left, nestedTmp, kind, statements, nextId)
        }
      } else if (t.isIdentifier(target)) {
        statements.push(t.variableDeclaration(kind, [t.variableDeclarator(target, accessExpr)]))
      } else if (t.isObjectPattern(target) || t.isArrayPattern(target)) {
        const nestedTmp = t.identifier(nextId())
        statements.push(t.variableDeclaration('var', [t.variableDeclarator(nestedTmp, accessExpr)]))
        desugarPattern(target, nestedTmp, kind, statements, nextId)
      }
    }
  }

  if (t.isArrayPattern(pattern)) {
    for (let i = 0; i < pattern.elements.length; i++) {
      const elem = pattern.elements[i]
      if (!elem) continue

      if (t.isRestElement(elem)) {
        const target = elem.argument as t.Identifier
        const sliceExpr = t.callExpression(
          t.memberExpression(
            t.memberExpression(
              t.memberExpression(t.identifier('Array'), t.identifier('prototype')),
              t.identifier('slice')
            ),
            t.identifier('call')
          ),
          [source, t.numericLiteral(i)]
        )
        statements.push(t.variableDeclaration(kind, [t.variableDeclarator(target, sliceExpr)]))
        break
      }

      const accessExpr = t.memberExpression(source, t.numericLiteral(i), true)

      if (t.isAssignmentPattern(elem)) {
        const valTmp = t.identifier(nextId())
        statements.push(t.variableDeclaration('var', [t.variableDeclarator(valTmp, accessExpr)]))
        const target = elem.left as t.Identifier
        statements.push(t.variableDeclaration(kind, [t.variableDeclarator(target,
          t.conditionalExpression(
            t.binaryExpression('!==', valTmp, t.identifier('undefined')),
            valTmp,
            elem.right
          )
        )]))
      } else if (t.isIdentifier(elem)) {
        statements.push(t.variableDeclaration(kind, [t.variableDeclarator(elem, accessExpr)]))
      } else if (t.isObjectPattern(elem) || t.isArrayPattern(elem)) {
        const nestedTmp = t.identifier(nextId())
        statements.push(t.variableDeclaration('var', [t.variableDeclarator(nestedTmp, accessExpr)]))
        desugarPattern(elem, nestedTmp, kind, statements, nextId)
      }
    }
  }
}

function desugarAssignmentPattern(
  pattern: t.ObjectPattern | t.ArrayPattern,
  source: t.Expression,
  statements: t.Statement[],
  nextId: () => string
) {
  if (t.isObjectPattern(pattern)) {
    const restExcludes: string[] = []
    for (const prop of pattern.properties) {
      if (t.isRestElement(prop)) {
        // Object rest in assignment: ({ a, ...rest } = obj)
        const restTarget = prop.argument as t.LVal
        const restTmp = t.identifier(nextId())
        const keysTmp = t.identifier(nextId())
        const iTmp = t.identifier(nextId())
        statements.push(t.variableDeclaration('var', [t.variableDeclarator(restTmp, t.objectExpression([]))]))
        statements.push(t.variableDeclaration('var', [
          t.variableDeclarator(keysTmp, t.callExpression(
            t.memberExpression(t.identifier('Object'), t.identifier('keys')),
            [source]
          ))
        ]))
        const excludeChecks = restExcludes.map(k =>
          t.binaryExpression('!==', t.memberExpression(keysTmp, iTmp, true), t.stringLiteral(k))
        )
        const condition: t.Expression = excludeChecks.length > 0
          ? (excludeChecks as t.Expression[]).reduce((a, b) => t.logicalExpression('&&', a, b))
          : t.booleanLiteral(true)
        statements.push(t.forStatement(
          t.variableDeclaration('var', [t.variableDeclarator(iTmp, t.numericLiteral(0))]),
          t.binaryExpression('<', iTmp, t.memberExpression(keysTmp, t.identifier('length'))),
          t.updateExpression('++', iTmp),
          t.blockStatement([
            t.ifStatement(condition, t.blockStatement([
              t.expressionStatement(t.assignmentExpression('=',
                t.memberExpression(restTmp, t.memberExpression(keysTmp, iTmp, true), true),
                t.memberExpression(source, t.memberExpression(keysTmp, iTmp, true), true)
              ))
            ]))
          ])
        ))
        statements.push(t.expressionStatement(t.assignmentExpression('=', restTarget, restTmp)))
        continue
      }

      const objProp = prop as t.ObjectProperty
      const keyName = !objProp.computed && t.isIdentifier(objProp.key) ? objProp.key.name : null
      if (keyName) restExcludes.push(keyName)

      const accessExpr = !objProp.computed && t.isIdentifier(objProp.key)
        ? t.memberExpression(source, t.stringLiteral(objProp.key.name), true)
        : t.memberExpression(source, objProp.key as t.Expression, true)
      const target = objProp.value

      if (t.isAssignmentPattern(target)) {
        const valTmp = t.identifier(nextId())
        statements.push(t.variableDeclaration('var', [t.variableDeclarator(valTmp, accessExpr)]))
        const withDefault = t.conditionalExpression(
          t.binaryExpression('!==', valTmp, t.identifier('undefined')),
          valTmp,
          target.right
        )
        if (t.isIdentifier(target.left)) {
          statements.push(t.expressionStatement(t.assignmentExpression('=', target.left, withDefault)))
        } else if (t.isObjectPattern(target.left) || t.isArrayPattern(target.left)) {
          const nestedTmp = t.identifier(nextId())
          statements.push(t.variableDeclaration('var', [t.variableDeclarator(nestedTmp, withDefault)]))
          desugarAssignmentPattern(target.left, nestedTmp, statements, nextId)
        }
      } else if (t.isIdentifier(target)) {
        statements.push(t.expressionStatement(t.assignmentExpression('=', target, accessExpr)))
      } else if (t.isObjectPattern(target) || t.isArrayPattern(target)) {
        const nestedTmp = t.identifier(nextId())
        statements.push(t.variableDeclaration('var', [t.variableDeclarator(nestedTmp, accessExpr)]))
        desugarAssignmentPattern(target, nestedTmp, statements, nextId)
      }
    }
  }

  if (t.isArrayPattern(pattern)) {
    for (let i = 0; i < pattern.elements.length; i++) {
      const elem = pattern.elements[i]
      if (!elem) continue

      if (t.isRestElement(elem)) {
        // Array rest in assignment: ([a, ...rest] = arr)
        const restTarget = elem.argument as t.LVal
        const sliceExpr = t.callExpression(
          t.memberExpression(
            t.memberExpression(
              t.memberExpression(t.identifier('Array'), t.identifier('prototype')),
              t.identifier('slice')
            ),
            t.identifier('call')
          ),
          [source, t.numericLiteral(i)]
        )
        statements.push(t.expressionStatement(t.assignmentExpression('=', restTarget, sliceExpr)))
        break
      }

      const accessExpr = t.memberExpression(source, t.numericLiteral(i), true)

      if (t.isAssignmentPattern(elem)) {
        const valTmp = t.identifier(nextId())
        statements.push(t.variableDeclaration('var', [t.variableDeclarator(valTmp, accessExpr)]))
        const withDefault = t.conditionalExpression(
          t.binaryExpression('!==', valTmp, t.identifier('undefined')),
          valTmp,
          elem.right
        )
        if (t.isIdentifier(elem.left)) {
          statements.push(t.expressionStatement(t.assignmentExpression('=', elem.left, withDefault)))
        } else if (t.isObjectPattern(elem.left) || t.isArrayPattern(elem.left)) {
          const nestedTmp = t.identifier(nextId())
          statements.push(t.variableDeclaration('var', [t.variableDeclarator(nestedTmp, withDefault)]))
          desugarAssignmentPattern(elem.left, nestedTmp, statements, nextId)
        }
      } else if (t.isIdentifier(elem)) {
        statements.push(t.expressionStatement(t.assignmentExpression('=', elem, accessExpr)))
      } else if (t.isObjectPattern(elem) || t.isArrayPattern(elem)) {
        const nestedTmp = t.identifier(nextId())
        statements.push(t.variableDeclaration('var', [t.variableDeclarator(nestedTmp, accessExpr)]))
        desugarAssignmentPattern(elem, nestedTmp, statements, nextId)
      }
    }
  }
}

function desugarFunctionParams(
  params: (t.Identifier | t.Pattern | t.RestElement)[],
  body: t.Statement[],
  nextId: () => string
) {
  const prependStatements: t.Statement[] = []
  for (let i = params.length - 1; i >= 0; i--) {
    const param = params[i]
    if (t.isIdentifier(param)) continue

    const tmpName = nextId()
    const tmpId = t.identifier(tmpName)

    if (t.isRestElement(param)) {
      const restTarget = param.argument as t.Identifier
      const sliceExpr = t.callExpression(
        t.memberExpression(
          t.memberExpression(
            t.memberExpression(t.identifier('Array'), t.identifier('prototype')),
            t.identifier('slice')
          ),
          t.identifier('call')
        ),
        [t.identifier('arguments'), t.numericLiteral(i)]
      )
      prependStatements.unshift(
        t.variableDeclaration('var', [t.variableDeclarator(restTarget, sliceExpr)])
      )
      params.splice(i, 1)
      continue
    }

    if (t.isAssignmentPattern(param)) {
      const innerParam = param.left
      if (t.isIdentifier(innerParam)) {
        // Simple default: function(x = 5) → function(x) { if (x === undefined) x = default }
        const valTmp = t.identifier(nextId())
        params[i] = innerParam
        prependStatements.unshift(
          t.variableDeclaration('var', [t.variableDeclarator(valTmp, t.cloneNode(innerParam))]),
          t.ifStatement(
            t.binaryExpression('===', valTmp, t.identifier('undefined')),
            t.blockStatement([
              t.expressionStatement(t.assignmentExpression('=', t.cloneNode(innerParam), param.right))
            ])
          )
        )
      } else {
        // Complex default: function({ x } = {}) → function(_p) { var _t = _p === undefined ? default : _p; desugar _t }
        params[i] = tmpId
        const valTmp = t.identifier(nextId())
        prependStatements.unshift(
          t.variableDeclaration('var', [t.variableDeclarator(valTmp, t.conditionalExpression(
            t.binaryExpression('===', t.cloneNode(tmpId), t.identifier('undefined')),
            param.right,
            t.cloneNode(tmpId)
          ))])
        )
        const stmts: t.Statement[] = []
        desugarPattern(innerParam as t.ObjectPattern | t.ArrayPattern, valTmp, 'var', stmts, nextId)
        prependStatements.push(...stmts)
      }
      continue
    }

    if (t.isObjectPattern(param) || t.isArrayPattern(param)) {
      params[i] = tmpId
      const stmts: t.Statement[] = []
      desugarPattern(param, tmpId, 'var', stmts, nextId)
      prependStatements.push(...stmts)
    }
  }
  body.unshift(...prependStatements)
}

function buildConcatArgs(elements: (t.Expression | t.SpreadElement)[]): t.Expression {
  const groups: t.Expression[] = []
  let currentArr: t.Expression[] = []
  for (const el of elements) {
    if (t.isSpreadElement(el)) {
      if (currentArr.length > 0) {
        groups.push(t.arrayExpression(currentArr))
        currentArr = []
      }
      // Use Array.from() so that custom iterables (Symbol.iterator) are
      // properly consumed. Plain concat() only handles arrays/primitives.
      groups.push(t.callExpression(
        t.memberExpression(t.identifier('Array'), t.identifier('from')),
        [el.argument]
      ))
    } else {
      currentArr.push(el)
    }
  }
  if (currentArr.length > 0) {
    groups.push(t.arrayExpression(currentArr))
  }
  if (groups.length === 0) return t.arrayExpression([])
  let result = groups[0]
  if (!t.isArrayExpression(result)) {
    result = t.callExpression(t.memberExpression(t.arrayExpression([]), t.identifier('concat')), [result])
  }
  for (let i = 1; i < groups.length; i++) {
    result = t.callExpression(t.memberExpression(result, t.identifier('concat')), [groups[i]])
  }
  return result
}

function getEnclosingBody(path: any): t.Statement[] {
  const functionPath = path.getFunctionParent()
  if (functionPath && 'body' in functionPath.node) {
    if (t.isBlockStatement((functionPath.node as any).body)) {
      return ((functionPath.node as any).body as t.BlockStatement).body
    }
    if (functionPath.isArrowFunctionExpression()) {
      ;(functionPath.node as t.ArrowFunctionExpression).body = t.blockStatement([
        t.returnStatement((functionPath.node as t.ArrowFunctionExpression).body as t.Expression),
      ])
      return ((functionPath.node as t.ArrowFunctionExpression).body as t.BlockStatement).body
    }
  }

  const programPath = path.scope.getProgramParent().path
  if (!programPath || !t.isProgram(programPath.node)) {
    throw new Error('Unable to declare temporary binding for normalized expression')
  }
  return programPath.node.body
}

function declareTempBindings(path: any, ids: t.Identifier[]) {
  if (ids.length === 0) return
  getEnclosingBody(path).unshift(
    t.variableDeclaration('var', ids.map((id) => t.variableDeclarator(t.cloneNode(id, true))))
  )
}

function toPropertyKeyExpression(key: t.Expression | t.Identifier, computed: boolean): t.Expression {
  if (computed) {
    return t.cloneNode(key as t.Expression, true)
  }
  if (t.isIdentifier(key)) {
    return t.stringLiteral(key.name)
  }
  return t.cloneNode(key as t.Expression, true)
}

function buildObjectDefinePropertyCall(target: t.Identifier, key: t.Expression, descriptor: t.ObjectExpression): t.Expression {
  return t.callExpression(
    t.memberExpression(t.identifier('Object'), t.identifier('defineProperty')),
    [t.cloneNode(target, true), key, descriptor]
  )
}

function buildObjectLiteralSequence(
  path: any,
  properties: (t.ObjectProperty | t.ObjectMethod | t.SpreadElement)[],
  nextId: () => string
): t.Expression {
  const target = t.identifier(nextId())
  const items: t.Expression[] = [
    t.assignmentExpression('=', t.cloneNode(target, true), t.objectExpression([])),
  ]

  for (const property of properties) {
    if (t.isSpreadElement(property)) {
      items.push(
        t.callExpression(
          t.memberExpression(t.identifier('Object'), t.identifier('assign')),
          [t.cloneNode(target, true), t.cloneNode(property.argument, true) as t.Expression]
        )
      )
      continue
    }

    const key = toPropertyKeyExpression(property.key as t.Expression | t.Identifier, property.computed)

    if (t.isObjectProperty(property)) {
      items.push(
        buildObjectDefinePropertyCall(
          target,
          key,
          t.objectExpression([
            t.objectProperty(t.identifier('value'), t.cloneNode(property.value, true) as t.Expression),
            t.objectProperty(t.identifier('writable'), t.booleanLiteral(true)),
            t.objectProperty(t.identifier('enumerable'), t.booleanLiteral(true)),
            t.objectProperty(t.identifier('configurable'), t.booleanLiteral(true)),
          ])
        )
      )
      continue
    }

    const fn = t.functionExpression(
      null,
      property.params as any,
      t.cloneNode(property.body, true),
      property.generator,
      property.async
    )
    const descriptorProps: t.ObjectProperty[] = []
    if (property.kind === 'method') {
      descriptorProps.push(t.objectProperty(t.identifier('value'), fn))
      descriptorProps.push(t.objectProperty(t.identifier('writable'), t.booleanLiteral(true)))
    } else if (property.kind === 'get') {
      descriptorProps.push(t.objectProperty(t.identifier('get'), fn))
    } else {
      descriptorProps.push(t.objectProperty(t.identifier('set'), fn))
    }
    descriptorProps.push(t.objectProperty(t.identifier('enumerable'), t.booleanLiteral(true)))
    descriptorProps.push(t.objectProperty(t.identifier('configurable'), t.booleanLiteral(true)))
    items.push(buildObjectDefinePropertyCall(target, key, t.objectExpression(descriptorProps)))
  }

  items.push(t.cloneNode(target, true))
  declareTempBindings(path, [target])
  return t.sequenceExpression(items)
}

type OptionalChainSegment =
  | { type: 'member'; optional: boolean; computed: boolean; property: t.Expression | t.Identifier }
  | { type: 'call'; optional: boolean; args: (t.Expression | t.SpreadElement)[] }

type OptionalChainState =
  | { type: 'value'; expr: t.Expression }
  | { type: 'member'; object: t.Expression; property: t.Expression | t.Identifier; computed: boolean }

function isOptionalChainRoot(path: any): boolean {
  const parent = path.parentPath
  if (!parent) return true
  if ((parent.isOptionalMemberExpression() || parent.isMemberExpression()) && parent.node.object === path.node) {
    return false
  }
  if ((parent.isOptionalCallExpression() || parent.isCallExpression()) && parent.node.callee === path.node) {
    return false
  }
  return true
}

function extractOptionalChain(node: t.Expression): { base: t.Expression; segments: OptionalChainSegment[] } {
  if (t.isOptionalMemberExpression(node) || t.isMemberExpression(node)) {
    const chain = extractOptionalChain(node.object as t.Expression)
    chain.segments.push({
      type: 'member',
      optional: t.isOptionalMemberExpression(node) ? node.optional : false,
      computed: node.computed,
      property: t.cloneNode(node.property as t.Expression | t.Identifier, true),
    })
    return chain
  }

  if (t.isOptionalCallExpression(node) || t.isCallExpression(node)) {
    const chain = extractOptionalChain(node.callee as t.Expression)
    chain.segments.push({
      type: 'call',
      optional: t.isOptionalCallExpression(node) ? node.optional : false,
      args: node.arguments.map((arg) => {
        if (!t.isExpression(arg) && !t.isSpreadElement(arg)) {
          throw new Error('Unsupported optional call argument in script-vm-next')
        }
        return t.cloneNode(arg, true) as t.Expression | t.SpreadElement
      }),
    })
    return chain
  }

  return { base: t.cloneNode(node, true), segments: [] }
}

function materializeOptionalChainState(state: OptionalChainState): t.Expression {
  if (state.type === 'value') {
    return t.cloneNode(state.expr, true)
  }
  return t.memberExpression(
    t.cloneNode(state.object, true),
    t.cloneNode(state.property as t.Expression | t.Identifier, true) as t.Expression | t.Identifier,
    state.computed
  )
}

function buildCallFromParts(
  callee: t.Expression,
  receiver: t.Expression | null,
  args: (t.Expression | t.SpreadElement)[]
): t.Expression {
  const clonedArgs = args.map((arg) => t.cloneNode(arg, true)) as (t.Expression | t.SpreadElement)[]
  if (clonedArgs.some((arg) => t.isSpreadElement(arg))) {
    return t.callExpression(
      t.memberExpression(callee, t.identifier('apply')),
      [receiver ? t.cloneNode(receiver, true) : t.identifier('undefined'), buildConcatArgs(clonedArgs)]
    )
  }
  if (receiver) {
    return t.callExpression(
      t.memberExpression(callee, t.identifier('call')),
      [t.cloneNode(receiver, true), ...(clonedArgs as t.Expression[])]
    )
  }
  return t.callExpression(callee, clonedArgs as any)
}

function buildCallFromState(state: OptionalChainState, args: (t.Expression | t.SpreadElement)[]): t.Expression {
  if (state.type === 'member') {
    if (!args.some((arg) => t.isSpreadElement(arg))) {
      return t.callExpression(
        t.memberExpression(
          t.cloneNode(state.object, true),
          t.cloneNode(state.property as t.Expression | t.Identifier, true) as t.Expression | t.Identifier,
          state.computed
        ),
        args.map((arg) => t.cloneNode(arg, true)) as any
      )
    }
    return buildCallFromParts(materializeOptionalChainState(state), state.object, args)
  }
  if (!args.some((arg) => t.isSpreadElement(arg))) {
    return t.callExpression(t.cloneNode(state.expr, true), args.map((arg) => t.cloneNode(arg, true)) as any)
  }
  return buildCallFromParts(t.cloneNode(state.expr, true), null, args)
}

function desugarOptionalChain(path: any, nextId: () => string): t.Expression {
  const temps: t.Identifier[] = []
  const makeTemp = () => {
    const id = t.identifier(nextId())
    temps.push(id)
    return id
  }

  const { base, segments } = extractOptionalChain(path.node as t.Expression)

  const build = (index: number, state: OptionalChainState): t.Expression => {
    if (index >= segments.length) {
      return materializeOptionalChainState(state)
    }

    const segment = segments[index]
    if (segment.type === 'member') {
      if (!segment.optional) {
        return build(index + 1, {
          type: 'member',
          object: materializeOptionalChainState(state),
          property: segment.property,
          computed: segment.computed,
        })
      }

      const baseTemp = makeTemp()
      return t.sequenceExpression([
        t.assignmentExpression('=', baseTemp, materializeOptionalChainState(state)),
        t.conditionalExpression(
          t.binaryExpression('==', t.cloneNode(baseTemp, true), t.nullLiteral()),
          t.identifier('undefined'),
          build(index + 1, {
            type: 'member',
            object: t.cloneNode(baseTemp, true),
            property: segment.property,
            computed: segment.computed,
          })
        ),
      ])
    }

    if (!segment.optional) {
      return build(index + 1, { type: 'value', expr: buildCallFromState(state, segment.args) })
    }

    if (state.type === 'member') {
      const objectTemp = makeTemp()
      const calleeTemp = makeTemp()
      return t.sequenceExpression([
        t.assignmentExpression('=', objectTemp, t.cloneNode(state.object, true)),
        t.assignmentExpression(
          '=',
          calleeTemp,
          t.memberExpression(
            t.cloneNode(objectTemp, true),
            t.cloneNode(state.property as t.Expression | t.Identifier, true) as t.Expression | t.Identifier,
            state.computed
          )
        ),
        t.conditionalExpression(
          t.binaryExpression('==', t.cloneNode(calleeTemp, true), t.nullLiteral()),
          t.identifier('undefined'),
          build(index + 1, {
            type: 'value',
            expr: buildCallFromParts(t.cloneNode(calleeTemp, true), t.cloneNode(objectTemp, true), segment.args),
          })
        ),
      ])
    }

    const calleeTemp = makeTemp()
    return t.sequenceExpression([
      t.assignmentExpression('=', calleeTemp, t.cloneNode(state.expr, true)),
      t.conditionalExpression(
        t.binaryExpression('==', t.cloneNode(calleeTemp, true), t.nullLiteral()),
        t.identifier('undefined'),
        build(index + 1, {
          type: 'value',
          expr: buildCallFromParts(t.cloneNode(calleeTemp, true), null, segment.args),
        })
      ),
    ])
  }

  const result = build(0, { type: 'value', expr: base })
  declareTempBindings(path, temps)
  return result
}

export function normalizeAst(file: t.File): t.File {
  // Pass 1: Desugar destructuring, spread/rest, for-of/for-in/for-await-of, object methods, optional chaining, function params
  let desugarCounter = 0
  const nextId = () => `_d${desugarCounter++}`

  traverse(file, {
    FunctionDeclaration(path) {
      if (path.node.params.some((p: any) => !t.isIdentifier(p))) {
        desugarFunctionParams(path.node.params as any, path.node.body.body, nextId)
      }
    },
    FunctionExpression(path) {
      if (path.node.params.some((p: any) => !t.isIdentifier(p))) {
        desugarFunctionParams(path.node.params as any, path.node.body.body, nextId)
      }
    },
    ObjectMethod(path) {
      if (path.node.params.some((p: any) => !t.isIdentifier(p))) {
        desugarFunctionParams(path.node.params as any, path.node.body.body, nextId)
      }
    },
    ClassMethod(path) {
      if (path.node.params.some((p: any) => !t.isIdentifier(p))) {
        desugarFunctionParams(path.node.params as any, path.node.body.body, nextId)
      }
    },
    BigIntLiteral(path: any) {
      // Desugar 123n → BigInt("123") to avoid constant pool JSON serialization issues
      path.replaceWith(
        t.callExpression(t.identifier('BigInt'), [t.stringLiteral(path.node.value)])
      )
    },
    TaggedTemplateExpression(path: any) {
      const node = path.node as t.TaggedTemplateExpression
      const quasis = node.quasi.quasis
      const cookedElements = quasis.map((q: t.TemplateElement) =>
        q.value.cooked != null ? t.stringLiteral(q.value.cooked) : t.identifier('undefined')
      )
      const rawElements = quasis.map((q: t.TemplateElement) =>
        t.stringLiteral(q.value.raw)
      )
      const stringsArg = t.callExpression(
        t.memberExpression(t.identifier('Object'), t.identifier('assign')),
        [
          t.arrayExpression(cookedElements),
          t.objectExpression([
            t.objectProperty(t.identifier('raw'), t.arrayExpression(rawElements)),
          ]),
        ]
      )
      path.replaceWith(
        t.callExpression(node.tag, [stringsArg, ...(node.quasi.expressions as t.Expression[])])
      )
    },
    VariableDeclaration(path) {
      const newStatements: t.Statement[] = []
      let modified = false
      for (const declarator of path.node.declarations) {
        if (t.isObjectPattern(declarator.id) || t.isArrayPattern(declarator.id)) {
          modified = true
          const tempId = t.identifier(nextId())
          newStatements.push(t.variableDeclaration('var', [t.variableDeclarator(tempId, declarator.init)]))
          desugarPattern(declarator.id, tempId, path.node.kind as 'var' | 'let' | 'const', newStatements, nextId)
        } else {
          newStatements.push(t.variableDeclaration(path.node.kind, [t.cloneNode(declarator, false)]))
        }
      }
      if (modified) {
        path.replaceWithMultiple(newStatements)
      }
    },

    'FunctionDeclaration|FunctionExpression'(path: any) {
      const node = path.node as t.FunctionDeclaration | t.FunctionExpression
      const bodyInserts: t.Statement[] = []
      let modified = false
      const newParams: t.Node[] = []
      for (let i = 0; i < node.params.length; i++) {
        const param = node.params[i]
        if (t.isObjectPattern(param) || t.isArrayPattern(param)) {
          modified = true
          const tempId = t.identifier(nextId())
          newParams.push(tempId)
          desugarPattern(param, tempId, 'var', bodyInserts, nextId)
        } else if (t.isRestElement(param)) {
          modified = true
          const restName = (param.argument as t.Identifier).name
          newParams.push(t.identifier(nextId())) // dummy param
          bodyInserts.push(t.variableDeclaration('var', [t.variableDeclarator(
            t.identifier(restName),
            t.callExpression(
              t.memberExpression(
                t.memberExpression(
                  t.memberExpression(t.identifier('Array'), t.identifier('prototype')),
                  t.identifier('slice')
                ),
                t.identifier('call')
              ),
              [t.identifier('arguments'), t.numericLiteral(i)]
            )
          )]))
        } else if (t.isAssignmentPattern(param)) {
          modified = true
          const paramName = (param.left as t.Identifier).name
          const tempId = t.identifier(nextId())
          newParams.push(tempId)
          bodyInserts.push(t.variableDeclaration('var', [t.variableDeclarator(
            t.identifier(paramName),
            t.conditionalExpression(
              t.binaryExpression('!==', tempId, t.identifier('undefined')),
              tempId,
              param.right
            )
          )]))
        } else {
          newParams.push(param)
        }
      }
      if (modified) {
        node.params = newParams as any
        if (t.isBlockStatement(node.body)) {
          node.body.body.unshift(...bodyInserts)
        }
      }
    },

    AssignmentExpression(path) {
      if (t.isObjectPattern(path.node.left) || t.isArrayPattern(path.node.left)) {
        const statements: t.Statement[] = []
        const tempId = t.identifier(nextId())
        statements.push(t.variableDeclaration('var', [t.variableDeclarator(tempId, path.node.right)]))
        desugarAssignmentPattern(path.node.left as t.ObjectPattern | t.ArrayPattern, tempId, statements, nextId)
        if (path.parentPath.isExpressionStatement()) {
          path.parentPath.replaceWithMultiple(statements)
        }
      }
    },

    CallExpression(path) {
      if (t.isImport(path.node.callee)) {
        path.node.callee = t.identifier('__vm_import')
        return
      }
      if (!path.node.arguments.some(arg => t.isSpreadElement(arg))) return
      const callee = path.node.callee
      if (t.isMemberExpression(callee)) {
        const objTmp = t.identifier(nextId())
        const argsExpr = buildConcatArgs(path.node.arguments as (t.Expression | t.SpreadElement)[])
        // obj.method(...args) → (_o = obj, _o.method.apply(_o, args))
        path.replaceWith(
          t.sequenceExpression([
            t.assignmentExpression('=', objTmp, callee.object as t.Expression),
            t.callExpression(
              t.memberExpression(
                t.memberExpression(objTmp, callee.property, callee.computed),
                t.identifier('apply')
              ),
              [objTmp, argsExpr]
            )
          ])
        )
        // Declare the temp var in the enclosing scope
        const fnPath = path.getFunctionParent() || path.scope.getProgramParent().path
        if (fnPath && t.isProgram((fnPath.node as any))) {
          (fnPath.node as t.Program).body.unshift(t.variableDeclaration('var', [t.variableDeclarator(objTmp)]))
        } else if (fnPath && (t.isFunctionDeclaration(fnPath.node) || t.isFunctionExpression(fnPath.node))) {
          (fnPath.node.body as t.BlockStatement).body.unshift(t.variableDeclaration('var', [t.variableDeclarator(objTmp)]))
        }
        path.skip()
      } else {
        const argsExpr = buildConcatArgs(path.node.arguments as (t.Expression | t.SpreadElement)[])
        path.replaceWith(
          t.callExpression(
            t.memberExpression(callee as t.Expression, t.identifier('apply')),
            [t.identifier('undefined'), argsExpr]
          )
        )
        path.skip()
      }
    },

    NewExpression(path) {
      if (!path.node.arguments.some(arg => t.isSpreadElement(arg))) return
      const argsExpr = buildConcatArgs(path.node.arguments as (t.Expression | t.SpreadElement)[])
      path.replaceWith(
        t.callExpression(
          t.memberExpression(t.identifier('Reflect'), t.identifier('construct')),
          [path.node.callee as t.Expression, argsExpr]
        )
      )
      path.skip()
    },

    ArrayExpression(path) {
      if (!path.node.elements.some(el => t.isSpreadElement(el))) return
      const result = buildConcatArgs(path.node.elements as (t.Expression | t.SpreadElement)[])
      path.replaceWith(result)
      path.skip()
    },

    ObjectExpression(path) {
      const hasSpread = path.node.properties.some(prop => t.isSpreadElement(prop))
      const hasMethods = path.node.properties.some(prop => t.isObjectMethod(prop))
      if (!hasSpread && !hasMethods) return

      if (hasMethods) {
        path.replaceWith(buildObjectLiteralSequence(path, path.node.properties, nextId))
        path.skip()
        return
      }

      const assignArgs: t.Expression[] = [t.objectExpression([])]
      let currentProps: t.ObjectProperty[] = []
      for (const prop of path.node.properties) {
        if (t.isSpreadElement(prop)) {
          if (currentProps.length > 0) {
            assignArgs.push(t.objectExpression(currentProps))
            currentProps = []
          }
          assignArgs.push(prop.argument)
        } else {
          currentProps.push(prop as t.ObjectProperty)
        }
      }
      if (currentProps.length > 0) {
        assignArgs.push(t.objectExpression(currentProps))
      }
      path.replaceWith(
        t.callExpression(
          t.memberExpression(t.identifier('Object'), t.identifier('assign')),
          assignArgs
        )
      )
      path.skip()
    },

    OptionalMemberExpression(path) {
      if (!isOptionalChainRoot(path)) return
      path.replaceWith(desugarOptionalChain(path, nextId))
      path.skip()
    },

    OptionalCallExpression(path) {
      if (!isOptionalChainRoot(path)) return
      path.replaceWith(desugarOptionalChain(path, nextId))
      path.skip()
    },

    ForOfStatement(path) {
      const iterTmp = t.identifier(nextId())
      const resultTmp = t.identifier(nextId())
      const isAwait = (path.node as any).await

      const iteratorMethod = isAwait
        ? t.memberExpression(t.identifier('Symbol'), t.identifier('asyncIterator'))
        : t.memberExpression(t.identifier('Symbol'), t.identifier('iterator'))

      const iteratorExpr = t.callExpression(
        t.memberExpression(path.node.right, iteratorMethod, true),
        []
      )

      const nextCall: t.Expression = isAwait
        ? t.awaitExpression(t.callExpression(t.memberExpression(iterTmp, t.identifier('next')), []))
        : t.callExpression(t.memberExpression(iterTmp, t.identifier('next')), [])

      let loopVarDecl: t.Statement
      if (t.isVariableDeclaration(path.node.left)) {
        const decl = path.node.left.declarations[0]
        loopVarDecl = t.variableDeclaration(path.node.left.kind, [
          t.variableDeclarator(decl.id, t.memberExpression(resultTmp, t.identifier('value')))
        ])
      } else {
        loopVarDecl = t.expressionStatement(
          t.assignmentExpression('=', path.node.left as t.LVal, t.memberExpression(resultTmp, t.identifier('value')))
        )
      }

      const bodyStatements = t.isBlockStatement(path.node.body)
        ? [...path.node.body.body]
        : [path.node.body]

      const nextCallUpdate: t.Expression = isAwait
        ? t.awaitExpression(t.callExpression(t.memberExpression(t.cloneNode(iterTmp), t.identifier('next')), []))
        : t.callExpression(t.memberExpression(t.cloneNode(iterTmp), t.identifier('next')), [])

      const whileBody = t.blockStatement([
        loopVarDecl,
        ...bodyStatements,
        t.expressionStatement(t.assignmentExpression('=', t.cloneNode(resultTmp), nextCallUpdate))
      ])

      const whileStatement = t.whileStatement(
        t.unaryExpression('!', t.memberExpression(resultTmp, t.identifier('done'))),
        whileBody
      )

      // Build finally block: if (_step && !_step.done && typeof _iter.return === 'function') _iter.return()
      const returnMethodCheck = t.binaryExpression('===',
        t.unaryExpression('typeof', t.memberExpression(t.cloneNode(iterTmp), t.identifier('return'))),
        t.stringLiteral('function')
      )
      const finallyGuard = t.logicalExpression('&&',
        t.logicalExpression('&&',
          t.cloneNode(resultTmp),
          t.unaryExpression('!', t.memberExpression(t.cloneNode(resultTmp), t.identifier('done')))
        ),
        returnMethodCheck
      )
      const returnCall: t.Expression = isAwait
        ? t.awaitExpression(t.callExpression(t.memberExpression(t.cloneNode(iterTmp), t.identifier('return')), []))
        : t.callExpression(t.memberExpression(t.cloneNode(iterTmp), t.identifier('return')), [])
      const finallyBlock = t.blockStatement([
        t.ifStatement(finallyGuard, t.blockStatement([
          t.expressionStatement(returnCall)
        ]))
      ])

      const tryFinally = t.tryStatement(
        t.blockStatement([whileStatement]),
        null,
        finallyBlock
      )

      const replacement: t.Statement[] = [
        t.variableDeclaration('var', [t.variableDeclarator(iterTmp, iteratorExpr)]),
        t.variableDeclaration('var', [t.variableDeclarator(resultTmp, nextCall)]),
        tryFinally,
      ]

      path.replaceWithMultiple(replacement)
    },

    ForInStatement(path) {
      const keysTmp = t.identifier(nextId())
      const iTmp = t.identifier(nextId())

      const keysExpr = t.callExpression(
        t.memberExpression(t.identifier('Object'), t.identifier('keys')),
        [path.node.right]
      )

      let loopVarDecl: t.Statement
      if (t.isVariableDeclaration(path.node.left)) {
        const decl = path.node.left.declarations[0]
        loopVarDecl = t.variableDeclaration(path.node.left.kind, [
          t.variableDeclarator(decl.id, t.memberExpression(keysTmp, iTmp, true))
        ])
      } else {
        loopVarDecl = t.expressionStatement(
          t.assignmentExpression('=', path.node.left as t.LVal, t.memberExpression(keysTmp, iTmp, true))
        )
      }

      const bodyStatements = t.isBlockStatement(path.node.body)
        ? [...path.node.body.body]
        : [path.node.body]

      path.replaceWithMultiple([
        t.variableDeclaration('var', [t.variableDeclarator(keysTmp, keysExpr)]),
        t.forStatement(
          t.variableDeclaration('var', [t.variableDeclarator(iTmp, t.numericLiteral(0))]),
          t.binaryExpression('<', iTmp, t.memberExpression(keysTmp, t.identifier('length'))),
          t.updateExpression('++', iTmp),
          t.blockStatement([loopVarDecl, ...bodyStatements])
        ),
      ])
    },
  })

  // Pass 2: Normalize arrows, classes, catch clause renaming
  let catchCounter = 0
  const arrowCaptures = new WeakMap<t.Node, { thisId?: t.Identifier; argsId?: t.Identifier; newTargetId?: t.Identifier }>()

  const skipNonArrowVisitors = {
    FunctionDeclaration(p: any) { p.skip() },
    FunctionExpression(p: any) { p.skip() },
    ObjectMethod(p: any) { p.skip() },
    ClassMethod(p: any) { p.skip() },
  }

  traverse(file, {
    ArrowFunctionExpression(path) {
      const { node } = path

      // Detect this/arguments/new.target usage in arrow body (skip nested non-arrow functions)
      let usesThis = false
      let usesArguments = false
      let usesNewTarget = false
      path.traverse({
        ...skipNonArrowVisitors,
        // Skip nested arrows — they will be processed separately and will
        // capture from their own enclosing scope
        ArrowFunctionExpression(p: any) { p.skip() },
        ThisExpression() { usesThis = true },
        Identifier(innerPath: any) {
          if (innerPath.node.name === 'arguments') {
            usesArguments = true
          }
        },
        MetaProperty(innerPath: any) {
          if (innerPath.node.meta.name === 'new' && innerPath.node.property.name === 'target') {
            usesNewTarget = true
          }
        },
      })

      if (usesThis || usesArguments || usesNewTarget) {
        const enclosing = path.findParent((p: any) =>
          p.isFunctionDeclaration() || p.isFunctionExpression() || p.isProgram()
        )

        if (enclosing) {
          const enclosingNode = enclosing.node
          let captures = arrowCaptures.get(enclosingNode)
          if (!captures) {
            captures = {}
            arrowCaptures.set(enclosingNode, captures)
          }

          const getBody = (n: t.Node): t.Statement[] => {
            if (t.isProgram(n)) return n.body as t.Statement[]
            return (n as any).body.body
          }

          if (usesThis && !captures.thisId) {
            captures.thisId = t.identifier(`_this${catchCounter++}`)
            getBody(enclosingNode).unshift(
              t.variableDeclaration('var', [
                t.variableDeclarator(t.cloneNode(captures.thisId, true), t.thisExpression())
              ])
            )
          }

          if (usesArguments && !captures.argsId) {
            captures.argsId = t.identifier(`_arguments${catchCounter++}`)
            getBody(enclosingNode).unshift(
              t.variableDeclaration('var', [
                t.variableDeclarator(t.cloneNode(captures.argsId, true), t.identifier('arguments'))
              ])
            )
          }

          if (usesNewTarget && !captures.newTargetId) {
            captures.newTargetId = t.identifier(`_newTarget${catchCounter++}`)
            getBody(enclosingNode).unshift(
              t.variableDeclaration('var', [
                t.variableDeclarator(
                  t.cloneNode(captures.newTargetId, true),
                  t.metaProperty(t.identifier('new'), t.identifier('target'))
                )
              ])
            )
          }

          // Replace this/arguments/new.target references in the arrow body
          if (usesThis && captures.thisId) {
            path.traverse({
              ...skipNonArrowVisitors,
              ArrowFunctionExpression(p: any) { p.skip() },
              ThisExpression(innerPath: any) {
                innerPath.replaceWith(t.cloneNode(captures!.thisId!, true))
              },
            })
          }

          if (usesArguments && captures.argsId) {
            path.traverse({
              ...skipNonArrowVisitors,
              ArrowFunctionExpression(p: any) { p.skip() },
              Identifier(innerPath: any) {
                if (innerPath.node.name === 'arguments') {
                  innerPath.replaceWith(t.cloneNode(captures!.argsId!, true))
                }
              },
            })
          }

          if (usesNewTarget && captures.newTargetId) {
            path.traverse({
              ...skipNonArrowVisitors,
              ArrowFunctionExpression(p: any) { p.skip() },
              MetaProperty(innerPath: any) {
                if (innerPath.node.meta.name === 'new' && innerPath.node.property.name === 'target') {
                  innerPath.replaceWith(t.cloneNode(captures!.newTargetId!, true))
                }
              },
            })
          }
        }
      }

      // Convert arrow → FunctionExpression
      const body = t.isBlockStatement(node.body)
        ? node.body
        : t.blockStatement([t.returnStatement(node.body as t.Expression)])

      path.replaceWith(
        t.functionExpression(
          null,
          node.params as any,
          body,
          false,
          node.async
        )
      )

      // Desugar non-identifier params (destructuring, rest, defaults) on the
      // newly created FunctionExpression. This must happen AFTER conversion so
      // that rest-param desugaring (which uses `arguments`) references the
      // FunctionExpression's own arguments, not the outer scope's.
      const newNode = path.node as unknown as t.FunctionExpression
      if (newNode.params.some((p: any) => !t.isIdentifier(p))) {
        desugarFunctionParams(newNode.params as any, (newNode.body as t.BlockStatement).body, nextId)
      }
    },
    CatchClause(path) {
      if (path.node.param && t.isIdentifier(path.node.param)) {
        const nextName = `__catch_${path.node.param.name}_${catchCounter++}`
        path.scope.rename(path.node.param.name, nextName)
      }
    },
    ClassDeclaration(path) {
      const node = path.node
      const className = node.id ? node.id.name : '_AnonymousClass'
      const classId = t.identifier(className)
      path.replaceWith(
        t.variableDeclaration('var', [t.variableDeclarator(classId, buildClassIife(node, classId))])
      )
    },
    ClassExpression(path) {
      const node = path.node
      const className = node.id ? node.id.name : '_AnonymousClass'
      const classId = t.identifier(className)
      path.replaceWith(buildClassIife(node, classId))
    },
  })

  return file
}

export function resolveFormat(sourceFile: string, sourceCode: string, format?: string): ModuleFormat {
  if (format && format !== 'auto') {
    return format as ModuleFormat
  }
  return detectModuleFormat(sourceFile, sourceCode)
}
