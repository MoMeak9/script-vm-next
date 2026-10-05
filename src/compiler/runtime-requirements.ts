import { BINARY_OPS, OPCODES, UNARY_OPS } from '../runtime/opcodes'
import type { OpcodeName } from '../runtime/opcodes'
import type { FunctionMeta, ProgramArtifact, RuntimeRequirements } from './types'

type Operand = 'register' | 'receiver' | 'constant' | 'name' | 'depth' | 'slot' | 'localSlot'
  | 'catchDepth' | 'catchSlot' | 'flag' | 'target' | 'function' | 'binary' | 'unary'

interface InstructionSchema {
  operands: readonly Operand[]
  /** A count follows the fixed operands, then exactly that many operands. */
  repeated?: Operand
}

// Bytecode values cannot be scanned as a Set: register numbers, constants and
// jump destinations overlap opcode values. Keep every instruction's layout in
// one exhaustive schema and decode each function independently.
const SCHEMA: Record<OpcodeName, InstructionSchema> = {
  ENTER_SCOPE: { operands: [], repeated: 'localSlot' },
  LEAVE_SCOPE: { operands: [] },
  REPLACE_SCOPE: { operands: [], repeated: 'localSlot' },
  LOAD_CONST: { operands: ['register', 'constant'] },
  MOVE: { operands: ['register', 'register'] },
  LOAD_SLOT: { operands: ['register', 'depth', 'slot'] },
  INIT_SLOT: { operands: ['depth', 'slot', 'register'] },
  STORE_SLOT: { operands: ['depth', 'slot', 'register', 'flag'] },
  LOAD_GLOBAL: { operands: ['register', 'name'] },
  STORE_GLOBAL: { operands: ['name', 'register', 'flag'] },
  GET_PROP: { operands: ['register', 'register', 'register'] },
  SET_PROP: { operands: ['register', 'register', 'register', 'register', 'flag'] },
  BINARY: { operands: ['register', 'register', 'register', 'binary'] },
  UNARY: { operands: ['register', 'register', 'unary'] },
  JUMP: { operands: ['target'] },
  JUMP_IF_FALSE: { operands: ['register', 'target'] },
  CALL: { operands: ['register', 'register', 'receiver'], repeated: 'register' },
  MAKE_FUNCTION: { operands: ['register', 'function'] },
  RETURN: { operands: ['register'] },
  LOAD_THIS: { operands: ['register'] },
  LOAD_ARGUMENTS: { operands: ['register'] },
  ARRAY_NEW: { operands: ['register'] },
  OBJECT_NEW: { operands: ['register'] },
  ARRAY_PUSH: { operands: ['register', 'register'] },
  OBJECT_SET: { operands: ['register', 'register', 'register'] },
  LOAD_UNDEFINED: { operands: ['register'] },
  NEW: { operands: ['register', 'register'], repeated: 'register' },
  THROW: { operands: ['register'] },
  TRY: { operands: ['target', 'target', 'target', 'target', 'catchDepth', 'catchSlot'] },
  AWAIT: { operands: ['register', 'register'] },
  YIELD: { operands: ['register', 'register', 'flag'] },
  JUMP_IF_NOT_NULLISH: { operands: ['register', 'target'] },
  DELETE_PROP: { operands: ['register', 'register', 'register', 'flag'] },
  LOAD_NEW_TARGET: { operands: ['register'] },
  TYPEOF_GLOBAL: { operands: ['register', 'name'] },
  ABRUPT_JUMP: { operands: ['target', 'depth'] },
  NOP: { operands: [] },
}

const opcodeNames = new Map<number, OpcodeName>(Object.entries(OPCODES).map(([name, code]) => [code, name as OpcodeName]))
const binaryNames = new Map<number, string>(Object.entries(BINARY_OPS).map(([name, code]) => [code, name]))
const unaryNames = new Map<number, string>(Object.entries(UNARY_OPS).map(([name, code]) => [code, name]))
const FUNCTION_KINDS: RuntimeRequirements['functionKinds'] = ['sync', 'async', 'generator', 'async-generator']
const SLOT_KINDS = new Set(['var', 'let', 'const', 'param', 'function', 'catch', 'function-name'])

function invalid(message: string): never {
  throw new Error(`Invalid program artifact: ${message}`)
}

