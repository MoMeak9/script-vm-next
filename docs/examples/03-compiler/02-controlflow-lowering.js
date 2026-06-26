/**
 * 阶段三 示例 2：控制流编译演示
 *
 * 展示 if / while / for / switch / try-catch 如何被编译为 jump 指令。
 * 重点观察 label 和 jump_if_false 的配合。
 * 运行方式：node docs/examples/03-compiler/02-controlflow-lowering.js
 */
const path = require('path')
const fs = require('fs')
const compile = require('../../../dist/compiler/pipeline').default

function compileAndShow(label, source) {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vm-cf-'))
  const inputPath = path.join(tmpDir, 'input.js')
  fs.writeFileSync(inputPath, source)
  const { artifact } = compile(inputPath, null, { format: 'iife', debug: true })

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${label}`)
  console.log(`${'═'.repeat(60)}`)
  console.log()
  console.log('  源码:')
  source.trim().split('\n').forEach(line => console.log(`    ${line}`))
  console.log()
  console.log('  IR 指令流 (关注 label / jump / jump_if_false):')
  if (artifact.debugInfo) {
    artifact.debugInfo.instructions.forEach(line => {
      const parsed = JSON.parse(line.split(':').slice(1).join(':'))
      const op = parsed.op.toUpperCase()
      // 高亮控制流指令
      const isControlFlow = ['LABEL', 'JUMP', 'JUMP_IF_FALSE', 'JUMP_IF_NOT_NULLISH', 'TRY'].includes(op)
      const prefix = isControlFlow ? '>>>' : '   '
      const parts = []
      if ('target' in parsed) parts.push(`→ ${parsed.target}`)
      if ('condition' in parsed) parts.push(`cond=r${parsed.condition}`)
      if (parsed.op === 'label') parts.push(parsed.name)
      if ('dst' in parsed) parts.push(`r${parsed.dst}`)
      if ('left' in parsed) parts.push(`r${parsed.left}`)
      if ('right' in parsed) parts.push(`r${parsed.right}`)
      if ('operator' in parsed) parts.push(`"${parsed.operator}"`)
      if ('value' in parsed) parts.push(JSON.stringify(parsed.value))
      if ('src' in parsed) parts.push(`r${parsed.src}`)
      if ('depth' in parsed) parts.push(`depth=${parsed.depth}`)
      if ('slot' in parsed) parts.push(`slot=${parsed.slot}`)
      if ('name' in parsed && parsed.op !== 'label') parts.push(`"${parsed.name}"`)
      console.log(`    ${prefix} ${op.padEnd(22)} ${parts.join(', ')}`)
    })
  }
  console.log()
  fs.rmSync(tmpDir, { recursive: true })
}

// ═══════════════════════════════════════════════
// 各种控制流结构的编译结果
// ═══════════════════════════════════════════════

compileAndShow('1. if-else 语句', `
var x = 10;
if (x > 5) {
  __result = "big";
} else {
  __result = "small";
}
`)

compileAndShow('2. while 循环', `
var i = 0;
var sum = 0;
while (i < 5) {
  sum = sum + i;
  i++;
}
`)

compileAndShow('3. for 循环 (var)', `
var sum = 0;
for (var i = 0; i < 3; i++) {
  sum += i;
}
`)

compileAndShow('4. for 循环 (let) — 注意 REPLACE_SCOPE', `
var fns = [];
for (let i = 0; i < 3; i++) {
  fns.push(function() { return i; });
}
`)

compileAndShow('5. break / continue', `
var result = 0;
for (var i = 0; i < 10; i++) {
  if (i === 5) break;
  if (i % 2 === 0) continue;
  result += i;
}
`)

compileAndShow('6. try-catch-finally', `
var log = [];
try {
  log.push("try");
  throw "oops";
} catch (e) {
  log.push("catch:" + e);
} finally {
  log.push("finally");
}
`)
