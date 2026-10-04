import * as t from '@babel/types'
import type { BindingRef, FunctionIR, IRInstruction, LoweredProgram, SlotKind } from './ir'

interface LoopLabels {
  breakLabel: string
  scopeDepth: number
  continueLabel: string
  labels?: string[]
}

interface BreakableLabels {
  labelOnly?: boolean
  breakLabel: string
  scopeDepth: number
  continueLabel?: string
  labels?: string[]
}

interface ScopeBinding {
  slot: number
  kind: SlotKind
}

class ScopeFrame {
  builder: FunctionBuilder
  parent?: ScopeFrame
  runtimeDepth: number
  bindings = new Map<string, ScopeBinding>()
  localSlots: number[] = []

  constructor(builder: FunctionBuilder, parent?: ScopeFrame) {
    this.builder = builder
    this.parent = parent
    this.runtimeDepth = parent ? parent.runtimeDepth + 1 : 0
  }
}

class FunctionBuilder {
  id: number
  name: string | null
  async: boolean
  generator: boolean
  strict: boolean
  method: boolean
  module: boolean
  length: number
  parentFunction?: FunctionBuilder
  rootScope: ScopeFrame
  slotNames: string[] = []
  slotKinds: SlotKind[] = []
  instructions: IRInstruction[] = []
  regCounter = 0
  labelCounter = 0
  loopStack: LoopLabels[] = []
  breakStack: BreakableLabels[] = []
  params = 0
  parameterSlots: number[] = []
  simpleParameters = true
  argumentsSlot?: number
  annexBFunctions = new WeakSet<t.FunctionDeclaration>()
  nestingDepth: number

  constructor(
    id: number,
    name: string | null,
    params: string[],
    outerScope?: ScopeFrame,
    parentFunction?: FunctionBuilder,
    flags?: { async?: boolean; generator?: boolean; strict?: boolean; method?: boolean; module?: boolean; length?: number }
  ) {
    this.id = id
    this.name = name
    this.async = Boolean(flags?.async)
    this.generator = Boolean(flags?.generator)
    this.strict = Boolean(flags?.strict ?? parentFunction?.strict)
    this.method = Boolean(flags?.method)
    this.module = Boolean(flags?.module)
    this.length = flags?.length ?? params.length
    this.parentFunction = parentFunction
    this.nestingDepth = parentFunction ? parentFunction.nestingDepth + 1 : 0
    this.rootScope = new ScopeFrame(this, outerScope)
    for (const param of params) {
      this.parameterSlots.push(this.declareBinding(this.rootScope, param, 'param'))
      this.params++
    }
  }

  createScope(parent: ScopeFrame): ScopeFrame {
    return new ScopeFrame(this, parent)
  }

  declareBinding(scope: ScopeFrame, name: string, kind: SlotKind): number {
    const targetScope = kind === 'var' || kind === 'function' || kind === 'param' ? this.rootScope : scope
    const existing = targetScope.bindings.get(name)
    if (existing) {
      return existing.slot
    }
    const slot = this.slotNames.length
    this.slotNames.push(name)
    this.slotKinds.push(kind)
    targetScope.bindings.set(name, { slot, kind })
    if (targetScope !== this.rootScope || (kind !== 'var' && kind !== 'function' && kind !== 'param')) {
      targetScope.localSlots.push(slot)
    }
    return slot
  }

  allocReg(): number {
    return this.regCounter++
  }

  emit(instruction: IRInstruction) {
    this.instructions.push(instruction)
  }

  label(prefix: string): string {
    return `${prefix}_${this.id}_${this.labelCounter++}`
  }

  resolve(scope: ScopeFrame, name: string): BindingRef {
    let current: ScopeFrame | undefined = scope
    while (current) {
      const binding = current.bindings.get(name)
      if (binding) {
        return { kind: 'slot', depth: scope.runtimeDepth - current.runtimeDepth, slot: binding.slot }
      }
      current = current.parent
    }
    return { kind: 'global', name }
  }

  finalize(): FunctionIR {
    return {
      id: this.id,
      name: this.name,
      params: this.params,
      parameterSlots: [...this.parameterSlots],
      simpleParameters: this.simpleParameters,
      argumentsSlot: this.argumentsSlot,
      slotNames: [...this.slotNames],
      slotKinds: [...this.slotKinds],
      instructions: [...this.instructions],
      registerCount: this.regCounter,
      async: this.async,
      generator: this.generator,
      strict: this.strict,
      method: this.method,
      module: this.module,
      length: this.length,
    }
  }
}

class ModuleLowerer {
  functions: FunctionBuilder[] = []

  constructor(private readonly exportsIdentifier = '__exports') {}

  compile(file: t.File): LoweredProgram {
    const entry = this.compileProgram(file.program)
    return {
      functions: this.functions.map((fn) => fn.finalize()),
      entryFunctionId: entry.id,
    }
  }

  private createFunction(
    name: string | null,
    params: string[],
    outerScope?: ScopeFrame,
    parentFunction?: FunctionBuilder,
    flags?: { async?: boolean; generator?: boolean; strict?: boolean; method?: boolean; module?: boolean; length?: number }
  ): FunctionBuilder {
    const builder = new FunctionBuilder(this.functions.length, name, params, outerScope, parentFunction, flags)
    this.functions.push(builder)
    return builder
  }

  private compileProgram(program: t.Program): FunctionBuilder {
    const builder = this.createFunction(null, [], undefined, undefined, {
      strict: program.sourceType === 'module' || program.directives.some((directive) => directive.value.value === 'use strict'),
      module: program.sourceType === 'module',
    })
    this.predeclareFunctionBindings(program.body, builder)
    this.predeclareLexicalBindings(program.body, builder, builder.rootScope)
    this.emitHoistedFunctions(program.body, builder, builder.rootScope)
    for (const statement of program.body) {
      this.compileStatement(statement, builder, builder.rootScope)
    }

    const exportsBinding = builder.resolve(builder.rootScope, this.exportsIdentifier)
    if (exportsBinding.kind === 'slot') {
      const result = builder.allocReg()
      builder.emit({ op: 'load_slot', dst: result, depth: exportsBinding.depth, slot: exportsBinding.slot })
      builder.emit({ op: 'return', src: result })
    } else {
      const result = builder.allocReg()
      builder.emit({ op: 'load_undefined', dst: result })
      builder.emit({ op: 'return', src: result })
    }

    return builder
  }

