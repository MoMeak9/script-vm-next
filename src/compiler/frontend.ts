import * as parser from '@babel/parser'
import traverseModule from '@babel/traverse'
import * as t from '@babel/types'
import { normalizeFunctionParameters } from './parameter-normalization'
import { inferFunctionNames } from './named-evaluation'

// Babel publishes CommonJS. Native ESM and browser bundlers may expose its
// callable default one level below the module's default export.
const traverse: typeof traverseModule = typeof traverseModule === 'function'
  ? traverseModule
  : (traverseModule as unknown as { default: typeof traverseModule }).default

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

export function parseSource(source: string, sourceType: 'module' | 'script' | 'unambiguous'): t.File {
  return parser.parse(source, {
    sourceType,
    plugins: PARSER_PLUGINS,
  })
}

function classLocal(name: string): t.Identifier {
  return t.identifier(`@script-vm/class/${name}`)
}

function strictClassBody(statements: t.Statement[]): t.BlockStatement {
  return t.blockStatement(statements, [t.directive(t.directiveLiteral('use strict'))])
}

function classHelper(source: string, names: string[]): t.Statement[] {
  const ast = parseSource(source, 'script')
  traverse(ast, {
    Identifier(path) {
      if (names.includes(path.node.name)) path.node.name = classLocal(path.node.name).name
      else if (['Object', 'Reflect', 'ReferenceError', 'TypeError', 'PropertyKey'].includes(path.node.name)) {
        path.node.name = classIntrinsic(path.node.name as 'Object').name
      }
    },
  })
  return ast.program.body as t.Statement[]
}

