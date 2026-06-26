const OPCODES = {
  LOAD_CONST: 1,
  LOAD_SLOT: 2,
  INIT_SLOT: 3,
  STORE_SLOT: 4,
  STORE_GLOBAL: 5,
  BINARY: 6,
  RETURN: 7,
}

const BINARY_OPS = {
  ADD: 1,
}

function createEnv(slotCount) {
  return {
    values: new Array(slotCount).fill(undefined),
    states: new Array(slotCount).fill(0),
  }
}

function writeSlot(env, slot, value, isInit) {
  if (isInit) {
    env.values[slot] = value
    env.states[slot] = 1
    return value
  }

  if (!env.states[slot]) {
    throw new Error(`slot ${slot} is not initialized`)
  }

  env.values[slot] = value
  return value
}

function run(program, globalObject = {}) {
  const regs = []
  const env = createEnv(program.slotCount)
  const code = program.bytecode
  let pc = 0

  while (pc < code.length) {
    const op = code[pc++]

    switch (op) {
      case OPCODES.LOAD_CONST: {
        const dst = code[pc++]
        const constIndex = code[pc++]
        regs[dst] = program.constants[constIndex]
        break
      }
      case OPCODES.LOAD_SLOT: {
        const dst = code[pc++]
        const slot = code[pc++]
        regs[dst] = env.values[slot]
        break
      }
      case OPCODES.INIT_SLOT: {
        const slot = code[pc++]
        const src = code[pc++]
        writeSlot(env, slot, regs[src], true)
        break
      }
      case OPCODES.STORE_SLOT: {
        const slot = code[pc++]
        const src = code[pc++]
        writeSlot(env, slot, regs[src], false)
        break
      }
      case OPCODES.STORE_GLOBAL: {
        const nameIndex = code[pc++]
        const src = code[pc++]
        globalObject[program.constants[nameIndex]] = regs[src]
        break
      }
      case OPCODES.BINARY: {
        const dst = code[pc++]
        const left = regs[code[pc++]]
        const right = regs[code[pc++]]
        const binaryOp = code[pc++]

        if (binaryOp !== BINARY_OPS.ADD) {
          throw new Error(`Unsupported binary op: ${binaryOp}`)
        }

        regs[dst] = left + right
        break
      }
      case OPCODES.RETURN: {
        const src = code[pc++]
        return regs[src]
      }
      default:
        throw new Error(`Unknown opcode: ${op}`)
    }
  }

  return undefined
}

const program = {
  slotCount: 1,
  constants: [40, 2, '__result'],
  bytecode: [
    OPCODES.LOAD_CONST, 0, 0,
    OPCODES.LOAD_CONST, 1, 1,
    OPCODES.BINARY, 2, 0, 1, BINARY_OPS.ADD,
    OPCODES.INIT_SLOT, 0, 2,
    OPCODES.LOAD_SLOT, 3, 0,
    OPCODES.STORE_GLOBAL, 2, 3,
    OPCODES.RETURN, 3,
  ],
}

if (require.main === module) {
  const globalObject = {}
  const result = run(program, globalObject)
  console.log('step02 result =', result)
  console.log('step02 global =', globalObject)
}

module.exports = {
  OPCODES,
  BINARY_OPS,
  createEnv,
  run,
}