  private compileNestedFunction(
    node: t.FunctionExpression | t.FunctionDeclaration,
    parentFunction: FunctionBuilder,
    declarationScope: ScopeFrame
  ): number {
    const params = node.params.map((param) => {
      if (!t.isIdentifier(param)) {
        throw new Error('Only identifier parameters are supported in script-vm-next v0.1')
      }
      return param.name
    })

    const builder = this.createFunction(typeof node.extra?.vmFunctionName === 'string' ? node.extra.vmFunctionName : node.id?.name ?? null, params, declarationScope, parentFunction, {
      async: node.async,
      generator: node.generator,
      strict: parentFunction.strict || node.body.directives.some((directive) => directive.value.value === 'use strict'),
      method: Boolean(node.extra?.scriptVmMethod),
      length: typeof node.extra?.vmFunctionLength === 'number' ? node.extra.vmFunctionLength : undefined,
    })
    builder.simpleParameters = !node.extra?.vmNonSimpleParameters
    this.predeclareFunctionBindings(node.body.body, builder)
    this.predeclareLexicalBindings(node.body.body, builder, builder.rootScope)
    const argumentsBinding = builder.rootScope.bindings.get('arguments')
    if (!node.extra?.scriptVmArrow && (!argumentsBinding || argumentsBinding.kind === 'var' || argumentsBinding.kind === 'function')) {
      builder.argumentsSlot = builder.declareBinding(builder.rootScope, 'arguments', 'var')
    }
    this.emitHoistedFunctions(node.body.body, builder, builder.rootScope)
    for (const statement of node.body.body) {
      if (statement.extra?.vmParameterPreludeEnd) builder.emit({ op: 'parameter_end' })
      this.compileStatement(statement, builder, builder.rootScope)
    }

    const result = builder.allocReg()
    builder.emit({ op: 'load_undefined', dst: result })
    builder.emit({ op: 'return', src: result })
    return builder.id
  }

  private collectSwitchStatements(cases: t.SwitchCase[]): t.Statement[] {
    return cases.flatMap((switchCase) => switchCase.consequent)
  }

  private predeclareFunctionBindings(statements: t.Statement[], builder: FunctionBuilder) {
    const lexicalNames = (body: t.Statement[]): string[] => body.flatMap(statement => {
      if (t.isTryStatement(statement) && statement.block.extra?.vmTransparentScope) {
        return lexicalNames(statement.block.body)
      }
      if (t.isVariableDeclaration(statement) && statement.kind !== 'var') {
        return statement.declarations.flatMap(declaration => Object.keys(t.getBindingIdentifiers(declaration.id)))
      }
      return []
    })
    const rootBlocked = new Set([
      ...lexicalNames(statements),
      ...builder.parameterSlots.map(slot => builder.slotNames[slot]),
    ])
    const visitBody = (body: t.Statement[], nested: boolean, blocked: Set<string>) => {
      const nextBlocked = new Set([...blocked, ...lexicalNames(body)])
      for (const statement of body) visitStatement(statement, nested, nextBlocked)
    }
    const visitStatement = (statement: t.Statement, nested: boolean, blocked: Set<string>) => {
      if (t.isFunctionDeclaration(statement)) {
        if (statement.id) {
          if (!nested) builder.declareBinding(builder.rootScope, statement.id.name, 'function')
          else if (!builder.strict && !statement.async && !statement.generator && !blocked.has(statement.id.name)) {
            builder.declareBinding(builder.rootScope, statement.id.name, 'var')
            builder.annexBFunctions.add(statement)
          }
        }
        return
      }
      if (t.isVariableDeclaration(statement) && statement.kind === 'var') {
        for (const declaration of statement.declarations) {
          if (!t.isIdentifier(declaration.id)) throw new Error('Destructuring declaration was not normalized')
          builder.declareBinding(builder.rootScope, declaration.id.name, 'var')
        }
        return
      }
      if (t.isBlockStatement(statement)) {
        visitBody(statement.body, statement.extra?.vmTransparentScope ? nested : true, blocked)
      } else if (t.isIfStatement(statement)) {
        visitStatement(statement.consequent, true, blocked)
        if (statement.alternate) visitStatement(statement.alternate, true, blocked)
      } else if (t.isTryStatement(statement)) {
        visitStatement(statement.block, nested, blocked)
        if (statement.handler) {
          // Catch parameters block Annex B var synthesis in their catch body.
          const catchBlocked = new Set([...blocked, ...Object.keys(t.getBindingIdentifiers(statement.handler.param))])
          visitBody(statement.handler.body.body, true, catchBlocked)
        }
        if (statement.finalizer) visitStatement(statement.finalizer, nested, blocked)
      } else if (t.isWhileStatement(statement) || t.isDoWhileStatement(statement)) {
        visitStatement(statement.body, true, blocked)
      } else if (t.isForStatement(statement)) {
        let loopBlocked = blocked
        if (statement.init && t.isVariableDeclaration(statement.init)) {
          if (statement.init.kind === 'var') visitStatement(statement.init, nested, blocked)
          else loopBlocked = new Set([...blocked, ...lexicalNames([statement.init])])
        }
        visitStatement(statement.body, true, loopBlocked)
      } else if (t.isSwitchStatement(statement)) {
        visitBody(this.collectSwitchStatements(statement.cases), true, blocked)
      } else if (t.isLabeledStatement(statement)) {
        visitStatement(statement.body, nested, blocked)
      }
    }
    visitBody(statements, false, rootBlocked)
  }

  private predeclareLexicalBindings(statements: t.Statement[], builder: FunctionBuilder, scope: ScopeFrame) {
    for (const statement of statements) {
      if (t.isLabeledStatement(statement)) {
        const body = statement.body
        this.predeclareLexicalBindings(t.isBlockStatement(body) && body.extra?.vmTransparentScope ? body.body : [body], builder, scope)
        continue
      }
      if (t.isTryStatement(statement) && statement.block.extra?.vmTransparentScope) {
        this.predeclareLexicalBindings(statement.block.body, builder, scope)
        continue
      }
      if (t.isFunctionDeclaration(statement) && scope !== builder.rootScope && statement.id) {
        builder.declareBinding(scope, statement.id.name, 'let')
        continue
      }
      if (!t.isVariableDeclaration(statement) || statement.kind === 'var') {
        continue
      }
      for (const declaration of statement.declarations) {
        if (!t.isIdentifier(declaration.id)) {
          throw new Error('Destructuring declarations are not supported in script-vm-next v0.1')
        }
        if (statement.kind !== 'let' && statement.kind !== 'const') {
          throw new Error(`Unsupported declaration kind: ${statement.kind}`)
        }
        builder.declareBinding(scope, declaration.id.name, statement.kind)
      }
    }
  }

