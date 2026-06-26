/**
 * 阶段二 示例 2：字节码解码器
 *
 * 将原始字节码数组反汇编为可读的指令文本。
 * 这是理解指令编码格式最直观的方式。
 * 运行方式：node docs/examples/02-instruction-set/02-bytecode-decoder.js
 */
const path = require('path')
const fs = require('fs')
const compile = require('../../../dist/compiler/pipeline').default
const { OPCODES, BINARY_OPS, UNARY_OPS } = require('../../../dist/runtime/opcodes')

// 反转映射表：数字 → 名字
const OP_NAMES = Object.fromEntries(Object.entries(OPCODES).map(([k, v]) => [v, k]))
const BINARY_NAMES = Object.fromEntries(Object.entries(BINARY_OPS).map(([k, v]) => [v, k]))
const UNARY_NAMES = Object.fromEntries(Object.entries(UNARY_OPS).map(([k, v]) => [v, k]))

// ═══════════════════════════════════════════════
// 编译源码
// ═══════════════════════════════════════════════
const source = `
var x = 10;
var y = x + 20;
if (y > 25) {
  __result = 'big';
} else {
  __result = 'small';
}
`

const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vm-decode-'))
const inputPath = path.join(tmpDir, 'input.js')
fs.writeFileSync(inputPath, source)
const { artifact } = compile(inputPath, null, { format: 'iife' })

// ═══════════════════════════════════════════════
// 反汇编
// ═══════════════════════════════════════════════
const { bytecode, constantPool, functions } = artifact

