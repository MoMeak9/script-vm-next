const OPCODES = {
  LOAD_CONST: 1,
  LOAD_SLOT: 2,
  STORE_SLOT: 3,
  BINARY: 4,
  MAKE_FUNCTION: 5,
  RETURN: 6,
}

const BINARY_OPS = {
  ADD: 1,
}

function resolveEnv(env, depth) {
  let current = env
  while (depth > 0) {
    current = current.parent
    depth -= 1
  }
  return current
}

function createEnv(meta, parentEnv) {
  return {
    values: new Array(meta.slotCount).fill(undefined),
    parent: parentEnv,
  }
}

function createRuntime(program) {
  function execute(functionId, parentEnv) {
    const meta = program.functions[functionId]
    const env = createEnv(meta, parentEnv)
    const regs = new Array(meta.registerCount)
    const code = meta.bytecode
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
          const depth = code[pc++]
          const slot = code[pc++]
          regs[dst] = resolveEnv(env, depth).values[slot]
          break
        }
        case OPCODES.STORE_SLOT: {
          const depth = code[pc++]
          const slot = code[pc++]
          const src = code[pc++]
          resolveEnv(env, depth).values[slot] = regs[src]
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
        case OPCODES.MAKE_FUNCTION: {
          const dst = code[pc++]
          const targetId = code[pc++]
          regs[dst] = function() {
            return execute(targetId, env)
          }
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

  return {
    execute,
  }
}

const program = {
  constants: [0, 1],
  functions: [
    {
      slotCount: 1,
      registerCount: 3,
      bytecode: [
        OPCODES.LOAD_CONST, 0, 0,
        OPCODES.STORE_SLOT, 0, 0, 0,
        OPCODES.MAKE_FUNCTION, 1, 1,
        OPCODES.RETURN, 1,
      ],
    },
    {
      slotCount: 0,
      registerCount: 4,
      bytecode: [
        OPCODES.LOAD_SLOT, 0, 1, 0,
        OPCODES.LOAD_CONST, 1, 1,
        OPCODES.BINARY, 2, 0, 1, BINARY_OPS.ADD,
        OPCODES.STORE_SLOT, 1, 0, 2,
        OPCODES.RETURN, 2,
      ],
    },
  ],
}

function runCounterDemo() {
  const runtime = createRuntime(program)
  const counter = runtime.execute(0, null)
  return [counter(), counter(), counter()]
}

if (require.main === module) {
  console.log('step05 closure =', runCounterDemo())
}

module.exports = {
  createRuntime,
  runCounterDemo,
}