  private emitHoistedFunctions(statements: t.Statement[], builder: FunctionBuilder, scope: ScopeFrame) {
    const hoisted: t.FunctionDeclaration[] = []
    const collect = (statement: t.Statement) => {
      if (t.isFunctionDeclaration(statement)) hoisted.push(statement)
      else if (t.isLabeledStatement(statement)) collect(statement.body)
      else if (t.isTryStatement(statement) && statement.block.extra?.vmTransparentScope) {
        statement.block.body.forEach(collect)
      }
    }
    statements.forEach(collect)

    for (const fn of hoisted) {
      const functionId = this.compileNestedFunction(fn, builder, scope)
      const binding = builder.resolve(scope, fn.id!.name)
      if (binding.kind !== 'slot') {
        throw new Error(`Hoisted function binding '${fn.id!.name}' is not a slot`)
      }
      const reg = builder.allocReg()
      builder.emit({ op: 'make_function', dst: reg, functionId })
      if (scope === builder.rootScope) {
        builder.emit({ op: 'store_slot', strict: builder.strict, depth: binding.depth, slot: binding.slot, src: reg })
      } else {
        builder.emit({ op: 'init_slot', depth: binding.depth, slot: binding.slot, src: reg })
      }
    }
  }

  private compileStatement(statement: t.Statement, builder: FunctionBuilder, scope: ScopeFrame, statementLabels: string[] = []) {
    if (t.isFunctionDeclaration(statement)) {
      if (builder.annexBFunctions.has(statement) && statement.id) {
        const lexical = builder.resolve(scope, statement.id.name)
        const outer = builder.rootScope.bindings.get(statement.id.name)!
        const value = builder.allocReg()
        if (lexical.kind !== 'slot') throw new Error('Missing block function binding')
        builder.emit({ op: 'load_slot', dst: value, depth: lexical.depth, slot: lexical.slot })
        builder.emit({ op: 'store_slot', depth: scope.runtimeDepth - builder.rootScope.runtimeDepth, slot: outer.slot, src: value })
      }
      return
    }

    if (t.isBlockStatement(statement)) {
      if (statement.extra?.vmTransparentScope) {
        statement.body.forEach((item) => this.compileStatement(item, builder, scope))
        return
      }
      const blockScope = builder.createScope(scope)
      this.predeclareLexicalBindings(statement.body, builder, blockScope)
      if (blockScope.localSlots.length > 0) {
        builder.emit({ op: 'enter_scope', slots: [...blockScope.localSlots] })
        this.emitHoistedFunctions(statement.body, builder, blockScope)
        statement.body.forEach((item) => this.compileStatement(item, builder, blockScope))
        builder.emit({ op: 'leave_scope' })
      } else {
        statement.body.forEach((item) => this.compileStatement(item, builder, scope))
      }
      return
    }

    if (t.isExpressionStatement(statement)) {
      this.compileExpression(statement.expression, builder, scope)
      return
    }

    if (t.isVariableDeclaration(statement)) {
      for (const declaration of statement.declarations) {
        if (!t.isIdentifier(declaration.id)) {
          throw new Error('Destructuring declarations are not supported in script-vm-next v0.1')
        }
        const binding = builder.resolve(scope, declaration.id.name)
        if (binding.kind !== 'slot') {
          throw new Error(`Declaration target '${declaration.id.name}' is not a local slot`)
        }
        if (declaration.init) {
          const init = this.compileExpression(declaration.init, builder, scope)
          if (statement.kind === 'var') {
            builder.emit({ op: 'store_slot', strict: builder.strict, depth: binding.depth, slot: binding.slot, src: init })
          } else {
            builder.emit({ op: 'init_slot', depth: binding.depth, slot: binding.slot, src: init })
          }
        } else if (statement.kind === 'let') {
          const init = this.loadUndefined(builder)
          builder.emit({ op: 'init_slot', depth: binding.depth, slot: binding.slot, src: init })
        } else if (statement.kind === 'const') {
          throw new Error('const declarations must be initialized in script-vm-next v0.1')
        }
      }
      return
    }

    if (t.isReturnStatement(statement)) {
      const value = statement.argument
        ? this.compileExpression(statement.argument, builder, scope)
        : this.loadUndefined(builder)
      builder.emit({ op: 'return', src: value })
      return
    }

    if (t.isIfStatement(statement)) {
      const alternateLabel = builder.label('if_alt')
      const endLabel = builder.label('if_end')
      const test = this.compileExpression(statement.test, builder, scope)
      builder.emit({ op: 'jump_if_false', condition: test, target: alternateLabel })
      this.compileStatement(t.isFunctionDeclaration(statement.consequent) ? t.blockStatement([statement.consequent]) : statement.consequent, builder, scope)
      builder.emit({ op: 'jump', target: endLabel })
      builder.emit({ op: 'label', name: alternateLabel })
      if (statement.alternate) {
        this.compileStatement(t.isFunctionDeclaration(statement.alternate) ? t.blockStatement([statement.alternate]) : statement.alternate, builder, scope)
      }
      builder.emit({ op: 'label', name: endLabel })
      return
    }

    if (t.isWhileStatement(statement)) {
      const testLabel = builder.label('while_test')
      const endLabel = builder.label('while_end')
      const bodyLabel = builder.label('while_body')
      builder.emit({ op: 'label', name: testLabel })
      const test = this.compileExpression(statement.test, builder, scope)
      builder.emit({ op: 'jump_if_false', condition: test, target: endLabel })
      builder.emit({ op: 'label', name: bodyLabel })
      builder.loopStack.push({ breakLabel: endLabel, continueLabel: testLabel, labels: statementLabels, scopeDepth: scope.runtimeDepth - builder.rootScope.runtimeDepth })
      builder.breakStack.push({ breakLabel: endLabel, continueLabel: testLabel, labels: statementLabels, scopeDepth: scope.runtimeDepth - builder.rootScope.runtimeDepth })
      this.compileStatement(statement.body, builder, scope)
      builder.loopStack.pop()
      builder.breakStack.pop()
      builder.emit({ op: 'jump', target: testLabel })
      builder.emit({ op: 'label', name: endLabel })
      return
    }

    if (t.isDoWhileStatement(statement)) {
      const bodyLabel = builder.label('do_body')
      const testLabel = builder.label('do_test')
      const endLabel = builder.label('do_end')

      builder.emit({ op: 'label', name: bodyLabel })
      builder.loopStack.push({ breakLabel: endLabel, continueLabel: testLabel, labels: statementLabels, scopeDepth: scope.runtimeDepth - builder.rootScope.runtimeDepth })
      builder.breakStack.push({ breakLabel: endLabel, continueLabel: testLabel, labels: statementLabels, scopeDepth: scope.runtimeDepth - builder.rootScope.runtimeDepth })
      this.compileStatement(statement.body, builder, scope)
      builder.loopStack.pop()
      builder.breakStack.pop()
      builder.emit({ op: 'label', name: testLabel })
      const test = this.compileExpression(statement.test, builder, scope)
      builder.emit({ op: 'jump_if_false', condition: test, target: endLabel })
      builder.emit({ op: 'jump', target: bodyLabel })
      builder.emit({ op: 'label', name: endLabel })
      return
    }

    if (t.isForStatement(statement)) {
      let loopScope = scope
      const patternInit = statement.init && t.isDoExpression(statement.init) && statement.init.extra?.vmLoopLexicalInit
        ? statement.init.body.body : undefined
      const hasLoopLexicalInit = Boolean(patternInit || (statement.init && t.isVariableDeclaration(statement.init) && statement.init.kind !== 'var'))
      if (hasLoopLexicalInit) {
        loopScope = builder.createScope(scope)
        this.predeclareLexicalBindings(patternInit || [statement.init as t.Statement], builder, loopScope)
        if (loopScope.localSlots.length > 0) {
          builder.emit({ op: 'enter_scope', slots: [...loopScope.localSlots] })
        }
      }

      if (statement.init) {
        if (t.isVariableDeclaration(statement.init)) {
          this.compileStatement(statement.init, builder, loopScope)
        } else {
          this.compileExpression(statement.init, builder, loopScope)
        }
      }

      const testLabel = builder.label('for_test')
      const updateLabel = builder.label('for_update')
      const endLabel = builder.label('for_end')

      builder.emit({ op: 'label', name: testLabel })
      if (statement.test) {
        const test = this.compileExpression(statement.test, builder, loopScope)
        builder.emit({ op: 'jump_if_false', condition: test, target: endLabel })
      }
      builder.loopStack.push({ breakLabel: endLabel, continueLabel: updateLabel, labels: statementLabels, scopeDepth: loopScope.runtimeDepth - builder.rootScope.runtimeDepth })
      builder.breakStack.push({ breakLabel: endLabel, continueLabel: updateLabel, labels: statementLabels, scopeDepth: loopScope.runtimeDepth - builder.rootScope.runtimeDepth })
      this.compileStatement(statement.body, builder, loopScope)
      builder.loopStack.pop()
      builder.breakStack.pop()
      builder.emit({ op: 'label', name: updateLabel })
      if (hasLoopLexicalInit && loopScope.localSlots.length > 0) {
        builder.emit({ op: 'replace_scope', slots: [...loopScope.localSlots] })
      }
      if (statement.update) {
        this.compileExpression(statement.update, builder, loopScope)
      }
      builder.emit({ op: 'jump', target: testLabel })
      builder.emit({ op: 'label', name: endLabel })
      if (hasLoopLexicalInit && loopScope.localSlots.length > 0) {
        builder.emit({ op: 'leave_scope' })
      }
      return
    }

    if (t.isBreakStatement(statement)) {
      if (statement.label) {
        let target: BreakableLabels | undefined
        for (let i = builder.breakStack.length - 1; i >= 0; i--) {
          if (builder.breakStack[i].labels?.includes(statement.label.name)) { target = builder.breakStack[i]; break }
        }
        if (!target) throw new Error(`Unknown label: ${statement.label.name}`)
        builder.emit({ op: 'abrupt_jump', target: target.breakLabel, scopeDepth: target.scopeDepth })
      } else {
        const breakable = [...builder.breakStack].reverse().find((target) => !target.labelOnly)
        if (!breakable) throw new Error('break statement is only supported inside loops')
        builder.emit({ op: 'abrupt_jump', target: breakable.breakLabel, scopeDepth: breakable.scopeDepth })
      }
      return
    }

    if (t.isContinueStatement(statement)) {
      if (statement.label) {
        let target: LoopLabels | undefined
        for (let i = builder.loopStack.length - 1; i >= 0; i--) {
          if (builder.loopStack[i].labels?.includes(statement.label.name)) { target = builder.loopStack[i]; break }
        }
        if (!target) throw new Error(`Unknown label: ${statement.label.name}`)
        builder.emit({ op: 'abrupt_jump', target: target.continueLabel, scopeDepth: target.scopeDepth })
      } else {
        const loop = builder.loopStack[builder.loopStack.length - 1]
        if (!loop) throw new Error('continue statement is only supported inside loops')
        builder.emit({ op: 'abrupt_jump', target: loop.continueLabel, scopeDepth: loop.scopeDepth })
      }
      return
    }

    if (t.isEmptyStatement(statement)) {
      return
    }

    if (t.isThrowStatement(statement)) {
      if (!statement.argument) {
        throw new Error('throw requires an argument')
      }
      const src = this.compileExpression(statement.argument, builder, scope)
      builder.emit({ op: 'throw', src })
      return
    }

    if (t.isTryStatement(statement)) {
      const tryStart = builder.label('try_start')
      const catchStart = statement.handler ? builder.label('try_catch') : null
      const finallyStart = statement.finalizer ? builder.label('try_finally') : null
      const endLabel = builder.label('try_end')

      let catchScope: ScopeFrame | undefined
      let catchDepth = -1
      let catchSlot = -1
      if (statement.handler?.param && t.isIdentifier(statement.handler.param)) {
        catchScope = builder.createScope(scope)
        builder.declareBinding(catchScope, statement.handler.param.name, 'catch')
        const binding = builder.resolve(catchScope, statement.handler.param.name)
        if (binding.kind === 'slot') {
          catchDepth = binding.depth
          catchSlot = binding.slot
        }
      }

      builder.emit({
        op: 'try',
        tryStart,
        catchStart,
        finallyStart,
        end: endLabel,
        catchDepth,
        catchSlot,
      })

      builder.emit({ op: 'label', name: tryStart })
      this.compileStatement(statement.block, builder, scope)

      if (statement.handler) {
        builder.emit({ op: 'label', name: catchStart! })
        const catchParentScope = catchScope ?? scope
        const catchBodyScope = builder.createScope(catchParentScope)
        this.predeclareLexicalBindings(statement.handler.body.body, builder, catchBodyScope)
        if (catchBodyScope.localSlots.length > 0) {
          builder.emit({ op: 'enter_scope', slots: [...catchBodyScope.localSlots] })
          this.emitHoistedFunctions(statement.handler.body.body, builder, catchBodyScope)
          statement.handler.body.body.forEach((item) => this.compileStatement(item, builder, catchBodyScope))
          builder.emit({ op: 'leave_scope' })
        } else {
          statement.handler.body.body.forEach((item) => this.compileStatement(item, builder, catchParentScope))
        }
      }

      if (statement.finalizer) {
        builder.emit({ op: 'label', name: finallyStart! })
        this.compileStatement(statement.finalizer, builder, scope)
      }

      builder.emit({ op: 'label', name: endLabel })
      return
    }

    if (t.isSwitchStatement(statement)) {
      const endLabel = builder.label('switch_end')
      const cleanupLabel = builder.label('switch_cleanup')
      const discriminant = this.compileExpression(statement.discriminant, builder, scope)

      // Create lexical scope for the entire switch body
      const switchScope = builder.createScope(scope)
      this.predeclareLexicalBindings(this.collectSwitchStatements(statement.cases), builder, switchScope)
      const hasLexicalScope = switchScope.localSlots.length > 0

      // Enter scope BEFORE tests so that all case-label jumps land inside it
      if (hasLexicalScope) {
        builder.emit({ op: 'enter_scope', slots: [...switchScope.localSlots] })
        this.emitHoistedFunctions(this.collectSwitchStatements(statement.cases), builder, switchScope)
      }

      const activeScope = hasLexicalScope ? switchScope : scope
      const caseLabels = statement.cases.map(() => builder.label('switch_case'))
      const defaultIndex = statement.cases.findIndex((c) => c.test === null)
      const defaultLabel = defaultIndex >= 0 ? caseLabels[defaultIndex] : cleanupLabel

      // Emit case comparison tests (discriminant is a register, unaffected by scope)
      for (let i = 0; i < statement.cases.length; i++) {
        const switchCase = statement.cases[i]
        if (!switchCase.test) continue
        const caseValue = this.compileExpression(switchCase.test, builder, activeScope)
        const matches = this.binary('===', discriminant, caseValue, builder)
        const nextTestLabel = builder.label('switch_next')
        builder.emit({ op: 'jump_if_false', condition: matches, target: nextTestLabel })
        builder.emit({ op: 'jump', target: caseLabels[i] })
        builder.emit({ op: 'label', name: nextTestLabel })
      }
      builder.emit({ op: 'jump', target: defaultLabel })

      // Emit case bodies
      builder.breakStack.push({ breakLabel: cleanupLabel, labels: statementLabels, scopeDepth: (hasLexicalScope ? switchScope : scope).runtimeDepth - builder.rootScope.runtimeDepth })
      for (let i = 0; i < statement.cases.length; i++) {
        builder.emit({ op: 'label', name: caseLabels[i] })
        for (const consequent of statement.cases[i].consequent) {
          this.compileStatement(consequent, builder, activeScope)
        }
      }
      builder.breakStack.pop()

      builder.emit({ op: 'label', name: cleanupLabel })
      if (hasLexicalScope) {
        builder.emit({ op: 'leave_scope' })
      }
      builder.emit({ op: 'label', name: endLabel })
      return
    }

    if (t.isLabeledStatement(statement)) {
      const labels: string[] = []
      let body: t.Statement = statement
      while (t.isLabeledStatement(body)) {
        labels.push(body.label.name)
        body = body.body
      }
      if (t.isLoop(body) || t.isSwitchStatement(body)) {
        this.compileStatement(body, builder, scope, labels)
      } else {
        const endLabel = builder.label('labeled_end')
        builder.breakStack.push({ labelOnly: true, breakLabel: endLabel, labels, scopeDepth: scope.runtimeDepth - builder.rootScope.runtimeDepth })
        this.compileStatement(body, builder, scope)
        builder.breakStack.pop()
        builder.emit({ op: 'label', name: endLabel })
      }
      return
    }

    if (t.isDebuggerStatement(statement)) {
      return
    }

    throw new Error(`Unsupported statement type: ${statement.type}`)
  }

