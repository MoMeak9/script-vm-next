const parser = require('@babel/parser')

class Builder {
  constructor() {
    this.slotMap = new Map()
    this.slotNames = []
    this.instructions = []
    this.regCount = 0
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

function compileStatement(node, builder) {
  switch (node.type) {
    case 'VariableDeclaration': {
      for (const declaration of node.declarations) {
        const slot = builder.resolve(declaration.id.name).slot
        const initReg = compileExpression(declaration.init, builder)
        builder.emit({ op: 'init_slot', slot, src: initReg })
      }
      return
    }
    case 'ExpressionStatement': {
      const expression = node.expression
      if (expression.type !== 'AssignmentExpression' || expression.operator !== '=') {
        throw new Error(`Unsupported statement: ${node.type}`)
      }

      const valueReg = compileExpression(expression.right, builder)
      const binding = builder.resolve(expression.left.name)

      if (binding.kind === 'slot') {
        builder.emit({ op: 'store_slot', slot: binding.slot, src: valueReg })
      } else {
        builder.emit({ op: 'store_global', name: binding.name, src: valueReg })
      }
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

  return {
    slotNames: builder.slotNames,
    registerCount: builder.regCount,
    instructions: builder.instructions,
  }
}

if (require.main === module) {
  const source = `
var x = 40 + 2;
__result = x;
`

  const ir = compileSourceToIR(source)
  console.log(JSON.stringify(ir, null, 2))
}

module.exports = {
  compileSourceToIR,
}
