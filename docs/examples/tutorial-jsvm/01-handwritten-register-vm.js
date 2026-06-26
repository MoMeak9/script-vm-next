const OPCODES = {
  LOAD_CONST: 1,
  BINARY: 2,
  RETURN: 3,
}

const BINARY_OPS = {
  ADD: 1,
}

function run(program) {
  const regs = []
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
  constants: [40, 2],
  bytecode: [
    OPCODES.LOAD_CONST, 0, 0,
    OPCODES.LOAD_CONST, 1, 1,
    OPCODES.BINARY, 2, 0, 1, BINARY_OPS.ADD,
    OPCODES.RETURN, 2,
  ],
}

if (require.main === module) {
  const result = run(program)
  console.log('step01 result =', result)
}

module.exports = {
  OPCODES,
  BINARY_OPS,
  run,
}