  private compileExpression(expression: t.Expression, builder: FunctionBuilder, scope: ScopeFrame): number {
    if (t.isDoExpression(expression) && expression.body.extra?.vmClassEvaluation) {
      const statements = expression.body.body
      const classScope = builder.createScope(scope)
      this.predeclareLexicalBindings(statements, builder, classScope)
      builder.emit({ op: 'enter_scope', slots: [...classScope.localSlots] })
      const previousStrict = builder.strict
      builder.strict = true
      for (const statement of statements.slice(0, -1)) this.compileStatement(statement, builder, classScope)
      const result = statements[statements.length - 1]
      if (!t.isExpressionStatement(result)) throw new Error('Internal class evaluation must end in a value')
      const value = this.compileExpression(result.expression, builder, classScope)
      builder.strict = previousStrict
      builder.emit({ op: 'leave_scope' })
      return value
    }
    if (t.isDoExpression(expression) && expression.body.extra?.vmTransparentScope) {
      const statements = expression.body.body
      this.predeclareFunctionBindings(statements, builder)
      for (const statement of statements.slice(0, -1)) this.compileStatement(statement, builder, scope)
      const result = statements[statements.length - 1]
      if (!t.isExpressionStatement(result)) throw new Error('Internal do-expression must end in a value')
      return this.compileExpression(result.expression, builder, scope)
    }
    if (
      t.isNumericLiteral(expression) ||
      t.isStringLiteral(expression) ||
      t.isBooleanLiteral(expression) ||
      t.isNullLiteral(expression)
    ) {
      const dst = builder.allocReg()
      builder.emit({ op: 'load_const', dst, value: t.isNullLiteral(expression) ? null : expression.value })
      return dst
    }

    if (t.isIdentifier(expression)) {
      const binding = builder.resolve(scope, expression.name)
      if (binding.kind === 'global' && expression.name === 'undefined') return this.loadUndefined(builder)
      if (expression.extra?.vmIntrinsicArguments) {
        const dst = builder.allocReg()
        builder.emit({ op: 'load_arguments', dst })
        return dst
      }
      const dst = builder.allocReg()
      if (binding.kind === 'slot') {
        builder.emit({ op: 'load_slot', dst, depth: binding.depth, slot: binding.slot })
      } else {
        builder.emit({ op: 'load_global', dst, name: binding.name })
      }
      return dst
    }

    if (t.isThisExpression(expression)) {
      const dst = builder.allocReg()
      builder.emit({ op: 'load_this', dst })
      return dst
    }

    if (t.isRegExpLiteral(expression)) {
      const callee = this.compileExpression(t.identifier('RegExp'), builder, scope)
      const args = [this.loadLiteral(expression.pattern, builder)]
      if (expression.flags) {
        args.push(this.loadLiteral(expression.flags, builder))
      }
      const dst = builder.allocReg()
      builder.emit({ op: 'new', dst, callee, args })
      return dst
    }

    if (t.isFunctionExpression(expression)) {
      // A named expression has an immutable private environment outside its
      // parameter/body environment. Parameters and body vars can shadow it.
      const nameScope = expression.id ? builder.createScope(scope) : scope
      let nameSlot: number | undefined
      if (expression.id) {
        nameSlot = builder.declareBinding(nameScope, expression.id.name, 'function-name')
        builder.emit({ op: 'enter_scope', slots: [nameSlot] })
      }
      const functionId = this.compileNestedFunction(expression, builder, nameScope)
      const dst = builder.allocReg()
      builder.emit({ op: 'make_function', dst, functionId })
      if (nameSlot !== undefined) {
        builder.emit({ op: 'init_slot', depth: 0, slot: nameSlot, src: dst })
        builder.emit({ op: 'leave_scope' })
      }
      return dst
    }

    if (t.isArrowFunctionExpression(expression)) {
      const fake = t.functionExpression(
        null,
        expression.params as any,
        t.isBlockStatement(expression.body)
          ? expression.body
          : t.blockStatement([t.returnStatement(expression.body as t.Expression)]),
        false,
        expression.async
      )
      const functionId = this.compileNestedFunction(fake, builder, scope)
      const dst = builder.allocReg()
      builder.emit({ op: 'make_function', dst, functionId })
      return dst
    }

    if (t.isObjectExpression(expression)) {
      const dst = builder.allocReg()
      builder.emit({ op: 'object_new', dst })
      for (const property of expression.properties) {
        if (t.isObjectMethod(property)) {
          const fnExpr = t.functionExpression(
            null,
            property.params as any,
            property.body,
            property.generator,
            property.async
          )
          const value = this.compileExpression(fnExpr, builder, scope)
          const key = property.computed
            ? this.compileExpression(property.key as t.Expression, builder, scope)
            : this.loadLiteralKey(property.key as t.Expression | t.Identifier, builder, scope)

          if (property.kind === 'method') {
            builder.emit({ op: 'object_set', object: dst, key, value })
            continue
          }

          // getter or setter — use Object.defineProperty
          const descriptor = builder.allocReg()
          builder.emit({ op: 'object_new', dst: descriptor })
          builder.emit({ op: 'object_set', object: descriptor, key: this.loadLiteral(property.kind, builder), value })
          builder.emit({ op: 'object_set', object: descriptor, key: this.loadLiteral('enumerable', builder), value: this.loadLiteral(true, builder) })
          builder.emit({ op: 'object_set', object: descriptor, key: this.loadLiteral('configurable', builder), value: this.loadLiteral(true, builder) })

          const objectCtor = this.compileExpression(t.identifier('Object'), builder, scope)
          const definePropName = this.loadLiteral('defineProperty', builder)
          const defineProp = builder.allocReg()
          builder.emit({ op: 'get_prop', dst: defineProp, object: objectCtor, property: definePropName })
          const defineResult = builder.allocReg()
          builder.emit({ op: 'call', dst: defineResult, callee: defineProp, thisReg: objectCtor, args: [dst, key, descriptor] })
          continue
        }

        if (!t.isObjectProperty(property) || t.isPrivateName(property.key) || property.computed && !t.isExpression(property.key)) {
          throw new Error('Only standard object properties are supported in script-vm-next v0.1')
        }
        const key = property.computed
          ? this.compileExpression(property.key as t.Expression, builder, scope)
          : this.loadLiteralKey(property.key as t.Expression | t.Identifier, builder, scope)
        const value = this.compileExpression(property.value as t.Expression, builder, scope)
        builder.emit({ op: 'object_set', object: dst, key, value })
      }
      return dst
    }

    if (t.isArrayExpression(expression)) {
      const dst = builder.allocReg()
      builder.emit({ op: 'array_new', dst })
      for (const element of expression.elements) {
        if (!element) {
          const property = this.loadLiteral('length', builder)
          const length = builder.allocReg()
          builder.emit({ op: 'get_prop', dst: length, object: dst, property })
          const nextLength = this.binary('+', length, this.loadLiteral(1, builder), builder)
          builder.emit({ op: 'set_prop', strict: builder.strict, dst: builder.allocReg(), object: dst, property, value: nextLength })
          continue
        }
        if (t.isSpreadElement(element)) {
          throw new Error('Spread elements in arrays should be desugared by frontend')
        }
        const value = this.compileExpression(element, builder, scope)
        builder.emit({ op: 'array_push', array: dst, value })
      }
      return dst
    }

    if (t.isMemberExpression(expression)) {
      const object = this.compileExpression(expression.object as t.Expression, builder, scope)
      const property = expression.computed
        ? this.compileExpression(expression.property as t.Expression, builder, scope)
        : this.loadLiteral(expression.property.type === 'Identifier' ? expression.property.name : '', builder)
      const dst = builder.allocReg()
      builder.emit({ op: 'get_prop', dst, object, property })
      return dst
    }

    if (t.isBinaryExpression(expression)) {
      if (t.isPrivateName(expression.left)) {
        throw new Error('Private names are not supported in script-vm-next v0.1')
      }
      const left = this.compileExpression(expression.left as t.Expression, builder, scope)
      const right = this.compileExpression(expression.right, builder, scope)
      const dst = builder.allocReg()
      builder.emit({ op: 'binary', dst, left, right, operator: expression.operator })
      return dst
    }

    if (t.isLogicalExpression(expression)) {
      return this.compileLogicalExpression(expression, builder, scope)
    }

    if (t.isUnaryExpression(expression)) {
      if (expression.operator === 'typeof' && t.isIdentifier(expression.argument)) {
        const binding = builder.resolve(scope, expression.argument.name)
        if (binding.kind === 'global') {
          const dst = builder.allocReg()
          builder.emit({ op: 'typeof_global', dst, name: binding.name })
          return dst
        }
      }
      if (expression.operator === 'delete') {
        if (t.isMemberExpression(expression.argument)) {
          const object = this.compileExpression(expression.argument.object as t.Expression, builder, scope)
          const property = expression.argument.computed
            ? this.compileExpression(expression.argument.property as t.Expression, builder, scope)
            : this.loadLiteral((expression.argument.property as t.Identifier).name, builder)
          const dst = builder.allocReg()
          builder.emit({ op: 'delete_prop', strict: builder.strict, dst, object, property })
          return dst
        }
        // delete on non-member (identifier, literal, etc.) — evaluate for side effects, return true
        if (!t.isIdentifier(expression.argument)) {
          this.compileExpression(expression.argument as t.Expression, builder, scope)
        }
        return this.loadLiteral(true, builder)
      }
      const value = this.compileExpression(expression.argument as t.Expression, builder, scope)
      const dst = builder.allocReg()
      builder.emit({ op: 'unary', dst, value, operator: expression.operator })
      return dst
    }

    if (t.isAssignmentExpression(expression)) {
      return this.compileAssignment(expression, builder, scope)
    }

    if (t.isUpdateExpression(expression)) {
      return this.compileUpdateExpression(expression, builder, scope)
    }

    if (t.isCallExpression(expression)) {
      return this.compileCallExpression(expression, builder, scope)
    }

    if (t.isNewExpression(expression)) {
      const callee = this.compileExpression(expression.callee as t.Expression, builder, scope)
      const args = expression.arguments.map((arg) => {
        if (!t.isExpression(arg)) {
          throw new Error('Spread arguments are not supported in script-vm-next v0.1')
        }
        return this.compileExpression(arg, builder, scope)
      })
      const dst = builder.allocReg()
      builder.emit({ op: 'new', dst, callee, args })
      return dst
    }

    if (t.isAwaitExpression(expression)) {
      const src = this.compileExpression(expression.argument, builder, scope)
      const dst = builder.allocReg()
      builder.emit({ op: 'await', dst, src })
      return dst
    }

    if (t.isYieldExpression(expression)) {
      const src = expression.argument
        ? this.compileExpression(expression.argument, builder, scope)
        : this.loadUndefined(builder)
      const dst = builder.allocReg()
      builder.emit({ op: 'yield', dst, src, delegate: Boolean(expression.delegate) })
      return dst
    }

    if (t.isConditionalExpression(expression)) {
      const dst = builder.allocReg()
      const elseLabel = builder.label('ternary_else')
      const endLabel = builder.label('ternary_end')
      const test = this.compileExpression(expression.test, builder, scope)
      builder.emit({ op: 'jump_if_false', condition: test, target: elseLabel })
      const consequent = this.compileExpression(expression.consequent, builder, scope)
      builder.emit({ op: 'move', dst, src: consequent })
      builder.emit({ op: 'jump', target: endLabel })
      builder.emit({ op: 'label', name: elseLabel })
      const alternate = this.compileExpression(expression.alternate, builder, scope)
      builder.emit({ op: 'move', dst, src: alternate })
      builder.emit({ op: 'label', name: endLabel })
      return dst
    }

    if (t.isSequenceExpression(expression)) {
      let result = this.loadUndefined(builder)
      for (const item of expression.expressions) {
        result = this.compileExpression(item, builder, scope)
      }
      return result
    }

    if (t.isTemplateLiteral(expression)) {
      let result = this.loadLiteral(expression.quasis[0].value.cooked ?? '', builder)
      for (let i = 0; i < expression.expressions.length; i++) {
        const nextValue = this.compileExpression(t.callExpression(
          t.identifier('@script-vm/intrinsic/ToString'),
          [expression.expressions[i] as t.Expression]
        ), builder, scope)
        result = this.binary('+', result, nextValue, builder)
        const quasi = this.loadLiteral(expression.quasis[i + 1].value.cooked ?? '', builder)
        result = this.binary('+', result, quasi, builder)
      }
      return result
    }

    if (t.isMetaProperty(expression) && expression.meta.name === 'new' && expression.property.name === 'target') {
      const dst = builder.allocReg()
      builder.emit({ op: 'load_new_target', dst })
      return dst
    }

    throw new Error(`Unsupported expression type: ${expression.type}`)
  }

