const OPCODES = {
  LOAD_THIS: 1,
  LOAD_ARGUMENTS: 2,
  LOAD_CONST: 3,
  GET_PROP: 4,
  ARRAY_NEW: 5,
  ARRAY_PUSH: 6,
  RETURN: 7,
}

function createRuntime(program) {
  function execute(functionId, thisValue, args) {
    const meta = program.functions[functionId]
    const regs = new Array(meta.registerCount)
    const code = meta.bytecode
    let pc = 0

    while (pc < code.length) {
      const op = code[pc++]

      switch (op) {
        case OPCODES.LOAD_THIS: {
          const dst = code[pc++]
          regs[dst] = thisValue
          break
        }
        case OPCODES.LOAD_ARGUMENTS: {
          const dst = code[pc++]
          regs[dst] = args
          break
        }
        case OPCODES.LOAD_CONST: {
          const dst = code[pc++]
          const constIndex = code[pc++]
          regs[dst] = program.constants[constIndex]
          break
        }
        case OPCODES.GET_PROP: {
          const dst = code[pc++]
          const object = regs[code[pc++]]
          const property = regs[code[pc++]]
          regs[dst] = object[property]
          break
        }
        case OPCODES.ARRAY_NEW: {
          const dst = code[pc++]
          regs[dst] = []
          break
        }
        case OPCODES.ARRAY_PUSH: {
          const array = regs[code[pc++]]
          const value = regs[code[pc++]]
          array.push(value)
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
  constants: ['label', 'length'],
  functions: [
    {
      registerCount: 7,
      bytecode: [
        OPCODES.LOAD_THIS, 0,
        OPCODES.LOAD_CONST, 1, 0,
        OPCODES.GET_PROP, 2, 0, 1,
        OPCODES.LOAD_ARGUMENTS, 3,
        OPCODES.LOAD_CONST, 4, 1,
        OPCODES.GET_PROP, 5, 3, 4,
        OPCODES.ARRAY_NEW, 6,
        OPCODES.ARRAY_PUSH, 6, 2,
        OPCODES.ARRAY_PUSH, 6, 5,
        OPCODES.RETURN, 6,
      ],
    },
  ],
}

function runThisDemo() {
  const runtime = createRuntime(program)
  return runtime.execute(0, { label: 'box' }, [10, 20, 30])
}

if (require.main === module) {
  console.log('step05 this/arguments =', runThisDemo())
}

module.exports = {
  createRuntime,
  runThisDemo,
}
