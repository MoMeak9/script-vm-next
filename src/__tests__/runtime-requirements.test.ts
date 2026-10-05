import { describe, expect, it } from 'vitest'
import { compileSource } from '../core'
import { analyzeRuntimeRequirements } from '../compiler/runtime-requirements'
import type { ProgramArtifact } from '../compiler/types'
import { BINARY_OPS, OPCODES, UNARY_OPS } from '../runtime/opcodes'

function artifact(bytecode: number[], constantPool: any[] = []): ProgramArtifact {
  return {
    format: 'iife', bytecode, constantPool, entryFunctionId: 0, exportNames: [],
    functions: [{
      id: 0, name: null, entry: 0, end: bytecode.length, registerCount: 64,
      slotCount: 2, slotNames: ['a', 'b'], slotKinds: ['var', 'var'],
      params: 0, parameterSlots: [], simpleParameters: true,
      async: false, generator: false, strict: false, method: false, module: false, length: 0,
    }],
  }
}

describe('runtime requirement analysis', () => {
  it('collects only the actual console program instruction set', () => {
    const output = compileSource('console.log("hello")')
    expect(output.artifact.runtimeRequirements).toEqual({
      version: 1,
      opcodes: ['LOAD_CONST', 'LOAD_GLOBAL', 'GET_PROP', 'CALL', 'RETURN', 'LOAD_UNDEFINED'],
      binaryOperators: [], unaryOperators: [], intrinsics: [],
      functionKinds: ['sync'], needsArguments: false, needsDynamicImport: false,
    })
    expect(analyzeRuntimeRequirements(output.artifact)).toEqual(output.artifact.runtimeRequirements)
  })

  it('does not mistake register operands, counts or constants for opcodes/helpers', () => {
    const input = artifact([
      OPCODES.LOAD_CONST, OPCODES.YIELD, 0,
      OPCODES.CALL, 0, 1, -1, 2, OPCODES.AWAIT, OPCODES.MAKE_FUNCTION,
      OPCODES.NEW, 0, 1, 2, OPCODES.LOAD_ARGUMENTS, OPCODES.YIELD,
      OPCODES.ENTER_SCOPE, 2, 0, 1,
      OPCODES.REPLACE_SCOPE, 2, 0, 1,
      OPCODES.LEAVE_SCOPE,
      OPCODES.RETURN, 0,
    ], ['@script-vm/intrinsic/GetTemplateObject'])
    expect(analyzeRuntimeRequirements(input)).toMatchObject({
      opcodes: ['ENTER_SCOPE', 'LEAVE_SCOPE', 'REPLACE_SCOPE', 'LOAD_CONST', 'CALL', 'RETURN', 'NEW'],
      intrinsics: [], functionKinds: ['sync'], needsArguments: false,
    })
  })

  it('includes dormant callbacks and each execution kind, including generator parameters', () => {
    const { artifact: input } = compileSource(`
      function* values(a = 2) { yield a; }
      async function value() { return await Promise.resolve(1); }
      async function* asyncValues() { yield await Promise.resolve(2); }
      function callback(value) { return -value * 3; }
    `)
    const requirements = analyzeRuntimeRequirements(input)
    expect(requirements.functionKinds).toEqual(['sync', 'async', 'generator', 'async-generator'])
    expect(requirements.opcodes).toEqual(expect.arrayContaining(['AWAIT', 'YIELD', 'MAKE_FUNCTION', 'BINARY', 'UNARY']))
    expect(requirements.binaryOperators).toContain('*')
    expect(requirements.unaryOperators).toContain('-')
    expect(input.functions.some(fn => fn.generator && fn.parameterEnd !== undefined)).toBe(true)
  })

  it('keeps Arguments support for lexical arrows even without LOAD_ARGUMENTS', () => {
    const { artifact: input } = compileSource('function f() { return () => arguments[0]; }')
    expect(input.runtimeRequirements?.opcodes).not.toContain('LOAD_ARGUMENTS')
    expect(input.runtimeRequirements?.needsArguments).toBe(true)
  })

  it('collects lowered private helpers independently of source spelling', () => {
    const { artifact: input } = compileSource('var copy = [...new Set([1, 2])]; var obj = { [copy[0]]: 3 };')
    expect(input.runtimeRequirements?.intrinsics).toEqual(expect.arrayContaining([
      '@script-vm/intrinsic/IteratorStart', '@script-vm/intrinsic/ObjectDefineData',
    ]))
    expect(input.runtimeRequirements?.intrinsics).toEqual([...input.runtimeRequirements!.intrinsics].sort())
  })

  it('records operator codes separately from same-valued registers', () => {
    const input = artifact([
      OPCODES.BINARY, 0, BINARY_OPS['**'], BINARY_OPS['in'], BINARY_OPS['+'],
      OPCODES.UNARY, 1, UNARY_OPS['++'], UNARY_OPS['!'],
      OPCODES.RETURN, 0,
    ])
    expect(analyzeRuntimeRequirements(input)).toMatchObject({ binaryOperators: ['+'], unaryOperators: ['!'] })
  })

  it('detects the existing dynamic-import bridge only when read as a global', () => {
    const constantOnly = artifact([OPCODES.LOAD_CONST, 0, 0, OPCODES.RETURN, 0], ['__vm_import'])
    expect(analyzeRuntimeRequirements(constantOnly).needsDynamicImport).toBe(false)
    constantOnly.bytecode[0] = OPCODES.LOAD_GLOBAL
    expect(analyzeRuntimeRequirements(constantOnly).needsDynamicImport).toBe(true)
  })

  it('recomputes requirements for absent, stale and serialized manifests', () => {
    const { artifact: input } = compileSource('var obj = { value: 1 }; __result = obj.value + 2')
    const expected = analyzeRuntimeRequirements(input)
    delete input.runtimeRequirements
    expect(analyzeRuntimeRequirements(input)).toEqual(expected)
    input.runtimeRequirements = compileSource('').artifact.runtimeRequirements
    expect(analyzeRuntimeRequirements(JSON.parse(JSON.stringify(input)))).toEqual(expected)
  })

  it('accepts branch destinations and parameter boundaries at function end', () => {
    const input = artifact([OPCODES.JUMP, 2])
    input.functions[0].parameterEnd = 2
    expect(analyzeRuntimeRequirements(input).opcodes).toEqual(['JUMP'])
  })

  it('accepts lexical slots in outer functions with more slots than the current function', () => {
    const input = artifact([OPCODES.LOAD_SLOT, 0, 1, 100, OPCODES.RETURN, 0])
    expect(analyzeRuntimeRequirements(input).opcodes).toContain('LOAD_SLOT')
  })

  it('decodes bound and optional catch parameters along with variable scope lengths', () => {
    const { artifact: input } = compileSource(`
      function f(a, b = 1) {
        try { let value = a + b; throw value; } catch (error) { return error; } finally { __result = 1; }
      }
      try { throw 1; } catch { __result = 2; }
    `)
    expect(analyzeRuntimeRequirements(input).opcodes).toEqual(expect.arrayContaining(['TRY', 'ENTER_SCOPE', 'LEAVE_SCOPE']))
  })

  it.each([
    ['unknown opcode', [9999]],
    ['truncated instruction', [OPCODES.LOAD_CONST, 0]],
    ['invalid register', [OPCODES.LOAD_UNDEFINED, 64]],
    ['negative register', [OPCODES.RETURN, -1]],
    ['invalid constant index', [OPCODES.LOAD_CONST, 0, 10]],
    ['non-string global name', [OPCODES.LOAD_GLOBAL, 0, 0]],
    ['invalid strict flag', [OPCODES.SET_PROP, 0, 1, 2, 3, 2]],
    ['invalid binary operator', [OPCODES.BINARY, 0, 1, 2, 999]],
    ['invalid unary operator', [OPCODES.UNARY, 0, 1, 999]],
    ['invalid function reference', [OPCODES.MAKE_FUNCTION, 0, 1]],
    ['jump into operand', [OPCODES.JUMP, 1]],
    ['jump outside function', [OPCODES.JUMP, 99]],
    ['negative variable length', [OPCODES.CALL, 0, 1, -1, -1]],
    ['noninteger variable length', [OPCODES.NEW, 0, 1, 1.5]],
    ['missing variable length', [OPCODES.NEW, 0, 1]],
    ['truncated variable operands', [OPCODES.ENTER_SCOPE, 2, 0]],
    ['invalid local slot', [OPCODES.ENTER_SCOPE, 1, 2]],
    ['invalid catch slot', [OPCODES.TRY, 7, 7, 7, 7, 0, 2]],
    ['invalid catch depth', [OPCODES.TRY, 7, 7, 7, 7, -2, -1]],
    ['try destination inside operand', [OPCODES.TRY, 1, 7, 7, 7, -1, -1]],
    ['await in sync function', [OPCODES.AWAIT, 0, 1]],
    ['yield in non-generator', [OPCODES.YIELD, 0, 1, 0]],
    ['noninteger operand', [OPCODES.RETURN, NaN]],
  ])('rejects %s before assembling a runtime', (_name, bytecode) => {
    expect(() => analyzeRuntimeRequirements(artifact(bytecode as number[], [42]))).toThrow('Invalid program artifact:')
  })

  it.each([
    ['function id', (input: ProgramArtifact) => { input.functions[0].id = 1 }],
    ['function entry gap', (input: ProgramArtifact) => { input.functions[0].entry = 1 }],
    ['function range', (input: ProgramArtifact) => { input.functions[0].end += 1 }],
    ['trailing bytecode', (input: ProgramArtifact) => { input.bytecode.push(OPCODES.NOP) }],
    ['entry reference', (input: ProgramArtifact) => { input.entryFunctionId = 1 }],
    ['arguments slot', (input: ProgramArtifact) => { input.functions[0].argumentsSlot = 2 }],
    ['parameter slot', (input: ProgramArtifact) => { input.functions[0].parameterSlots = [0] }],
    ['parameter boundary', (input: ProgramArtifact) => { input.functions[0].parameterEnd = 1 }],
    ['parameter end', (input: ProgramArtifact) => { input.functions[0].parameterEnd = 99 }],
    ['slot kind', (input: ProgramArtifact) => { input.functions[0].slotKinds[0] = 'bad' as any }],
    ['execution kind', (input: ProgramArtifact) => { input.functions[0].async = 'false' as any }],
  ])('rejects malformed %s metadata', (_name, mutate) => {
    const input = artifact([OPCODES.LOAD_UNDEFINED, 0, OPCODES.RETURN, 0])
    mutate(input)
    expect(() => analyzeRuntimeRequirements(input)).toThrow('Invalid program artifact:')
  })

  it('rejects overlapping function ranges even when both decode individually', () => {
    const input = artifact([OPCODES.NOP, OPCODES.NOP])
    input.functions.push({ ...input.functions[0], id: 1, entry: 1 })
    expect(() => analyzeRuntimeRequirements(input)).toThrow('overlaps another function')
  })

  it('rejects an instruction spilling into the following function', () => {
    const input = artifact([OPCODES.LOAD_CONST, 0, 0, OPCODES.RETURN, 0], [1])
    input.functions[0].end = 2
    input.functions.push({ ...input.functions[0], id: 1, entry: 2, end: 5 })
    expect(() => analyzeRuntimeRequirements(input)).toThrow('truncated LOAD_CONST')
  })

  it('rejects a jump to a valid instruction in a different function', () => {
    const input = artifact([OPCODES.JUMP, 3, OPCODES.NOP, OPCODES.RETURN, 0])
    input.functions[0].end = 2
    input.functions.push({ ...input.functions[0], id: 1, entry: 2, end: 5 })
    expect(() => analyzeRuntimeRequirements(input)).toThrow('leaves function 0')
  })
})