  private compileLogicalExpression(expression: t.LogicalExpression, builder: FunctionBuilder, scope: ScopeFrame): number {
    const left = this.compileExpression(expression.left, builder, scope)
    const dst = builder.allocReg()
    builder.emit({ op: 'move', dst, src: left })
    const evalRightLabel = builder.label('logic_right')
    const endLabel = builder.label('logic_end')

    if (expression.operator === '&&') {
      builder.emit({ op: 'jump_if_false', condition: left, target: endLabel })
      const right = this.compileExpression(expression.right, builder, scope)
      builder.emit({ op: 'move', dst, src: right })
      builder.emit({ op: 'label', name: endLabel })
      return dst
    }

    if (expression.operator === '||') {
      builder.emit({ op: 'jump_if_false', condition: left, target: evalRightLabel })
      builder.emit({ op: 'jump', target: endLabel })
      builder.emit({ op: 'label', name: evalRightLabel })
      const right = this.compileExpression(expression.right, builder, scope)
      builder.emit({ op: 'move', dst, src: right })
      builder.emit({ op: 'label', name: endLabel })
      return dst
    }

    if (expression.operator === '??') {
      builder.emit({ op: 'jump_if_not_nullish', condition: left, target: endLabel })
      const right = this.compileExpression(expression.right, builder, scope)
      builder.emit({ op: 'move', dst, src: right })
      builder.emit({ op: 'label', name: endLabel })
      return dst
    }

    throw new Error(`Unsupported logical operator: ${expression.operator}`)
  }