function integer(value: number, minimum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) invalid(`${label} must be an integer >= ${minimum}`)
}

function validateFunction(fn: FunctionMeta, index: number, codeLength: number): void {
  if (!fn || fn.id !== index) invalid(`function ${index} must have matching id`)
  integer(fn.entry, 0, `function ${index} entry`)
  integer(fn.end, fn.entry + 1, `function ${index} end`)
  if (fn.end > codeLength) invalid(`function ${index} exceeds bytecode length`)
  integer(fn.registerCount, 0, `function ${index} registerCount`)
  integer(fn.slotCount, 0, `function ${index} slotCount`)
  integer(fn.params, 0, `function ${index} params`)
  integer(fn.length, 0, `function ${index} length`)
  for (const field of ['async', 'generator', 'strict', 'method', 'module', 'simpleParameters'] as const) {
    if (typeof fn[field] !== 'boolean') invalid(`function ${index} ${field} must be boolean`)
  }
  if (!Array.isArray(fn.slotNames) || fn.slotNames.length !== fn.slotCount || fn.slotNames.some(name => typeof name !== 'string')) {
    invalid(`function ${index} slotNames must match slotCount`)
  }
  if (!Array.isArray(fn.slotKinds) || fn.slotKinds.length !== fn.slotCount || fn.slotKinds.some(kind => !SLOT_KINDS.has(kind))) {
    invalid(`function ${index} slotKinds must match slotCount`)
  }
  if (!Array.isArray(fn.parameterSlots) || fn.parameterSlots.length !== fn.params) {
    invalid(`function ${index} parameterSlots must match params`)
  }
  for (const slot of [...fn.parameterSlots, ...(fn.argumentsSlot === undefined ? [] : [fn.argumentsSlot])]) {
    integer(slot, 0, `function ${index} parameter/arguments slot`)
    if (slot >= fn.slotCount) invalid(`function ${index} parameter/arguments slot exceeds slotCount`)
  }
  if (fn.parameterEnd !== undefined) {
    integer(fn.parameterEnd, fn.entry, `function ${index} parameterEnd`)
    if (fn.parameterEnd > fn.end) invalid(`function ${index} parameterEnd exceeds function end`)
  }
}

/**
 * Analyze the bytecode rather than trusting a saved capability manifest. This
 * supports older/manual artifacts and prevents stale or edited manifests from
 * silently omitting execution support. Malformed instructions fail at packing.
 * All functions are included even if their closures are only invoked by hosts.
 */
