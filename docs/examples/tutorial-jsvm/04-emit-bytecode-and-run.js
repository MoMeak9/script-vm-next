const parser = require('@babel/parser')

const OPCODES = {
  LOAD_CONST: 1,
  LOAD_UNDEFINED: 2,
  LOAD_SLOT: 3,
  INIT_SLOT: 4,
  STORE_SLOT: 5,
  LOAD_GLOBAL: 6,
  STORE_GLOBAL: 7,
  BINARY: 8,
  JUMP: 9,
  JUMP_IF_FALSE: 10,
  RETURN: 11,
}

const BINARY_OPS = {
  '+': 1,
  '>': 2,
}

class Builder {
  constructor() {
    this.slotMap = new Map()
    this.slotNames = []
    this.instructions = []
    this.regCount = 0
    this.labelCounter = 0
  }

  predeclareVar(name) {
    if (!this.slotMap.has(name)) {
      this.slotMap.set(name, this.slotNames.length)
      this.slotNames.push(name)
    }
  }

  allocReg() {
    const reg = this.regCount
    this.regCount += 1
    return reg
  }

  emit(instruction) {
    this.instructions.push(instruction)
  }

  label(prefix) {
    const name = `${prefix}_${this.labelCounter}`
    this.labelCounter += 1
    return name
  }

  resolve(name) {
    if (this.slotMap.has(name)) {
      return { kind: 'slot', slot: this.slotMap.get(name) }
    }

    return { kind: 'global', name }
  }
}

function compileExpression(node, builder) {
  switch (node.type) {
    case 'NumericLiteral': {
      const dst = builder.allocReg()
      builder.emit({ op: 'load_const', dst, value: node.value })
      return dst
    }
    case 'Identifier': {
      const dst = builder.allocReg()
      const binding = builder.resolve(node.name)

      if (binding.kind === 'slot') {
        builder.emit({ op: 'load_slot', dst, slot: binding.slot })
      } else {
        builder.emit({ op: 'load_global', dst, name: binding.name })
      }

      return dst
    }
    case 'BinaryExpression': {
      const left = compileExpression(node.left, builder)
      const right = compileExpression(node.right, builder)
      const dst = builder.allocReg()
      builder.emit({
        op: 'binary',
        dst,
        left,
        right,
        operator: node.operator,
      })
      return dst
    }
    default:
      throw new Error(`Unsupported expression: ${node.type}`)
  }
}

function compileAssignment(left, right, builder) {
  const valueReg = compileExpression(right, builder)
  const binding = builder.resolve(left.name)

  if (binding.kind === 'slot') {
    builder.emit({ op: 'store_slot', slot: binding.slot, src: valueReg })
  } else {
    builder.emit({ op: 'store_global', name: binding.name, src: valueReg })
  }
}

function compileStatement(node, builder) {
  switch (node.type) {
    case 'BlockStatement':
      for (const statement of node.body) {
        compileStatement(statement, builder)
      }
      return
    case 'VariableDeclaration':
      for (const declaration of node.declarations) {
        const slot = builder.resolve(declaration.id.name).slot
        const initReg = compileExpression(declaration.init, builder)
        builder.emit({ op: 'init_slot', slot, src: initReg })
      }
      return
    case 'ExpressionStatement': {
      const expression = node.expression
      if (expression.type !== 'AssignmentExpression' || expression.operator !== '=') {
        throw new Error(`Unsupported expression statement: ${expression.type}`)
      }
      compileAssignment(expression.left, expression.right, builder)
      return
    }
    case 'IfStatement': {
      const elseLabel = builder.label('if_else')
      const endLabel = builder.label('if_end')
      const condition = compileExpression(node.test, builder)

      builder.emit({ op: 'jump_if_false', condition, target: elseLabel })
      compileStatement(node.consequent, builder)
      builder.emit({ op: 'jump', target: endLabel })
      builder.emit({ op: 'label', name: elseLabel })

      if (node.alternate) {
        compileStatement(node.alternate, builder)
      }

      builder.emit({ op: 'label', name: endLabel })
      return
    }
    default:
      throw new Error(`Unsupported statement: ${node.type}`)
  }
}

function compileSourceToIR(source) {
  const ast = parser.parse(source, { sourceType: 'script' })
  const builder = new Builder()

  for (const statement of ast.program.body) {
    if (statement.type === 'VariableDeclaration' && statement.kind === 'var') {
      for (const declaration of statement.declarations) {
        builder.predeclareVar(declaration.id.name)
      }
    }
  }

  for (const statement of ast.program.body) {
    compileStatement(statement, builder)
  }

  const endReg = builder.allocReg()
  builder.emit({ op: 'load_undefined', dst: endReg })
  builder.emit({ op: 'return', src: endReg })

  return {
    slotNames: builder.slotNames,
    registerCount: builder.regCount,
    instructions: builder.instructions,
  }
}

