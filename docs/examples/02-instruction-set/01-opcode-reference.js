/**
 * 阶段二 示例 1：Opcode 参考手册
 *
 * 打印完整的 Opcode 表、二元运算子操作码、一元运算子操作码。
 * 运行方式：node docs/examples/02-instruction-set/01-opcode-reference.js
 */
const { OPCODES, BINARY_OPS, UNARY_OPS } = require('../../../dist/runtime/opcodes')

console.log('=== 主 Opcode 表（共 ' + Object.keys(OPCODES).length + ' 个）===')
console.log()

// 按编号排序输出
const sorted = Object.entries(OPCODES).sort((a, b) => a[1] - b[1])
sorted.forEach(([name, code]) => {
  console.log(`  ${String(code).padStart(2)}  ${name}`)
})
console.log()

console.log('=== 二元运算子操作码（共 ' + Object.keys(BINARY_OPS).length + ' 个）===')
console.log()
Object.entries(BINARY_OPS).forEach(([op, code]) => {
  console.log(`  ${String(code).padStart(2)}  ${op}`)
})
console.log()

console.log('=== 一元运算子操作码（共 ' + Object.keys(UNARY_OPS).length + ' 个）===')
console.log()
Object.entries(UNARY_OPS).forEach(([op, code]) => {
  console.log(`  ${String(code).padStart(2)}  ${op}`)
})
