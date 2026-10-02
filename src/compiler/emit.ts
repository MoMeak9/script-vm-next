import { BINARY_OPS, OPCODES, UNARY_OPS } from '../runtime/opcodes'
import type { ProgramArtifact } from './types'
import type { AllocationResult } from './regalloc'

class ConstantPool {
  values: any[] = []
  map = new Map<unknown, number>()
  private readonly negativeZero = Symbol('negativeZero')

  add(value: any): number {
    // Map preserves primitive types and non-finite numbers. Its SameValueZero
    // comparison merges signed zeros, so give negative zero a separate key.
    const key = Object.is(value, -0) ? this.negativeZero : value
    if (this.map.has(key)) {
      return this.map.get(key)!
    }
    const index = this.values.length
    this.values.push(value)
    this.map.set(key, index)
    return index
  }
}

export function emitBytecode(program: AllocationResult, format: ProgramArtifact['format'], exportNames: string[], debug = false): ProgramArtifact {
  const pool = new ConstantPool()
  const functions = program.functions.map((fn) => ({
    id: fn.id,
    name: fn.name,
    entry: 0,
    end: 0,
    registerCount: fn.registerCount,
    slotCount: fn.slotNames.length,
    params: fn.params,
    slotNames: fn.slotNames,
    slotKinds: fn.slotKinds,
    async: fn.async,
    generator: fn.generator,
  }))

  const bytecode: number[] = []
  const debugInstructions: string[] = []

  for (const fn of program.functions) {
    const labels = new Map<string, number>()
    const fixups: Array<{ index: number; target: string }> = []
    functions[fn.id].entry = bytecode.length

    for (const instruction of fn.instructions) {
      if (instruction.op === 'label') {
        labels.set(instruction.name, bytecode.length)
        continue
      }

      debugInstructions.push(`${fn.id}:${JSON.stringify(instruction)}`)

      switch (instruction.op) {
        case 'enter_scope':
          bytecode.push(OPCODES.ENTER_SCOPE, instruction.slots.length, ...instruction.slots)
          break
        case 'leave_scope':
          bytecode.push(OPCODES.LEAVE_SCOPE)
          break
        case 'replace_scope':
          bytecode.push(OPCODES.REPLACE_SCOPE, instruction.slots.length, ...instruction.slots)
          break
        case 'load_const':
          bytecode.push(OPCODES.LOAD_CONST, instruction.dst, pool.add(instruction.value))
          break
        case 'load_undefined':
          bytecode.push(OPCODES.LOAD_UNDEFINED, instruction.dst)
          break
        case 'move':
          bytecode.push(OPCODES.MOVE, instruction.dst, instruction.src)
          break
        case 'load_slot':
          bytecode.push(OPCODES.LOAD_SLOT, instruction.dst, instruction.depth, instruction.slot)
          break
        case 'init_slot':
          bytecode.push(OPCODES.INIT_SLOT, instruction.depth, instruction.slot, instruction.src)
          break
        case 'store_slot':
          bytecode.push(OPCODES.STORE_SLOT, instruction.depth, instruction.slot, instruction.src)
          break
        case 'load_global':
          bytecode.push(OPCODES.LOAD_GLOBAL, instruction.dst, pool.add(instruction.name))
          break
        case 'store_global':
          bytecode.push(OPCODES.STORE_GLOBAL, pool.add(instruction.name), instruction.src)
          break
        case 'load_this':
          bytecode.push(OPCODES.LOAD_THIS, instruction.dst)
          break
        case 'load_arguments':
          bytecode.push(OPCODES.LOAD_ARGUMENTS, instruction.dst)
          break
        case 'get_prop':
          bytecode.push(OPCODES.GET_PROP, instruction.dst, instruction.object, instruction.property)
          break
        case 'set_prop':
          bytecode.push(OPCODES.SET_PROP, instruction.dst, instruction.object, instruction.property, instruction.value)
          break
        case 'binary':
          bytecode.push(
            OPCODES.BINARY,
            instruction.dst,
            instruction.left,
            instruction.right,
            BINARY_OPS[instruction.operator as keyof typeof BINARY_OPS]
          )
          break
        case 'unary':
          bytecode.push(
            OPCODES.UNARY,
            instruction.dst,
            instruction.value,
            UNARY_OPS[instruction.operator as keyof typeof UNARY_OPS]
          )
          break
        case 'jump':
          bytecode.push(OPCODES.JUMP, -1)
          fixups.push({ index: bytecode.length - 1, target: instruction.target })
          break
        case 'jump_if_false':
          bytecode.push(OPCODES.JUMP_IF_FALSE, instruction.condition, -1)
          fixups.push({ index: bytecode.length - 1, target: instruction.target })
          break
        case 'jump_if_not_nullish':
          bytecode.push(OPCODES.JUMP_IF_NOT_NULLISH, instruction.condition, -1)
          fixups.push({ index: bytecode.length - 1, target: instruction.target })
          break
        case 'try':
          bytecode.push(OPCODES.TRY, -1, -1, -1, -1, instruction.catchDepth, instruction.catchSlot)
          fixups.push({ index: bytecode.length - 6, target: instruction.tryStart })
          fixups.push({ index: bytecode.length - 5, target: instruction.catchStart ?? instruction.end })
          fixups.push({ index: bytecode.length - 4, target: instruction.finallyStart ?? instruction.end })
          fixups.push({ index: bytecode.length - 3, target: instruction.end })
          break
        case 'call':
          bytecode.push(OPCODES.CALL, instruction.dst, instruction.callee, instruction.thisReg, instruction.args.length, ...instruction.args)
          break
        case 'new':
          bytecode.push(OPCODES.NEW, instruction.dst, instruction.callee, instruction.args.length, ...instruction.args)
          break
        case 'await':
          bytecode.push(OPCODES.AWAIT, instruction.dst, instruction.src)
          break
        case 'yield':
          bytecode.push(OPCODES.YIELD, instruction.dst, instruction.src, Number(instruction.delegate))
          break
        case 'make_function':
          bytecode.push(OPCODES.MAKE_FUNCTION, instruction.dst, instruction.functionId)
          break
        case 'return':
          bytecode.push(OPCODES.RETURN, instruction.src)
          break
        case 'throw':
          bytecode.push(OPCODES.THROW, instruction.src)
          break
        case 'array_new':
          bytecode.push(OPCODES.ARRAY_NEW, instruction.dst)
          break
        case 'array_push':
          bytecode.push(OPCODES.ARRAY_PUSH, instruction.array, instruction.value)
          break
        case 'object_new':
          bytecode.push(OPCODES.OBJECT_NEW, instruction.dst)
          break
        case 'object_set':
          bytecode.push(OPCODES.OBJECT_SET, instruction.object, instruction.key, instruction.value)
          break
        case 'delete_prop':
          bytecode.push(OPCODES.DELETE_PROP, instruction.dst, instruction.object, instruction.property)
          break
        case 'load_new_target':
          bytecode.push(OPCODES.LOAD_NEW_TARGET, instruction.dst)
          break
      }
    }

    for (const fixup of fixups) {
      const target = labels.get(fixup.target)
      if (target === undefined) {
        throw new Error(`Unknown label: ${fixup.target}`)
      }
      bytecode[fixup.index] = target
    }
    functions[fn.id].end = bytecode.length
  }

  return {
    format,
    bytecode,
    constantPool: pool.values,
    functions,
    entryFunctionId: program.entryFunctionId,
    exportNames,
    debugInfo: debug ? { instructions: debugInstructions } : undefined,
  }
}
