/**
 * 阶段一 示例 1：Hello ScriptVM
 *
 * 最简单的端到端演示——将一段 JS 代码编译为 ScriptVM 字节码并执行。
 * 运行方式：node docs/examples/01-architecture/01-hello-vm.js
 */
const path = require('path')
const fs = require('fs')
const vm = require('vm')
const { transform } = require('../../../dist/index')

// ═══════════════════════════════════════════════
// 1. 原始源码
// ═══════════════════════════════════════════════
const source = `
var x = 40 + 2;
__result = x;
`

// ═══════════════════════════════════════════════
// 2. 写入临时文件并编译
// ═══════════════════════════════════════════════
const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vm-demo-'))
const inputPath = path.join(tmpDir, 'input.js')
fs.writeFileSync(inputPath, source)

const compiled = transform(inputPath, { format: 'iife' })

console.log('=== 原始代码 ===')
console.log(source.trim())
console.log()

console.log('=== 编译后代码（前 500 字符）===')
console.log(compiled.slice(0, 500) + '\n...')
console.log()

console.log('=== 编译后代码总长度 ===')
console.log(`${compiled.length} 字符`)
console.log()

// ═══════════════════════════════════════════════
// 3. 在沙箱中执行编译后的代码
// ═══════════════════════════════════════════════
const globalObject = {
  console, Reflect, Object, Array, String, Number,
  Boolean, Math, JSON, Date, RegExp, Error, TypeError,
}
const context = vm.createContext({
  globalThis: globalObject,
  ...globalObject,
})
vm.runInContext(compiled, context)

console.log('=== 执行结果 ===')
console.log(`__result = ${globalObject.__result}`)
console.log()

// 验证
if (globalObject.__result === 42) {
  console.log('✓ 编译并执行成功！结果与原生 JS 一致。')
} else {
  console.error('✗ 结果不正确，预期 42，实际', globalObject.__result)
}

// 清理
fs.rmSync(tmpDir, { recursive: true })