  private storeToTarget(
    left: t.LVal,
    right: t.Expression,
    builder: FunctionBuilder,
    scope: ScopeFrame
  ): number {
    if (t.isIdentifier(left)) {
      const binding = builder.resolve(scope, left.name)
      const value = this.compileExpression(right, builder, scope)
      if (binding.kind === 'slot') {
        builder.emit({ op: 'store_slot', strict: builder.strict, depth: binding.depth, slot: binding.slot, src: value })
      } else {
        builder.emit({ op: 'store_global', strict: builder.strict, name: binding.name, src: value })
      }
      return value
    }
    if (t.isMemberExpression(left)) {
      const object = this.compileExpression(left.object as t.Expression, builder, scope)
      const property = left.computed
        ? this.compileExpression(left.property as t.Expression, builder, scope)
        : this.loadLiteral((left.property as t.Identifier).name, builder)
      // Evaluate the reference before the RHS, but defer the actual write (and
      // property-key coercion) until after the RHS has been evaluated.
      const value = this.compileExpression(right, builder, scope)
      const dst = builder.allocReg()
      builder.emit({ op: 'set_prop', strict: builder.strict, dst, object, property, value })
      return dst
    }
    throw new Error('Unsupported assignment target')
  }

  private compileAssignment(expression: t.AssignmentExpression, builder: FunctionBuilder, scope: ScopeFrame): number {
    if (expression.operator === '=') {
      return this.storeToTarget(expression.left as t.LVal, expression.right, builder, scope)
    }

    // Compound assignment operators
    const op = expression.operator
    const isLogicalAssign = op === '&&=' || op === '||=' || op === '??='
    const baseOp = op.slice(0, -1)

    if (t.isIdentifier(expression.left)) {
      const currentValue = this.compileExpression(expression.left, builder, scope)

      if (isLogicalAssign) {
        const dst = builder.allocReg()
        builder.emit({ op: 'move', dst, src: currentValue })
        const endLabel = builder.label('compound_end')

        if (baseOp === '&&') {
          builder.emit({ op: 'jump_if_false', condition: currentValue, target: endLabel })
        } else if (baseOp === '||') {
          const evalLabel = builder.label('compound_eval')
          builder.emit({ op: 'jump_if_false', condition: currentValue, target: evalLabel })
          builder.emit({ op: 'jump', target: endLabel })
          builder.emit({ op: 'label', name: evalLabel })
        } else {
          builder.emit({ op: 'jump_if_not_nullish', condition: currentValue, target: endLabel })
        }

        const value = this.compileExpression(expression.right, builder, scope)
        const binding = builder.resolve(scope, expression.left.name)
        if (binding.kind === 'slot') {
          builder.emit({ op: 'store_slot', strict: builder.strict, depth: binding.depth, slot: binding.slot, src: value })
        } else {
          builder.emit({ op: 'store_global', strict: builder.strict, name: binding.name, src: value })
        }
        builder.emit({ op: 'move', dst, src: value })
        builder.emit({ op: 'label', name: endLabel })
        return dst
      }

      const value = this.compileExpression(expression.right, builder, scope)
      const result = this.binary(baseOp, currentValue, value, builder)
      const binding = builder.resolve(scope, expression.left.name)
      if (binding.kind === 'slot') {
        builder.emit({ op: 'store_slot', strict: builder.strict, depth: binding.depth, slot: binding.slot, src: result })
      } else {
        builder.emit({ op: 'store_global', strict: builder.strict, name: binding.name, src: result })
      }
      return result
    }

    if (t.isMemberExpression(expression.left)) {
      const object = this.compileExpression(expression.left.object as t.Expression, builder, scope)
      const property = expression.left.computed
        ? this.compileExpression(expression.left.property as t.Expression, builder, scope)
        : this.loadLiteral((expression.left.property as t.Identifier).name, builder)

      const currentValue = builder.allocReg()
      builder.emit({ op: 'get_prop', dst: currentValue, object, property })

      if (isLogicalAssign) {
        const dst = builder.allocReg()
        builder.emit({ op: 'move', dst, src: currentValue })
        const endLabel = builder.label('compound_end')

        if (baseOp === '&&') {
          builder.emit({ op: 'jump_if_false', condition: currentValue, target: endLabel })
        } else if (baseOp === '||') {
          const evalLabel = builder.label('compound_eval')
          builder.emit({ op: 'jump_if_false', condition: currentValue, target: evalLabel })
          builder.emit({ op: 'jump', target: endLabel })
          builder.emit({ op: 'label', name: evalLabel })
        } else {
          builder.emit({ op: 'jump_if_not_nullish', condition: currentValue, target: endLabel })
        }

        const value = this.compileExpression(expression.right, builder, scope)
        builder.emit({ op: 'set_prop', strict: builder.strict, dst, object, property, value })
        builder.emit({ op: 'label', name: endLabel })
        return dst
      }

      const value = this.compileExpression(expression.right, builder, scope)
      const result = this.binary(baseOp, currentValue, value, builder)
      const dst = builder.allocReg()
      builder.emit({ op: 'set_prop', strict: builder.strict, dst, object, property, value: result })
      return dst
    }

    throw new Error('Unsupported assignment target')
  }

