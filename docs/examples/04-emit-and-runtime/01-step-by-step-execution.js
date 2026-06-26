/**
 * 阶段四 示例 1：逐步执行追踪
 *
 * 模拟 VM 的 dispatch loop，逐条执行字节码并打印寄存器/环境帧状态。
 * 运行方式：node docs/examples/04-emit-and-runtime/01-step-by-step-execution.js
 */
const path = require('path')
const fs = require('fs')
const compile = require('../../../dist/compiler/pipeline').default
const { OPCODES, BINARY_OPS, UNARY_OPS } = require('../../../dist/runtime/opcodes')

const OP_NAMES = Object.fromEntries(Object.entries(OPCODES).map(([k, v]) => [v, k]))
const BINARY_NAMES = Object.fromEntries(Object.entries(BINARY_OPS).map(([k, v]) => [v, k]))

// ═══════════════════════════════════════════════
// 编译一段简单代码
// ═══════════════════════════════════════════════
const source = `
var x = 10;
var y = 20;
var sum = x + y;
__result = sum;
`

const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vm-trace-'))
const inputPath = path.join(tmpDir, 'input.js')
fs.writeFileSync(inputPath, source)
const { artifact } = compile(inputPath, null, { format: 'iife' })
fs.rmSync(tmpDir, { recursive: true })

const { bytecode, constantPool, functions } = artifact
const fn = functions[0]

// ═══════════════════════════════════════════════
// 手动执行 + 追踪
// ═══════════════════════════════════════════════
console.log('=== 源码 ===')
console.log(source.trim())
console.log()
console.log(`=== 函数 #${fn.id} — ${fn.registerCount} 个寄存器, ${fn.slotCount} 个变量槽位 ===`)
console.log(`    变量: [${fn.slotNames.map((n, i) => `${n}(${fn.slotKinds[i]})`).join(', ')}]`)
console.log()

// 初始化
const regs = new Array(fn.registerCount).fill(undefined)
const env = {
  values: new Array(fn.slotCount).fill(undefined),
  states: fn.slotKinds.map(k => (k === 'var' || k === 'function') ? 1 : 0),
}
const globalObject = {}

let pc = fn.entry
let step = 0

console.log('=== 逐步执行 ===')
console.log()

while (pc < fn.end && step < 50) {
  const addr = pc
  const op = bytecode[pc++]
  step++

  switch (op) {
    case OPCODES.LOAD_CONST: {
      const dst = bytecode[pc++]
      const idx = bytecode[pc++]
      const val = constantPool[idx]
      regs[dst] = val
      console.log(`  [${addr}] LOAD_CONST r${dst} = ${JSON.stringify(val)}`)
      break
    }
    case OPCODES.LOAD_UNDEFINED: {
      const dst = bytecode[pc++]
      regs[dst] = undefined
      console.log(`  [${addr}] LOAD_UNDEFINED r${dst}`)
      break
    }
    case OPCODES.STORE_SLOT: {
      const depth = bytecode[pc++]
      const slot = bytecode[pc++]
      const src = bytecode[pc++]
      env.values[slot] = regs[src]
      console.log(`  [${addr}] STORE_SLOT ${fn.slotNames[slot]}(slot ${slot}) = r${src} (${JSON.stringify(regs[src])})`)
      break
    }
    case OPCODES.LOAD_SLOT: {
      const dst = bytecode[pc++]
      const depth = bytecode[pc++]
      const slot = bytecode[pc++]
      regs[dst] = env.values[slot]
      console.log(`  [${addr}] LOAD_SLOT r${dst} = ${fn.slotNames[slot]}(slot ${slot}) → ${JSON.stringify(regs[dst])}`)
      break
    }
    case OPCODES.STORE_GLOBAL: {
      const idx = bytecode[pc++]
      const src = bytecode[pc++]
      const name = constantPool[idx]
      globalObject[name] = regs[src]
      console.log(`  [${addr}] STORE_GLOBAL ${name} = r${src} (${JSON.stringify(regs[src])})`)
      break
    }
    case OPCODES.BINARY: {
      const dst = bytecode[pc++]
      const left = regs[bytecode[pc++]]
      const right = regs[bytecode[pc++]]
      const opCode = bytecode[pc++]
      const opName = BINARY_NAMES[opCode]
      let result
      switch (opCode) {
        case BINARY_OPS['+']: result = left + right; break
        case BINARY_OPS['-']: result = left - right; break
        case BINARY_OPS['*']: result = left * right; break
        default: result = '?'
      }
      regs[dst] = result
      console.log(`  [${addr}] BINARY r${dst} = ${left} ${opName} ${right} → ${result}`)
      break
    }
    case OPCODES.RETURN: {
      const src = bytecode[pc++]
      console.log(`  [${addr}] RETURN r${src} (${JSON.stringify(regs[src])})`)
      console.log()
      console.log('=== 执行结束 ===')
      console.log()
      console.log('  寄存器最终状态:')
      regs.forEach((v, i) => console.log(`    r${i} = ${JSON.stringify(v)}`))
      console.log()
      console.log('  变量槽位最终状态:')
      fn.slotNames.forEach((n, i) => console.log(`    ${n} = ${JSON.stringify(env.values[i])}`))
      console.log()
      console.log('  全局变量:')
      Object.entries(globalObject).forEach(([k, v]) => console.log(`    ${k} = ${JSON.stringify(v)}`))
      pc = fn.end // 退出循环
      break
    }
    default: {
      console.log(`  [${addr}] ${OP_NAMES[op] || 'UNKNOWN'} (skipped in trace)`)
      // 跳过未处理的指令 — 实际运行请用完整 VM
      pc = fn.end
      break
    }
  }
}