export function analyzeRuntimeRequirements(artifact: ProgramArtifact): RuntimeRequirements {
  if (!artifact || !Array.isArray(artifact.bytecode) || !Array.isArray(artifact.constantPool)
      || !Array.isArray(artifact.functions) || artifact.functions.length === 0) {
    invalid('bytecode, constantPool and nonempty functions arrays are required')
  }
  const { bytecode, constantPool, functions } = artifact
  integer(artifact.entryFunctionId, 0, 'entryFunctionId')
  if (artifact.entryFunctionId >= functions.length) invalid('entryFunctionId is out of range')
  for (let index = 0; index < functions.length; index++) validateFunction(functions[index], index, bytecode.length)
  const ranges = [...functions].sort((a, b) => a.entry - b.entry)
  let covered = 0
  for (const fn of ranges) {
    if (fn.entry !== covered) invalid(`function ${fn.id} leaves a gap or overlaps another function`)
    covered = fn.end
  }
  if (covered !== bytecode.length) invalid('bytecode extends beyond the final function')

  const opcodes = new Set<OpcodeName>()
  const binaryOperators = new Set<string>()
  const unaryOperators = new Set<string>()
  const intrinsics = new Set<string>()
  // The entry invocation and generator parameter initialization use sync code.
  const functionKinds = new Set<RuntimeRequirements['functionKinds'][number]>(['sync'])
  let needsArguments = false
  let needsDynamicImport = false

  for (const fn of functions) {
    functionKinds.add(fn.async ? (fn.generator ? 'async-generator' : 'async') : fn.generator ? 'generator' : 'sync')
    needsArguments ||= fn.argumentsSlot !== undefined
    const boundaries = new Set<number>([fn.end])
    const targets: number[] = []
    let pc = fn.entry
    while (pc < fn.end) {
      const address = pc
      boundaries.add(address)
      const opcode = opcodeNames.get(bytecode[pc++])
      if (!opcode) invalid(`unknown opcode ${bytecode[address]} at ${address}`)
      opcodes.add(opcode)
      if (opcode === 'AWAIT' && !fn.async) invalid(`AWAIT in non-async function ${fn.id}`)
      if (opcode === 'YIELD' && !fn.generator) invalid(`YIELD in non-generator function ${fn.id}`)
      if (opcode === 'LOAD_ARGUMENTS') needsArguments = true

      const operand = (kind: Operand): number => {
        if (pc >= fn.end) invalid(`truncated ${opcode} at ${address}`)
        const value = bytecode[pc++]
        integer(value, ['receiver', 'catchDepth', 'catchSlot'].includes(kind) ? -1 : 0, `${opcode} ${kind} at ${pc - 1}`)
        switch (kind) {
          case 'register': case 'receiver':
            if (value >= fn.registerCount) invalid(`register ${value} exceeds function ${fn.id} registerCount at ${address}`)
            break
          case 'localSlot': case 'catchSlot':
            if (value >= fn.slotCount) invalid(`slot ${value} exceeds function ${fn.id} slotCount at ${address}`)
            break
          case 'constant': case 'name':
            if (value >= constantPool.length) invalid(`constant ${value} is out of range at ${address}`)
            if (kind === 'name' && typeof constantPool[value] !== 'string') invalid(`global name must be a string at ${address}`)
            if (kind === 'name' && (opcode === 'LOAD_GLOBAL' || opcode === 'TYPEOF_GLOBAL')) {
              const name = constantPool[value] as string
              if (name.startsWith('@script-vm/intrinsic/')) intrinsics.add(name)
              if (name === '__vm_import') needsDynamicImport = true
            }
            break
          case 'flag':
            if (value !== 0 && value !== 1) invalid(`flag must be 0 or 1 at ${address}`)
            break
          case 'function':
            if (value >= functions.length) invalid(`function reference ${value} is out of range at ${address}`)
            break
          case 'target':
            if (value < fn.entry || value > fn.end) invalid(`jump target ${value} leaves function ${fn.id} at ${address}`)
            targets.push(value)
            break
          case 'binary': {
            const name = binaryNames.get(value)
            if (name === undefined) invalid(`unknown binary operator ${value} at ${address}`)
            binaryOperators.add(name)
            break
          }
          case 'unary': {
            const name = unaryNames.get(value)
            if (name === undefined) invalid(`unknown unary operator ${value} at ${address}`)
            unaryOperators.add(name)
            break
          }
          // Lexical slots may belong to enclosing functions/scopes; without a
          // serialized scope graph their upper bound is not this fn.slotCount.
          case 'slot': case 'depth': case 'catchDepth': break
        }
        return value
      }
      const schema = SCHEMA[opcode]
      for (const kind of schema.operands) operand(kind)
      if (schema.repeated) {
        if (pc >= fn.end) invalid(`truncated ${opcode} count at ${address}`)
        const count = bytecode[pc++]
        integer(count, 0, `${opcode} count at ${pc - 1}`)
        if (count > fn.end - pc) invalid(`truncated ${opcode} operands at ${address}`)
        for (let index = 0; index < count; index++) operand(schema.repeated)
      }
    }
    for (const target of targets) {
      if (!boundaries.has(target)) invalid(`jump target ${target} is not an instruction boundary in function ${fn.id}`)
    }
    if (fn.parameterEnd !== undefined && !boundaries.has(fn.parameterEnd)) {
      invalid(`function ${fn.id} parameterEnd is not an instruction boundary`)
    }
  }

  return {
    version: 1,
    opcodes: [...opcodeNames.values()].filter(name => opcodes.has(name)),
    binaryOperators: [...binaryNames.values()].filter(name => binaryOperators.has(name)),
    unaryOperators: [...unaryNames.values()].filter(name => unaryOperators.has(name)),
    intrinsics: [...intrinsics].sort(),
    functionKinds: FUNCTION_KINDS.filter(kind => functionKinds.has(kind)),
    needsArguments,
    needsDynamicImport,
  }
}