  private compileUpdateExpression(expression: t.UpdateExpression, builder: FunctionBuilder, scope: ScopeFrame): number {
    if (t.isIdentifier(expression.argument)) {
      const value = this.compileExpression(expression.argument, builder, scope)
      const current = this.unary('to_numeric', value, builder)
      const updated = this.unary(expression.operator, current, builder)
      const binding = builder.resolve(scope, expression.argument.name)
      if (binding.kind === 'slot') {
        builder.emit({ op: 'store_slot', strict: builder.strict, depth: binding.depth, slot: binding.slot, src: updated })
      } else {
        builder.emit({ op: 'store_global', strict: builder.strict, name: binding.name, src: updated })
      }
      return expression.prefix ? updated : current
    }

    if (t.isMemberExpression(expression.argument)) {
      const object = this.compileExpression(expression.argument.object as t.Expression, builder, scope)
      const property = expression.argument.computed
        ? this.compileExpression(expression.argument.property as t.Expression, builder, scope)
        : this.loadLiteral((expression.argument.property as t.Identifier).name, builder)
      const value = builder.allocReg()
      builder.emit({ op: 'get_prop', dst: value, object, property })
      const current = this.unary('to_numeric', value, builder)
      const updated = this.unary(expression.operator, current, builder)
      const setDst = builder.allocReg()
      builder.emit({ op: 'set_prop', strict: builder.strict, dst: setDst, object, property, value: updated })
      return expression.prefix ? updated : current
    }

    throw new Error('Unsupported update expression target')
  }