class ConstantPool {
  constructor() {
    this.values = []
    this.indexMap = new Map()
  }

  add(value) {
    const key = JSON.stringify(value)
    if (this.indexMap.has(key)) {
      return this.indexMap.get(key)
    }

    const index = this.values.length
    this.values.push(value)
    this.indexMap.set(key, index)
    return index
  }
}

function emitBytecode(ir) {
  const pool = new ConstantPool()
  const bytecode = []
  const labels = new Map()
  const fixups = []

  for (const instruction of ir.instructions) {
    if (instruction.op === 'label') {
      labels.set(instruction.name, bytecode.length)
      continue
    }

    switch (instruction.op) {
      case 'load_const':
        bytecode.push(OPCODES.LOAD_CONST, instruction.dst, pool.add(instruction.value))
        break
      case 'load_undefined':
        bytecode.push(OPCODES.LOAD_UNDEFINED, instruction.dst)
        break
      case 'load_slot':
        bytecode.push(OPCODES.LOAD_SLOT, instruction.dst, instruction.slot)
        break
      case 'init_slot':
        bytecode.push(OPCODES.INIT_SLOT, instruction.slot, instruction.src)
        break
      case 'store_slot':
        bytecode.push(OPCODES.STORE_SLOT, instruction.slot, instruction.src)
        break
      case 'load_global':
        bytecode.push(OPCODES.LOAD_GLOBAL, instruction.dst, pool.add(instruction.name))
        break
      case 'store_global':
        bytecode.push(OPCODES.STORE_GLOBAL, pool.add(instruction.name), instruction.src)
        break
      case 'binary':
        bytecode.push(
          OPCODES.BINARY,
          instruction.dst,
          instruction.left,
          instruction.right,
          BINARY_OPS[instruction.operator]
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
      case 'return':
        bytecode.push(OPCODES.RETURN, instruction.src)
        break
      default:
        throw new Error(`Unsupported IR op: ${instruction.op}`)
    }
  }

  for (const fixup of fixups) {
    const target = labels.get(fixup.target)
    if (target === undefined) {
      throw new Error(`Unknown label: ${fixup.target}`)
    }
    bytecode[fixup.index] = target
  }

  return {
    slotCount: ir.slotNames.length,
    registerCount: ir.registerCount,
    constants: pool.values,
    bytecode,
  }
}

function run(program, globalObject = {}) {
  const regs = new Array(program.registerCount)
  const env = {
    values: new Array(program.slotCount).fill(undefined),
  }
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
      case OPCODES.LOAD_UNDEFINED: {
        const dst = code[pc++]
        regs[dst] = undefined
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
        env.values[slot] = regs[src]
        break
      }
      case OPCODES.STORE_SLOT: {
        const slot = code[pc++]
        const src = code[pc++]
        env.values[slot] = regs[src]
        break
      }
      case OPCODES.LOAD_GLOBAL: {
        const dst = code[pc++]
        const nameIndex = code[pc++]
        regs[dst] = globalObject[program.constants[nameIndex]]
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

        switch (binaryOp) {
          case BINARY_OPS['+']:
            regs[dst] = left + right
            break
          case BINARY_OPS['>']:
            regs[dst] = left > right
            break
          default:
            throw new Error(`Unsupported binary op: ${binaryOp}`)
        }
        break
      }
      case OPCODES.JUMP:
        pc = code[pc]
        break
      case OPCODES.JUMP_IF_FALSE: {
        const condition = regs[code[pc++]]
        const target = code[pc++]
        if (!condition) {
          pc = target
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

function compileAndRunSource(source, globalObject = {}) {
  const ir = compileSourceToIR(source)
  const program = emitBytecode(ir)
  run(program, globalObject)
  return globalObject.__result
}

if (require.main === module) {
  const source = `
var x = 40 + 2;
if (x > 20) {
  __result = x;
} else {
  __result = 0;
}
`

  const ir = compileSourceToIR(source)
  const program = emitBytecode(ir)
  const globalObject = {}

  console.log('=== IR ===')
  console.log(JSON.stringify(ir, null, 2))
  console.log('=== Program ===')
  console.log(JSON.stringify(program, null, 2))
  console.log('=== Result ===')
  console.log(run(program, globalObject), globalObject)
}

module.exports = {
  compileSourceToIR,
  emitBytecode,
  run,
  compileAndRunSource,
}