function disassemble(fn) {
  const lines = []
  let pc = fn.entry

  while (pc < fn.end) {
    const addr = pc
    const op = bytecode[pc++]
    const name = OP_NAMES[op] || `UNKNOWN(${op})`

    switch (op) {
      case OPCODES.ENTER_SCOPE: {
        const count = bytecode[pc++]
        const slots = []
        for (let i = 0; i < count; i++) slots.push(bytecode[pc++])
        lines.push(`${addr}: ENTER_SCOPE [${slots.join(',')}]`)
        break
      }
      case OPCODES.LEAVE_SCOPE:
        lines.push(`${addr}: LEAVE_SCOPE`)
        break
      case OPCODES.REPLACE_SCOPE: {
        const count = bytecode[pc++]
        const slots = []
        for (let i = 0; i < count; i++) slots.push(bytecode[pc++])
        lines.push(`${addr}: REPLACE_SCOPE [${slots.join(',')}]`)
        break
      }
      case OPCODES.LOAD_CONST: {
        const dst = bytecode[pc++]
        const idx = bytecode[pc++]
        lines.push(`${addr}: LOAD_CONST r${dst}, ${JSON.stringify(constantPool[idx])} (pool[${idx}])`)
        break
      }
      case OPCODES.LOAD_UNDEFINED: {
        const dst = bytecode[pc++]
        lines.push(`${addr}: LOAD_UNDEFINED r${dst}`)
        break
      }
      case OPCODES.MOVE: {
        const dst = bytecode[pc++]
        const src = bytecode[pc++]
        lines.push(`${addr}: MOVE r${dst}, r${src}`)
        break
      }
      case OPCODES.LOAD_SLOT: {
        const dst = bytecode[pc++]
        const depth = bytecode[pc++]
        const slot = bytecode[pc++]
        lines.push(`${addr}: LOAD_SLOT r${dst}, depth=${depth}, slot=${slot} (${fn.slotNames[slot] || '?'})`)
        break
      }
      case OPCODES.INIT_SLOT: {
        const depth = bytecode[pc++]
        const slot = bytecode[pc++]
        const src = bytecode[pc++]
        lines.push(`${addr}: INIT_SLOT depth=${depth}, slot=${slot} (${fn.slotNames[slot] || '?'}), r${src}`)
        break
      }
      case OPCODES.STORE_SLOT: {
        const depth = bytecode[pc++]
        const slot = bytecode[pc++]
        const src = bytecode[pc++]
        lines.push(`${addr}: STORE_SLOT depth=${depth}, slot=${slot} (${fn.slotNames[slot] || '?'}), r${src}`)
        break
      }
      case OPCODES.LOAD_GLOBAL: {
        const dst = bytecode[pc++]
        const idx = bytecode[pc++]
        lines.push(`${addr}: LOAD_GLOBAL r${dst}, "${constantPool[idx]}"`)
        break
      }
      case OPCODES.STORE_GLOBAL: {
        const idx = bytecode[pc++]
        const src = bytecode[pc++]
        lines.push(`${addr}: STORE_GLOBAL "${constantPool[idx]}", r${src}`)
        break
      }
      case OPCODES.LOAD_THIS: {
        const dst = bytecode[pc++]
        lines.push(`${addr}: LOAD_THIS r${dst}`)
        break
      }
      case OPCODES.LOAD_ARGUMENTS: {
        const dst = bytecode[pc++]
        lines.push(`${addr}: LOAD_ARGUMENTS r${dst}`)
        break
      }
      case OPCODES.GET_PROP: {
        const dst = bytecode[pc++]
        const obj = bytecode[pc++]
        const prop = bytecode[pc++]
        lines.push(`${addr}: GET_PROP r${dst}, r${obj}[r${prop}]`)
        break
      }
      case OPCODES.SET_PROP: {
        const dst = bytecode[pc++]
        const obj = bytecode[pc++]
        const prop = bytecode[pc++]
        const val = bytecode[pc++]
        lines.push(`${addr}: SET_PROP r${dst}, r${obj}[r${prop}] = r${val}`)
        break
      }
      case OPCODES.DELETE_PROP: {
        const dst = bytecode[pc++]
        const obj = bytecode[pc++]
        const prop = bytecode[pc++]
        lines.push(`${addr}: DELETE_PROP r${dst}, delete r${obj}[r${prop}]`)
        break
      }
      case OPCODES.BINARY: {
        const dst = bytecode[pc++]
        const left = bytecode[pc++]
        const right = bytecode[pc++]
        const opCode = bytecode[pc++]
        lines.push(`${addr}: BINARY r${dst}, r${left} ${BINARY_NAMES[opCode] || '?'} r${right}`)
        break
      }
      case OPCODES.UNARY: {
        const dst = bytecode[pc++]
        const val = bytecode[pc++]
        const opCode = bytecode[pc++]
        lines.push(`${addr}: UNARY r${dst}, ${UNARY_NAMES[opCode] || '?'} r${val}`)
        break
      }
      case OPCODES.JUMP: {
        const target = bytecode[pc++]
        lines.push(`${addr}: JUMP → ${target}`)
        break
      }
      case OPCODES.JUMP_IF_FALSE: {
        const cond = bytecode[pc++]
        const target = bytecode[pc++]
        lines.push(`${addr}: JUMP_IF_FALSE r${cond}, → ${target}`)
        break
      }
      case OPCODES.JUMP_IF_NOT_NULLISH: {
        const cond = bytecode[pc++]
        const target = bytecode[pc++]
        lines.push(`${addr}: JUMP_IF_NOT_NULLISH r${cond}, → ${target}`)
        break
      }
      case OPCODES.CALL: {
        const dst = bytecode[pc++]
        const callee = bytecode[pc++]
        const thisReg = bytecode[pc++]
        const argc = bytecode[pc++]
        const args = []
        for (let i = 0; i < argc; i++) args.push('r' + bytecode[pc++])
        const thisStr = thisReg >= 0 ? `this=r${thisReg}` : 'this=global'
        lines.push(`${addr}: CALL r${dst}, r${callee}(${args.join(', ')}) [${thisStr}]`)
        break
      }
      case OPCODES.NEW: {
        const dst = bytecode[pc++]
        const callee = bytecode[pc++]
        const argc = bytecode[pc++]
        const args = []
        for (let i = 0; i < argc; i++) args.push('r' + bytecode[pc++])
        lines.push(`${addr}: NEW r${dst}, new r${callee}(${args.join(', ')})`)
        break
      }
      case OPCODES.MAKE_FUNCTION: {
        const dst = bytecode[pc++]
        const funcId = bytecode[pc++]
        lines.push(`${addr}: MAKE_FUNCTION r${dst}, funcId=${funcId}`)
        break
      }
      case OPCODES.RETURN: {
        const src = bytecode[pc++]
        lines.push(`${addr}: RETURN r${src}`)
        break
      }
      case OPCODES.THROW: {
        const src = bytecode[pc++]
        lines.push(`${addr}: THROW r${src}`)
        break
      }
      case OPCODES.TRY: {
        const tryStart = bytecode[pc++]
        const catchStart = bytecode[pc++]
        const finallyStart = bytecode[pc++]
        const end = bytecode[pc++]
        const catchDepth = bytecode[pc++]
        const catchSlot = bytecode[pc++]
        lines.push(`${addr}: TRY try=${tryStart} catch=${catchStart} finally=${finallyStart} end=${end} catchSlot=${catchSlot}`)
        break
      }
      case OPCODES.AWAIT: {
        const dst = bytecode[pc++]
        const src = bytecode[pc++]
        lines.push(`${addr}: AWAIT r${dst}, r${src}`)
        break
      }
      case OPCODES.YIELD: {
        const dst = bytecode[pc++]
        const src = bytecode[pc++]
        const delegate = bytecode[pc++]
        lines.push(`${addr}: YIELD${delegate ? '*' : ''} r${dst}, r${src}`)
        break
      }
      case OPCODES.ARRAY_NEW: {
        const dst = bytecode[pc++]
        lines.push(`${addr}: ARRAY_NEW r${dst}`)
        break
      }
      case OPCODES.OBJECT_NEW: {
        const dst = bytecode[pc++]
        lines.push(`${addr}: OBJECT_NEW r${dst}`)
        break
      }
      case OPCODES.ARRAY_PUSH: {
        const arr = bytecode[pc++]
        const val = bytecode[pc++]
        lines.push(`${addr}: ARRAY_PUSH r${arr}, r${val}`)
        break
      }
      case OPCODES.OBJECT_SET: {
        const obj = bytecode[pc++]
        const key = bytecode[pc++]
        const val = bytecode[pc++]
        lines.push(`${addr}: OBJECT_SET r${obj}[r${key}] = r${val}`)
        break
      }
      case OPCODES.LOAD_NEW_TARGET: {
        const dst = bytecode[pc++]
        lines.push(`${addr}: LOAD_NEW_TARGET r${dst}`)
        break
      }
      default:
        lines.push(`${addr}: ${name} (unknown encoding)`)
        break
    }
  }
  return lines
}

console.log('=== 源码 ===')
console.log(source.trim())
console.log()

functions.forEach(fn => {
  console.log(`=== Function #${fn.id} ${fn.name ? `(${fn.name})` : '(entry)'} ===`)
  console.log(`    slots: [${fn.slotNames.map((n, i) => `${n}:${fn.slotKinds[i]}`).join(', ')}]`)
  console.log(`    registers: ${fn.registerCount}`)
  console.log()
  disassemble(fn).forEach(line => console.log(`    ${line}`))
  console.log()
})

// 清理
fs.rmSync(tmpDir, { recursive: true })