  private compileCallExpression(expression: t.CallExpression, builder: FunctionBuilder, scope: ScopeFrame): number {
    let callee: number
    let thisReg = -1

    if (t.isMemberExpression(expression.callee)) {
      const object = this.compileExpression(expression.callee.object as t.Expression, builder, scope)
      const property = expression.callee.computed
        ? this.compileExpression(expression.callee.property as t.Expression, builder, scope)
        : this.loadLiteral((expression.callee.property as t.Identifier).name, builder)
      callee = builder.allocReg()
      builder.emit({ op: 'get_prop', dst: callee, object, property })
      thisReg = object
    } else {
      callee = this.compileExpression(expression.callee as t.Expression, builder, scope)
    }

    const args = expression.arguments.map((arg) => {
      if (!t.isExpression(arg)) {
        throw new Error('Spread arguments are not supported in script-vm-next v0.1')
      }
      return this.compileExpression(arg, builder, scope)
    })

    const dst = builder.allocReg()
    builder.emit({ op: 'call', dst, callee, thisReg, args })
    return dst
  }

  private binary(operator: string, left: number, right: number, builder: FunctionBuilder): number {
    const dst = builder.allocReg()
    builder.emit({ op: 'binary', dst, left, right, operator })
    return dst
  }

  private unary(operator: string, value: number, builder: FunctionBuilder): number {
    const dst = builder.allocReg()
    builder.emit({ op: 'unary', dst, value, operator })
    return dst
  }

  private loadUndefined(builder: FunctionBuilder): number {
    const dst = builder.allocReg()
    builder.emit({ op: 'load_undefined', dst })
    return dst
  }

  private loadLiteral(value: any, builder: FunctionBuilder): number {
    const dst = builder.allocReg()
    builder.emit({ op: 'load_const', dst, value })
    return dst
  }

  private loadLiteralKey(key: t.Expression | t.Identifier, builder: FunctionBuilder, scope: ScopeFrame): number {
    if (t.isIdentifier(key)) {
      return this.loadLiteral(key.name, builder)
    }
    if (t.isStringLiteral(key) || t.isNumericLiteral(key)) {
      return this.loadLiteral(key.value, builder)
    }
    if (t.isExpression(key)) {
      return this.compileExpression(key, builder, scope)
    }
    throw new Error('Unsupported object key')
  }
}

export function lowerToIR(file: t.File, exportsIdentifier = '__exports'): LoweredProgram {
  const lowerer = new ModuleLowerer(exportsIdentifier)
  return lowerer.compile(file)
}