function transformSuperCalls(
  bodyStatements: t.Statement[],
  classId: t.Identifier,
  isStatic = false,
  derivedConstructor = false
) {
  const ast = t.file(
    t.program([
      t.functionDeclaration(t.identifier('_tmp'), [], t.blockStatement(bodyStatements)),
    ])
  )

  const root = ast.program.body[0]
  const receiver = () => derivedConstructor
    ? t.callExpression(classLocal('getThis'), [])
    : t.thisExpression()
  const home = () => isStatic ? t.cloneNode(classId) : t.memberExpression(t.cloneNode(classId), t.identifier('prototype'))
  const superRef = (member: t.MemberExpression) => t.memberExpression(
    t.callExpression(classLocal('superRef'), [
      home(), member.computed ? member.property as t.Expression
        : t.stringLiteral((member.property as t.Identifier).name), receiver(),
    ]),
    t.identifier('value')
  )

  traverse(ast, {
    Function(path) {
      if (path.node !== root && !path.isArrowFunctionExpression()) path.skip()
    },
    Class(path) { path.skip() },
    CallExpression: { exit(path) {
      const callee = path.node.callee
      if (t.isSuper(callee)) {
        path.replaceWith(
          t.callExpression(classLocal('initThis'), [t.callExpression(
            t.memberExpression(classIntrinsic('Reflect'), t.identifier('construct')),
            [classLocal('super'), buildConcatArgs(path.node.arguments as (t.Expression | t.SpreadElement)[]),
              t.metaProperty(t.identifier('new'), t.identifier('target'))]
          )])
        )
        path.skip()
        return
      }

      if (t.isMemberExpression(callee) && t.isSuper(callee.object)) {
        path.replaceWith(
          t.callExpression(
            t.memberExpression(classIntrinsic('Reflect'), t.identifier('apply')),
            [superRef(callee), receiver(), buildConcatArgs(path.node.arguments as (t.Expression | t.SpreadElement)[])]
          )
        )
        path.skip()
      }
    } },
    MemberExpression: { exit(path) {
      if (t.isSuper(path.node.object) && !path.parentPath.isCallExpression({ callee: path.node })) {
        path.replaceWith(superRef(path.node))
        path.skip()
      }
    } },
    ThisExpression(path) {
      if (!derivedConstructor) return
      path.replaceWith(receiver())
      path.skip()
    },
    ReturnStatement: { exit(path) {
      if (!derivedConstructor || path.getFunctionParent()?.node !== root) return
      // Validate the final completion only after finally clauses have run.
      path.replaceWith(t.blockStatement([
        t.expressionStatement(t.assignmentExpression('=', classLocal('returnValue'), path.node.argument ?? t.unaryExpression('void', t.numericLiteral(0)))),
        t.breakStatement(classLocal('return')),
      ]))
      path.skip()
    } },
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

// Reserved names are injected after parsing and cannot be declared by source
// code. LOAD_GLOBAL resolves them to VM-private host intrinsics, so class
// helpers do not accidentally capture a user's Object/WeakMap/etc. binding.
function classIntrinsic(name: 'Object' | 'WeakMap' | 'WeakSet' | 'TypeError' | 'ReferenceError' | 'Reflect' | 'PropertyKey' | 'Proxy'): t.Identifier {
  return t.identifier(`@script-vm/intrinsic/${name}`)
}

function createPrivateReferenceHelper(kind: 'Field' | 'Accessor'): t.FunctionDeclaration {
  const field = kind === 'Field'
  const args = field ? ['map', 'receiver'] : ['receiver', 'brand', 'getter', 'setter']
  const getArgs = field ? ['map', 'receiver'] : ['receiver', 'brand', 'getter']
  const setArgs = field ? ['map', 'receiver', 'value'] : ['receiver', 'brand', 'setter', 'value']
  return t.functionDeclaration(
    classLocal(`private${kind}Ref`),
    args.map(name => t.identifier(name)),
    t.blockStatement([
      t.returnStatement(t.callExpression(
        t.memberExpression(classIntrinsic('Object'), t.identifier('defineProperty')),
        [t.objectExpression([]), t.stringLiteral('value'), t.objectExpression([
          t.objectProperty(t.identifier('get'), t.functionExpression(null, [], t.blockStatement([
            t.returnStatement(t.callExpression(classLocal(`private${kind}Get`), getArgs.map(name => t.identifier(name)))),
          ]))),
          t.objectProperty(t.identifier('set'), t.functionExpression(null, [t.identifier('value')], t.blockStatement([
            t.expressionStatement(t.callExpression(classLocal(`private${kind}Set`), setArgs.map(name => t.identifier(name)))),
          ]))),
        ])]
      )),
    ])
  )
}

function createPrivateHelpers(): t.Statement[] {
  return [
    createPrivateReferenceHelper('Field'),
    createPrivateReferenceHelper('Accessor'),
    t.functionDeclaration(
      classLocal('privateFieldGet'),
      [t.identifier('map'), t.identifier('receiver')],
      t.blockStatement([
        t.ifStatement(
          t.unaryExpression('!', t.callExpression(
            t.memberExpression(t.identifier('map'), t.identifier('has')),
            [t.identifier('receiver')]
          )),
          t.blockStatement([
            t.throwStatement(
              t.newExpression(classIntrinsic('TypeError'), [t.stringLiteral('Cannot read private member from an object whose class did not declare it')])
            ),
          ])
        ),
        t.returnStatement(
          t.callExpression(t.memberExpression(t.identifier('map'), t.identifier('get')), [t.identifier('receiver')])
        ),
      ])
    ),
    t.functionDeclaration(
      classLocal('privateFieldSet'),
      [t.identifier('map'), t.identifier('receiver'), t.identifier('value')],
      t.blockStatement([
        t.ifStatement(
          t.unaryExpression('!', t.callExpression(
            t.memberExpression(t.identifier('map'), t.identifier('has')),
            [t.identifier('receiver')]
          )),
          t.blockStatement([
            t.throwStatement(
              t.newExpression(classIntrinsic('TypeError'), [t.stringLiteral('Cannot write private member to an object whose class did not declare it')])
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
      classLocal('privateFieldInit'),
      [t.identifier('map'), t.identifier('receiver'), t.identifier('value')],
      t.blockStatement([
        t.ifStatement(
          t.callExpression(
            t.memberExpression(t.identifier('map'), t.identifier('has')),
            [t.identifier('receiver')]
          ),
          t.blockStatement([
            t.throwStatement(
              t.newExpression(classIntrinsic('TypeError'), [t.stringLiteral('Cannot initialize the same private elements twice on an object')])
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
      classLocal('privateMethod'),
      [t.identifier('receiver'), t.identifier('brand'), t.identifier('fn')],
      t.blockStatement([
        t.ifStatement(
          t.unaryExpression('!', t.callExpression(
            t.memberExpression(t.identifier('brand'), t.identifier('has')),
            [t.identifier('receiver')]
          )),
          t.blockStatement([
            t.throwStatement(
              t.newExpression(classIntrinsic('TypeError'), [t.stringLiteral('Cannot access private method on an object whose class did not declare it')])
            ),
          ])
        ),
        t.returnStatement(t.identifier('fn')),
      ])
    ),
    t.functionDeclaration(
      classLocal('privateAccessorGet'),
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
              t.newExpression(classIntrinsic('TypeError'), [t.stringLiteral('Cannot access private accessor on an object whose class did not declare it')])
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
      classLocal('privateAccessorSet'),
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
              t.newExpression(classIntrinsic('TypeError'), [t.stringLiteral('Cannot access private accessor on an object whose class did not declare it')])
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

// Keep assignment/update nodes intact so ordinary lowering owns operator semantics.
// The reference helpers capture the receiver once and defer brand/accessor checks
// until GetValue/PutValue, including after the RHS for a simple assignment.
function privateWriteReference(descriptor: PrivateDescriptor, receiver: t.Expression): t.MemberExpression {
  const reference = descriptor.kind === 'accessor'
    ? t.callExpression(classLocal('privateAccessorRef'), [
        receiver,
        descriptor.brandId!,
        descriptor.getterId ?? t.unaryExpression('void', t.numericLiteral(0)),
        descriptor.setterId ?? t.unaryExpression('void', t.numericLiteral(0)),
      ])
    : t.callExpression(classLocal('privateFieldRef'), [descriptor.storageId, receiver])
  return t.memberExpression(reference, t.identifier('value'))
}

function transformPrivateAst(ast: t.File, descriptors: Map<string, PrivateDescriptor>) {
  traverse(ast, {
    UpdateExpression(path) {
      const argument = path.node.argument
      if (!t.isMemberExpression(argument) || !t.isPrivateName(argument.property)) return
      const descriptor = descriptors.get(argument.property.id.name)
      if (!descriptor || descriptor.kind === 'method') return
      path.node.argument = privateWriteReference(descriptor, argument.object as t.Expression)
    },
    AssignmentExpression(path) {
      const left = path.node.left
      if (!t.isMemberExpression(left) || !t.isPrivateName(left.property)) return
      const descriptor = descriptors.get(left.property.id.name)
      if (!descriptor || descriptor.kind === 'method') return
      path.node.left = privateWriteReference(descriptor, left.object as t.Expression)
    },
    CallExpression: {
      exit(path) {
        const callee = path.node.callee
        if (!t.isMemberExpression(callee) || !t.isPrivateName(callee.property)) return
        const descriptor = descriptors.get(callee.property.id.name)
        if (!descriptor || descriptor.kind !== 'method') return
        const receiver = callee.object as t.Expression
        path.replaceWith(
          t.callExpression(
            t.memberExpression(
              descriptor.static
                ? descriptor.storageId
                : t.callExpression(classLocal('privateMethod'), [receiver, descriptor.brandId!, descriptor.implId!]),
              t.identifier('call')
            ),
            [t.cloneNode(receiver, true), ...path.node.arguments]
          )
        )
        path.skip()
      },
    },
    MemberExpression: {
      exit(path) {
        if (!t.isPrivateName(path.node.property)) return
        if (path.parentPath.isCallExpression({ callee: path.node })) return
        const descriptor = descriptors.get(path.node.property.id.name)
        if (!descriptor) return
        const receiver = path.node.object as t.Expression
        if (descriptor.kind === 'accessor') {
          path.replaceWith(t.callExpression(classLocal('privateAccessorGet'), [
            receiver,
            descriptor.brandId!,
            descriptor.getterId ?? t.unaryExpression('void', t.numericLiteral(0)),
          ]))
        } else if (descriptor.kind === 'field') {
          path.replaceWith(t.callExpression(classLocal('privateFieldGet'), [descriptor.storageId, receiver]))
        } else {
          path.replaceWith(
            descriptor.static
              ? descriptor.storageId
              : t.callExpression(
                  t.memberExpression(
                    t.callExpression(classLocal('privateMethod'), [receiver, descriptor.brandId!, descriptor.implId!]),
                    t.identifier('bind')
                  ),
                  [t.cloneNode(receiver, true)]
                )
          )
        }
        path.skip()
      },
    },
  })
}

function transformPrivateReferences(targetNode: t.Node, descriptors: Map<string, PrivateDescriptor>, _classId: t.Identifier) {
  const ast = t.file(t.program([t.expressionStatement(targetNode as t.Expression)]))
  transformPrivateAst(ast, descriptors)
  return (ast.program.body[0] as t.ExpressionStatement).expression
}

function transformPrivateBody(bodyStatements: t.Statement[], descriptors: Map<string, PrivateDescriptor>, _classId: t.Identifier) {
  const ast = t.file(t.program([
    t.functionDeclaration(t.identifier('_tmp_private'), [], t.blockStatement(bodyStatements)),
  ]))
  transformPrivateAst(ast, descriptors)
  const transformed = [...(ast.program.body[0] as t.FunctionDeclaration).body.body]
  bodyStatements.length = 0
  bodyStatements.push(...transformed)
}

function buildClassIife(node: t.ClassDeclaration | t.ClassExpression, classId: t.Identifier): t.Expression {
  const sourceClassId = classId
  classId = classLocal('constructor')
  const superClass = node.superClass
  const body = node.body.body
  const statements: t.Statement[] = []
  const superParam = superClass ? classLocal('super') : null
  const methodInitializers: t.Statement[] = []
  const privateDescriptors = new Map<string, PrivateDescriptor>()
  const helperStatements = createPrivateHelpers()
  helperStatements.push(...classHelper(`
    function superRef(home, key, receiver) {
      key = PropertyKey(key);
      var base = Object.getPrototypeOf(home);
      return Object.defineProperty({}, 'value', {
        get: function () { return Reflect.get(base, key, receiver); },
        set: function (value) {
          if (!Reflect.set(base, key, value, receiver)) throw new TypeError('Cannot assign to inherited property');
        }
      });
    }
    function defineMethod(target, key, kind, fn) {
      key = PropertyKey(key);
      var name = typeof key === 'symbol' ? (key.description === void 0 ? '' : '[' + key.description + ']') : key;
      Object.defineProperty(fn, 'name', { value: (kind === 'value' ? '' : kind + ' ') + name, configurable: true });
      var descriptor = { configurable: true, enumerable: false };
      descriptor[kind] = fn;
      if (kind === 'value') descriptor.writable = true;
      Object.defineProperty(target, key, descriptor);
    }
  `, ['superRef', 'defineMethod']))

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
          const brandId = classLocal(`private-${classId.name}-${name}-brand`)
          descriptor = {
            name,
            static: member.static,
            kind: 'accessor',
            storageId: brandId,
            brandId,
          }
          privateDescriptors.set(name, descriptor)
          helperStatements.push(
            t.variableDeclaration('var', [t.variableDeclarator(brandId, t.newExpression(classIntrinsic('WeakSet'), []))])
          )
          const initializeBrand = t.expressionStatement(
            t.callExpression(t.memberExpression(brandId, t.identifier('add')), [member.static ? classId : t.thisExpression()])
          )
          if (member.static) helperStatements.push(initializeBrand)
          else methodInitializers.push(initializeBrand)
        }

        const accessorImplId = classLocal(`private-${classId.name}-${member.kind}-${name}`)
        if (member.kind === 'get') {
          descriptor.getterId = accessorImplId
        } else {
          descriptor.setterId = accessorImplId
        }

        continue
      }
      const implId = classLocal(`private-${classId.name}-${name}-impl`)
      if (member.static) {
        privateDescriptors.set(name, {
          name,
          static: true,
          kind: 'method',
          storageId: implId,
        })
      } else {
        const brandId = classLocal(`private-${classId.name}-${name}-brand`)
        privateDescriptors.set(name, {
          name,
          static: false,
          kind: 'method',
          storageId: brandId,
          brandId,
          implId,
        })
        helperStatements.push(
          t.variableDeclaration('var', [t.variableDeclarator(brandId, t.newExpression(classIntrinsic('WeakSet'), []))])
        )
        methodInitializers.push(
          t.expressionStatement(
            t.callExpression(t.memberExpression(brandId, t.identifier('add')), [t.thisExpression()])
          )
        )
      }

      continue
    }

    if (t.isClassPrivateProperty(member)) {
      const name = member.key.id.name
      const storageId = classLocal(`private-${classId.name}-${name}`)
      privateDescriptors.set(name, {
        name,
        static: member.static,
        kind: 'field',
        storageId,
      })

      helperStatements.push(
        t.variableDeclaration('var', [t.variableDeclarator(storageId, t.newExpression(classIntrinsic('WeakMap'), []))])
      )
    }
  }

  // Private bodies can refer to members declared later in the class, or to the
  // other half of an accessor pair, so transform after descriptor registration.
  for (const member of body) {
    if (!t.isClassPrivateMethod(member)) continue
    const descriptor = privateDescriptors.get(member.key.id.name)!
    const implId = member.kind === 'get' ? descriptor.getterId!
      : member.kind === 'set' ? descriptor.setterId!
      : descriptor.implId ?? descriptor.storageId
    const methodBody = t.cloneNode(member.body, true)
    transformSuperCalls(methodBody.body, classId, member.static)
    transformPrivateBody(methodBody.body, privateDescriptors, classId)
    methodBody.directives = [t.directive(t.directiveLiteral('use strict'))]
    const impl = t.functionExpression(null, member.params as t.Identifier[], methodBody, member.generator, member.async)
    impl.extra = { ...member.extra, scriptVmMethod: true }
    helperStatements.push(t.variableDeclaration('var', [t.variableDeclarator(implId, impl)]))
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
    transformPrivateBody(constructorBody, privateDescriptors, classId)
  } else if (superClass) {
    constructorBody = [
      t.expressionStatement(
        t.callExpression(classLocal('initThis'), [t.callExpression(
          t.memberExpression(classIntrinsic('Reflect'), t.identifier('construct')),
          [classLocal('super'), t.identifier('arguments'), t.metaProperty(t.identifier('new'), t.identifier('target'))]
        )])
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
          t.expressionStatement(t.callExpression(classLocal('privateFieldInit'), [descriptor.storageId, classId, initExpr]))
        )
      } else {
        orderedInstanceInitializers.push(
          t.expressionStatement(
            t.callExpression(classLocal('privateFieldInit'), [descriptor.storageId, t.thisExpression(), initExpr])
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

  if (superClass) {
    transformSuperCalls(constructorBody, classId, false, true)
    transformSuperCalls(orderedInstanceInitializers, classId, false, true)
    const helpers = classHelper(`
      var thisValue, returnValue;
      function getThis() {
        if (thisValue === void 0) throw new ReferenceError('Must call super constructor before accessing this');
        return thisValue;
      }
      function initThis(value) {
        if (thisValue !== void 0) throw new ReferenceError('Super constructor may only be called once');
        thisValue = value;
        return thisValue;
      }
      function finish(value) {
        if (value !== void 0) {
          if (value !== null && (typeof value === 'object' || typeof value === 'function')) return value;
          throw new TypeError('Derived constructors may only return object or undefined');
        }
        return getThis();
      }
    `, ['thisValue', 'returnValue', 'getThis', 'initThis', 'finish'])
    const initializer = helpers.find(statement => t.isFunctionDeclaration(statement) && statement.id?.name === classLocal('initThis').name) as t.FunctionDeclaration
    initializer.body.body.splice(2, 0, ...orderedInstanceInitializers)
    const parameterEnd = constructorBody.findIndex(statement => statement.extra?.vmParameterPreludeEnd)
    const parameterPrelude = parameterEnd < 0 ? [] : constructorBody.splice(0, parameterEnd + 1)
    const returnBlock = t.blockStatement([
      ...constructorBody,
      // A finally break/continue can cancel a pending return. Falling through
      // the body clears its saved value; an actual return exits this label first.
      t.expressionStatement(t.assignmentExpression('=', classLocal('returnValue'), t.unaryExpression('void', t.numericLiteral(0)))),
    ])
    returnBlock.extra = { vmTransparentScope: true }
    constructorBody = [
      ...helpers,
      ...parameterPrelude,
      t.labeledStatement(classLocal('return'), returnBlock),
      t.returnStatement(t.callExpression(classLocal('finish'), [classLocal('returnValue')])),
    ]
  } else {
    transformSuperCalls(constructorBody, classId)
    constructorBody.unshift(...orderedInstanceInitializers)
  }
  constructorBody.unshift(t.ifStatement(
    t.unaryExpression('!', t.metaProperty(t.identifier('new'), t.identifier('target'))),
    t.throwStatement(t.newExpression(classIntrinsic('TypeError'), [t.stringLiteral('Class constructor cannot be invoked without new')]))
  ))
  const constructor = t.functionDeclaration(t.identifier(classId.name), constructorParams, strictClassBody(constructorBody))
  constructor.extra = {
    ...node.extra, ...constructorMethod?.extra,
    vmFunctionName: node.extra?.vmFunctionName ?? node.id?.name ?? '',
  }
  statements.push(constructor)

  if (superClass) {
    // A proxy preserves IsConstructor while its construct trap avoids executing
    // the superclass or reading its prototype during this validation step.
    statements.push(t.ifStatement(t.binaryExpression('!==', classLocal('super'), t.nullLiteral()), t.expressionStatement(
      t.callExpression(t.memberExpression(classIntrinsic('Reflect'), t.identifier('construct')), [
        t.newExpression(classIntrinsic('Proxy'), [classLocal('super'), t.objectExpression([
          t.objectProperty(t.identifier('construct'), t.functionExpression(null, [], t.blockStatement([t.returnStatement(t.objectExpression([]))]))),
        ])]), t.arrayExpression([]),
      ])
    )))
    statements.push(
      t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.memberExpression(classId, t.identifier('prototype')),
          t.callExpression(
            t.memberExpression(classIntrinsic('Object'), t.identifier('create')),
            [t.conditionalExpression(
              t.binaryExpression('===', classLocal('super'), t.nullLiteral()), t.nullLiteral(),
              t.memberExpression(classLocal('super'), t.identifier('prototype'))
            )]
          )
        )
      )
    )
    statements.push(
      t.expressionStatement(
        t.callExpression(t.memberExpression(classIntrinsic('Object'), t.identifier('defineProperty')), [
          t.memberExpression(classId, t.identifier('prototype')), t.stringLiteral('constructor'),
          t.objectExpression([
            t.objectProperty(t.identifier('value'), classId),
            t.objectProperty(t.identifier('writable'), t.booleanLiteral(true)),
            t.objectProperty(t.identifier('configurable'), t.booleanLiteral(true)),
          ]),
        ])
      )
    )
    statements.push(t.ifStatement(t.binaryExpression('!==', classLocal('super'), t.nullLiteral()), t.expressionStatement(
      t.callExpression(t.memberExpression(classIntrinsic('Object'), t.identifier('setPrototypeOf')), [classId, classLocal('super')])
    )))
  }
  statements.push(t.expressionStatement(t.callExpression(
    t.memberExpression(classIntrinsic('Object'), t.identifier('defineProperty')), [classId, t.stringLiteral('prototype'),
      t.objectExpression([t.objectProperty(t.identifier('writable'), t.booleanLiteral(false))])]
  )))

  for (const member of body) {
    if (t.isClassProperty(member) || t.isClassPrivateProperty(member) || t.isClassPrivateMethod(member)) continue

    if (!t.isClassMethod(member) || member.kind === 'constructor') {
      continue
    }

    const methodBody = t.cloneNode(member.body, true)
    transformSuperCalls(methodBody.body, classId, member.static)
    transformPrivateBody(methodBody.body, privateDescriptors, classId)
    methodBody.directives = [t.directive(t.directiveLiteral('use strict'))]
    const fn = t.functionExpression(
      null,
      member.params as t.Identifier[],
      methodBody,
      member.generator,
      member.async
    )
    fn.extra = { ...member.extra, scriptVmMethod: true }
    const key = member.computed ? member.key as t.Expression
      : t.isIdentifier(member.key) ? t.stringLiteral(member.key.name) : member.key as t.Expression

    statements.push(t.expressionStatement(t.callExpression(classLocal('defineMethod'), [
      member.static ? classId : t.memberExpression(classId, t.identifier('prototype')), key,
      t.stringLiteral(member.kind === 'get' || member.kind === 'set' ? member.kind : 'value'), fn,
    ])))
  }

  // The class name is an immutable inner binding. Keep it uninitialized while
  // computed method keys run, and never use it for generated helper references.
  if (node.id) statements.push(t.variableDeclaration('const', [t.variableDeclarator(sourceClassId, classId)]))

  if (orderedStaticAssignments.length > 0) {
    transformSuperCalls(orderedStaticAssignments, classId, true)
    // Static field initializers evaluate with the class as their `this` value.
    statements.push(t.expressionStatement(t.callExpression(
      t.memberExpression(
        t.functionExpression(null, [], t.blockStatement(orderedStaticAssignments)),
        t.identifier('call')
      ),
      [t.cloneNode(classId)]
    )))
  }

  statements.push(t.returnStatement(classId))

  return t.callExpression(
    t.functionExpression(null, superParam ? [superParam] : [], strictClassBody(statements)),
    superClass ? [superClass as t.Expression] : []
  )
}

function iteratorIntrinsic(name: string, args: t.Expression[]): t.CallExpression {
  return t.callExpression(t.identifier(`@script-vm/intrinsic/${name}`), args)
}

function transparentBlock(statements: t.Statement[]): t.BlockStatement {
  const block = t.blockStatement(statements)
  // Iterator cleanup must not introduce a new lexical scope for declarations.
  block.extra = { ...block.extra, vmTransparentScope: true }
  return block
}

function desugarPattern(
  pattern: t.ObjectPattern | t.ArrayPattern,
  source: t.Expression,
  kind: 'var' | 'let' | 'const',
  statements: t.Statement[],
  nextId: () => string
) {
  desugarPatternImpl(pattern, source, kind, statements, nextId)
}

function desugarAssignmentPattern(
  pattern: t.ObjectPattern | t.ArrayPattern,
  source: t.Expression,
  statements: t.Statement[],
  nextId: () => string
) {
  desugarPatternImpl(pattern, source, null, statements, nextId)
}

function desugarPatternImpl(
  pattern: t.ObjectPattern | t.ArrayPattern,
  source: t.Expression,
  kind: 'var' | 'let' | 'const' | null,
  statements: t.Statement[],
  nextId: () => string
) {
  const temporary = (value: t.Expression, output = statements): t.Identifier => {
    const id = t.identifier(nextId())
    output.push(t.variableDeclaration('var', [t.variableDeclarator(id, value)]))
    return id
  }
  const bind = (target: t.Node, value: t.Expression, output: t.Statement[]) => {
    let destination = t.isAssignmentPattern(target) ? target.left : target
    // Assignment references are evaluated before IteratorStep/GetV/defaults.
    if (!kind && t.isMemberExpression(destination)) {
      const object = temporary(destination.object as t.Expression, output)
      const key = destination.computed
        ? temporary(destination.property as t.Expression, output)
        : destination.property
      destination = t.memberExpression(object, key as t.Expression, destination.computed)
    }
    if (t.isAssignmentPattern(target)) {
      const current = temporary(value, output)
      value = t.conditionalExpression(
        t.binaryExpression('===', current, t.unaryExpression('void', t.numericLiteral(0))),
        target.right,
        current
      )
    }
    if (t.isObjectPattern(destination) || t.isArrayPattern(destination)) {
      desugarPatternImpl(destination, temporary(value, output), kind, output, nextId)
    } else if (kind && t.isIdentifier(destination)) {
      output.push(t.variableDeclaration(kind, [t.variableDeclarator(destination, value)]))
    } else {
      output.push(t.expressionStatement(t.assignmentExpression('=', destination as t.LVal, value)))
    }
  }

  if (t.isObjectPattern(pattern)) {
    statements.push(t.expressionStatement(iteratorIntrinsic('RequireObject', [source])))
    const excludes: t.Expression[] = []
    for (const property of pattern.properties) {
      if (t.isRestElement(property)) {
        bind(property.argument, iteratorIntrinsic('ObjectRest', [source, t.arrayExpression(excludes)]), statements)
        continue
      }
      let key: t.Expression
      if (property.computed) {
        key = temporary(iteratorIntrinsic('PropertyKey', [property.key as t.Expression]))
      } else if (t.isIdentifier(property.key)) {
        key = t.stringLiteral(property.key.name)
      } else {
        key = t.stringLiteral(String((property.key as t.StringLiteral | t.NumericLiteral).value))
      }
      excludes.push(key)
      bind(property.value, t.memberExpression(source, key, true), statements)
    }
    return
  }

  const iterator = temporary(iteratorIntrinsic('IteratorStart', [source]))
  const body: t.Statement[] = []
  for (const element of pattern.elements) {
    if (!element) {
      body.push(t.expressionStatement(iteratorIntrinsic('IteratorStep', [iterator, t.booleanLiteral(true)])))
    } else if (t.isRestElement(element)) {
      bind(element.argument, iteratorIntrinsic('IteratorRest', [iterator]), body)
    } else {
      bind(element, iteratorIntrinsic('IteratorStep', [iterator]), body)
    }
  }
  const error = t.identifier(nextId())
  statements.push(t.tryStatement(
    transparentBlock(body),
    t.catchClause(error, t.blockStatement([
      t.expressionStatement(iteratorIntrinsic('IteratorClose', [iterator, t.booleanLiteral(true)])),
      t.throwStatement(error),
    ])),
    t.blockStatement([t.expressionStatement(iteratorIntrinsic('IteratorClose', [iterator]))])
  ))
}


function buildConcatArgs(elements: (t.Expression | t.SpreadElement)[]): t.Expression {
  const groups: t.Expression[] = []
  let current: t.Expression[] = []
  for (const element of elements) {
    if (t.isSpreadElement(element)) {
      if (current.length) {
        groups.push(t.arrayExpression(current))
        current = []
      }
      groups.push(iteratorIntrinsic('IteratorRest', [iteratorIntrinsic('IteratorStart', [element.argument])]))
    } else {
      current.push(element)
    }
  }
  if (current.length) groups.push(t.arrayExpression(current))
  if (!groups.length) return t.arrayExpression([])
  if (groups.length === 1) return groups[0]
  return iteratorIntrinsic('FlattenArrays', [t.arrayExpression(groups)])
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

function transformObjectSuper(body: t.BlockStatement, home: t.Identifier, strict: boolean) {
  const root = t.functionDeclaration(t.identifier('_method'), [], body)
  const ast = t.file(t.program([root]))
  const reference = (member: t.MemberExpression) => t.memberExpression(
    iteratorIntrinsic('ObjectSuperReference', [
      t.cloneNode(home),
      toPropertyKeyExpression(member.property as t.Expression, member.computed),
      t.thisExpression(), t.booleanLiteral(strict),
    ]), t.identifier('value')
  )
  traverse(ast, {
    Function(path) {
      if (path.node !== root && !path.isArrowFunctionExpression()) path.skip()
    },
    Class(path) {
      // A nested class's heritage and computed keys retain the surrounding
      // method's super binding. Its method bodies establish different homes.
      const transformKey = (value: t.Expression): t.Expression => {
        const statement = t.expressionStatement(value)
        transformObjectSuper(t.blockStatement([statement]), home, true)
        return statement.expression
      }
      if (path.node.superClass) path.node.superClass = transformKey(path.node.superClass)
      for (const member of path.node.body.body) {
        if ('computed' in member && member.computed && 'key' in member) {
          member.key = transformKey(member.key as t.Expression)
        }
      }
      path.skip()
    },
    UnaryExpression(path) {
      const argument = path.node.argument
      if (path.node.operator !== 'delete' || !t.isMemberExpression(argument) || !t.isSuper(argument.object)) return
      // Delete evaluates a computed key expression, but does not coerce it or
      // look up the base before throwing the required ReferenceError.
      path.replaceWith(iteratorIntrinsic('ObjectSuperDelete', [
        toPropertyKeyExpression(argument.property as t.Expression, argument.computed),
      ]))
      path.skip()
    },
    CallExpression: { exit(path) {
      const callee = path.node.callee
      if (!t.isMemberExpression(callee) || !t.isSuper(callee.object)) return
      path.replaceWith(iteratorIntrinsic('Apply', [
        reference(callee), t.thisExpression(),
        buildConcatArgs(path.node.arguments as (t.Expression | t.SpreadElement)[]),
      ]))
      path.skip()
    } },
    MemberExpression: { exit(path) {
      if (!t.isSuper(path.node.object) || path.parentPath.isCallExpression({ callee: path.node })) return
      path.replaceWith(reference(path.node))
      path.skip()
    } },
  })
}

function buildObjectLiteralSequence(
  path: any,
  properties: (t.ObjectProperty | t.ObjectMethod | t.SpreadElement)[],
  nextId: () => string
): t.Expression {
  const target = t.identifier(nextId())
  const items: t.Expression[] = [
    t.assignmentExpression('=', t.cloneNode(target), t.objectExpression([])),
  ]

  for (const property of properties) {
    if (t.isSpreadElement(property)) {
      items.push(iteratorIntrinsic('ObjectSpread', [t.cloneNode(target), property.argument]))
      continue
    }

    const rawKey = toPropertyKeyExpression(property.key as t.Expression | t.Identifier, property.computed)
    // ToPropertyKey precedes evaluation of the value, including any side effects
    // from user coercion. Passing the raw object to defineProperty is too late.
    const key = property.computed ? iteratorIntrinsic('PropertyKey', [rawKey]) : rawKey
    if (t.isObjectProperty(property)) {
      if (!property.computed && !property.shorthand && t.isStringLiteral(rawKey, { value: '__proto__' })) {
        items.push(iteratorIntrinsic('ObjectSetPrototype', [t.cloneNode(target), property.value as t.Expression]))
      } else {
        const value = property.value as t.Expression
        const inferName = t.isArrowFunctionExpression(value) || t.isFunctionExpression(value) && !value.id
        items.push(iteratorIntrinsic('ObjectDefineData', [t.cloneNode(target), key, value, t.booleanLiteral(inferName)]))
      }
      continue
    }

    const home = t.identifier(nextId())
    const methodBody = t.cloneNode(property.body, true)
    const strict = path.isInStrictMode() || methodBody.directives.some(directive => directive.value.value === 'use strict')
    transformObjectSuper(methodBody, home, strict)
    const fn = t.functionExpression(null, property.params as any, methodBody, property.generator, property.async)
    fn.extra = { ...property.extra, scriptVmMethod: true }
    // Each method captures the actual object created on this evaluation, even
    // when a loop reuses the outer temporary or a method is later copied.
    const captureHome = t.callExpression(t.functionExpression(null, [home], t.blockStatement([
      t.returnStatement(fn),
    ])), [t.cloneNode(target)])
    items.push(iteratorIntrinsic('ObjectDefineMethod', [
      t.cloneNode(target), key, t.stringLiteral(property.kind === 'method' ? 'value' : property.kind), captureHome,
    ]))
  }

  items.push(t.cloneNode(target))
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
  const reservedNames = new Set<string>()
  const nextId = () => {
    let name: string
    do { name = `_d${desugarCounter++}` } while (reservedNames.has(name))
    reservedNames.add(name)
    return name
  }
  let templateSiteCounter = 0

  inferFunctionNames(file)

  // Normalize parameters before object/class visitors move their method bodies.
  traverse(file, { Function: normalizeFunctionParameters })
  traverse(file, { Identifier(path) { reservedNames.add(path.node.name) } })

  traverse(file, {
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
        q.value.cooked != null ? t.stringLiteral(q.value.cooked) : t.unaryExpression('void', t.numericLiteral(0))
      )
      const rawElements = quasis.map((q: t.TemplateElement) =>
        t.stringLiteral(q.value.raw)
      )
      const stringsArg = t.callExpression(
        t.identifier('@script-vm/intrinsic/GetTemplateObject'),
        [
          t.numericLiteral(templateSiteCounter++),
          t.arrayExpression(cookedElements),
          t.arrayExpression(rawElements),
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
        if (path.parentPath.isForStatement() && path.key === 'init') {
          newStatements.push(t.expressionStatement(t.unaryExpression('void', t.numericLiteral(0))))
          const init = t.doExpression(transparentBlock(newStatements))
          init.extra = { ...init.extra, vmLoopLexicalInit: path.node.kind !== 'var' }
          path.replaceWith(init)
        } else {
          path.replaceWithMultiple(newStatements)
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
        } else {
          // An internal do-expression keeps evaluation in the original frame,
          // including yield/await and references to this/arguments.
          statements.push(t.expressionStatement(t.cloneNode(tempId)))
          path.replaceWith(t.doExpression(transparentBlock(statements)))
        }
      }
    },

    CallExpression(path) {
      // Class lowering must preserve super construction and new.target.
      if (t.isSuper(path.node.callee) || t.isMemberExpression(path.node.callee) && t.isSuper(path.node.callee.object)) return
      if (t.isImport(path.node.callee)) {
        path.node.callee = t.identifier('__vm_import')
        return
      }
      if (!path.node.arguments.some(arg => t.isSpreadElement(arg))) return
      const callee = path.node.callee
      if (t.isMemberExpression(callee)) {
        const objTmp = t.identifier(nextId())
        const argsExpr = buildConcatArgs(path.node.arguments as (t.Expression | t.SpreadElement)[])
        // Evaluate the receiver and method once, then consume arguments.
        path.replaceWith(
          t.sequenceExpression([
            t.assignmentExpression('=', objTmp, callee.object as t.Expression),
            iteratorIntrinsic('Apply', [
              t.memberExpression(objTmp, callee.property, callee.computed),
              objTmp,
              argsExpr,
            ]),
          ])
        )
        declareTempBindings(path, [objTmp])
        path.skip()
      } else {
        const argsExpr = buildConcatArgs(path.node.arguments as (t.Expression | t.SpreadElement)[])
        path.replaceWith(
          iteratorIntrinsic('Apply', [callee as t.Expression, t.unaryExpression('void', t.numericLiteral(0)), argsExpr])
        )
        path.skip()
      }
    },

    NewExpression(path) {
      if (!path.node.arguments.some(arg => t.isSpreadElement(arg))) return
      const argsExpr = buildConcatArgs(path.node.arguments as (t.Expression | t.SpreadElement)[])
      path.replaceWith(
        iteratorIntrinsic('Construct', [path.node.callee as t.Expression, argsExpr])
      )
      path.skip()
    },

    ArrayExpression(path) {
      if (!path.node.elements.some(el => t.isSpreadElement(el))) return
      const result = buildConcatArgs(path.node.elements as (t.Expression | t.SpreadElement)[])
      path.replaceWith(result)
      path.skip()
    },

    ObjectExpression: { exit(path) {
      // Normalize every nonempty source literal, including data-only literals:
      // assignment cannot implement __proto__ and own-property definitions.
      if (path.node.properties.length === 0) return
      path.replaceWith(buildObjectLiteralSequence(path, path.node.properties, nextId))
      path.skip()
    } },

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
      if (!path.node.await) {
        const iterator = t.identifier(nextId())
        const value = t.identifier(nextId())
        const error = t.identifier(nextId())
        const left = path.node.left
        const binding = t.isVariableDeclaration(left)
          ? t.variableDeclaration(left.kind, [t.variableDeclarator(left.declarations[0].id, value)])
          : t.expressionStatement(t.assignmentExpression('=', left as t.LVal, value))
        const loop = t.whileStatement(t.booleanLiteral(true), t.blockStatement([
          t.variableDeclaration('var', [t.variableDeclarator(value, iteratorIntrinsic('IteratorStep', [iterator]))]),
          t.ifStatement(t.memberExpression(iterator, t.identifier('done')), t.breakStatement()),
          binding,
          path.node.body,
        ]))
        // Every contiguous label denotes this iteration statement, including
        // continue targets. Move the entire label set inside iterator cleanup.
        let replacementPath: typeof path | typeof path.parentPath = path
        let loopStatement: t.Statement = loop
        while (replacementPath.parentPath?.isLabeledStatement()) {
          replacementPath = replacementPath.parentPath
          loopStatement = t.labeledStatement(t.cloneNode((replacementPath.node as t.LabeledStatement).label), loopStatement)
        }
        const replacement = [
          t.variableDeclaration('var', [t.variableDeclarator(iterator, iteratorIntrinsic('IteratorStart', [path.node.right]))]),
          t.tryStatement(t.blockStatement([loopStatement]),
            t.catchClause(error, t.blockStatement([
              t.expressionStatement(iteratorIntrinsic('IteratorClose', [iterator, t.booleanLiteral(true)])),
              t.throwStatement(error),
            ])),
            t.blockStatement([t.expressionStatement(iteratorIntrinsic('IteratorClose', [iterator]))])
          ),
        ]
        replacementPath.replaceWithMultiple(replacement)
        return
      }
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
      // A host iterator preserves inherited enumeration, shadowing and deletion
      // semantics while the VM still executes every user-visible loop body.
      path.replaceWith(t.forOfStatement(
        path.node.left,
        iteratorIntrinsic('EnumerateKeys', [path.node.right]),
        path.node.body
      ))
    },
  })

  // Pass 2: Normalize arrows, classes, catch clause renaming
  const arrowCaptures = new WeakMap<t.Node, { thisId?: t.Identifier; newTargetId?: t.Identifier }>()

  const skipNonArrowVisitors = {
    FunctionDeclaration(p: any) { p.skip() },
    FunctionExpression(p: any) { p.skip() },
    ObjectMethod(p: any) { p.skip() },
    ClassMethod(p: any) { p.skip() },
  }

  traverse(file, {
    ArrowFunctionExpression(path) {
      const { node } = path

      // Capture this/new.target values; arguments resolves through its live
      // lexical binding in lowering, including later assignments to that binding.
      let usesThis = false
      let usesNewTarget = false
      path.traverse({
        ...skipNonArrowVisitors,
        // Skip nested arrows — they will be processed separately and will
        // capture from their own enclosing scope
        ArrowFunctionExpression(p: any) { p.skip() },
        ThisExpression() { usesThis = true },
        MetaProperty(innerPath: any) {
          if (innerPath.node.meta.name === 'new' && innerPath.node.property.name === 'target') {
            usesNewTarget = true
          }
        },
      })

      if (usesThis || usesNewTarget) {
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
            captures.thisId = t.identifier(nextId())
            getBody(enclosingNode).unshift(
              t.variableDeclaration('var', [
                t.variableDeclarator(t.cloneNode(captures.thisId, true), t.thisExpression())
              ])
            )
          }

          if (usesNewTarget && !captures.newTargetId) {
            captures.newTargetId = t.identifier(nextId())
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

      const newNode = path.node as unknown as t.FunctionExpression
      newNode.extra = { ...node.extra, scriptVmMethod: true, scriptVmArrow: true }

    },
    CatchClause(path) {
      if (path.node.param && t.isIdentifier(path.node.param)) {
        const nextName = nextId()
        path.scope.rename(path.node.param.name, nextName)
      }
    },
    ClassDeclaration(path) {
      const node = path.node
      const className = node.id ? node.id.name : '_AnonymousClass'
      const classId = t.identifier(className)
      path.replaceWith(
        t.variableDeclaration('let', [t.variableDeclarator(classId, buildClassIife(node, classId))])
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
