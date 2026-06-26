/**
 * 阶段一 示例 2：检视编译产物（ProgramArtifact）
 *
 * 展示编译流水线的中间产物结构：bytecode、constantPool、functions。
 * 运行方式：node docs/examples/01-architecture/02-inspect-artifact.js
 */
const path = require('path')
const fs = require('fs')
const compile = require('../../../dist/compiler/pipeline').default

// ═══════════════════════════════════════════════
// 1. 编译源码
// ═══════════════════════════════════════════════
const source = `
var x = 10;
var y = x + 20;
__result = y;
`

const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vm-artifact-'))
const inputPath = path.join(tmpDir, 'input.js')
fs.writeFileSync(inputPath, source)

const { artifact } = compile(inputPath, null, { format: 'iife', debug: true })

// ═══════════════════════════════════════════════
// 2. 检视 ProgramArtifact
// ═══════════════════════════════════════════════

console.log('=== 常量池 (constantPool) ===')
artifact.constantPool.forEach((val, i) => {
  console.log(`  [${i}] ${JSON.stringify(val)}`)
})
console.log()

console.log('=== 函数元信息 ===')
artifact.functions.forEach(fn => {
  console.log(`  Function #${fn.id}:`)
  console.log(`    name: ${fn.name ?? '(anonymous)'}`)
  console.log(`    params: ${fn.params}`)
  console.log(`    registerCount: ${fn.registerCount}`)
  console.log(`    slotCount: ${fn.slotCount}`)
  console.log(`    slotNames: [${fn.slotNames.join(', ')}]`)
  console.log(`    slotKinds: [${fn.slotKinds.join(', ')}]`)
  console.log(`    bytecode range: [${fn.entry}, ${fn.end})`)
})
console.log()

console.log('=== 字节码（原始数字数组）===')
console.log(`  长度: ${artifact.bytecode.length}`)
console.log(`  [${artifact.bytecode.join(', ')}]`)
console.log()

if (artifact.debugInfo) {
  console.log('=== 调试信息（指令文本表示）===')
  artifact.debugInfo.instructions.forEach(line => {
    console.log(`  ${line}`)
  })
}

// 清理
fs.rmSync(tmpDir, { recursive: true })
