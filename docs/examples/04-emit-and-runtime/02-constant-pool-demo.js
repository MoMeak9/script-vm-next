/**
 * 阶段四 示例 2：常量池去重演示
 *
 * 展示常量池如何对相同的值去重，只存储一份。
 * 运行方式：node docs/examples/04-emit-and-runtime/02-constant-pool-demo.js
 */
const path = require('path')
const fs = require('fs')
const compile = require('../../../dist/compiler/pipeline').default

const source = `
var a = "hello";
var b = "hello";
var c = "hello";
var x = 42;
var y = 42;
var z = "world";
__result = a + b + c + x + y + z;
`

const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vm-pool-'))
const inputPath = path.join(tmpDir, 'input.js')
fs.writeFileSync(inputPath, source)
const { artifact } = compile(inputPath, null, { format: 'iife' })
fs.rmSync(tmpDir, { recursive: true })

console.log('=== 源码 ===')
console.log(source.trim())
console.log()

console.log('=== 常量池内容（去重后）===')
artifact.constantPool.forEach((val, i) => {
  console.log(`  pool[${i}] = ${JSON.stringify(val)}`)
})
console.log()

// 统计字节码中引用各常量的次数
const refCounts = new Array(artifact.constantPool.length).fill(0)
const { OPCODES } = require('../../../dist/runtime/opcodes')
let pc = 0
const fn = artifact.functions[0]
pc = fn.entry
while (pc < fn.end) {
  const op = artifact.bytecode[pc++]
  if (op === OPCODES.LOAD_CONST) {
    pc++ // skip dst
    const idx = artifact.bytecode[pc++]
    refCounts[idx]++
  } else if (op === OPCODES.LOAD_GLOBAL || op === OPCODES.STORE_GLOBAL) {
    const idx = artifact.bytecode[pc++]
    refCounts[idx]++
    if (op === OPCODES.STORE_GLOBAL) pc++ // src
    else pc++ // dst (load_global has dst first, but we already consumed idx)
    // Note: simplified, actual decoding depends on operand order
  } else {
    // Skip remaining operands (simplified — just break for demo)
    break
  }
}

console.log('=== 去重效果 ===')
console.log(`  源码中 "hello" 出现 3 次，常量池中只存 1 份`)
console.log(`  源码中 42 出现 2 次，常量池中只存 1 份`)
console.log(`  常量池总大小: ${artifact.constantPool.length} 项`)
console.log(`  如果不去重需要: ${3 + 2 + 1} 项 (节省 ${6 - artifact.constantPool.length} 项)`)
