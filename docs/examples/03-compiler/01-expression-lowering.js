/**
 * 阶段三 示例 1：表达式编译演示
 *
 * 展示各种 JS 表达式如何被编译为 IR 指令，
 * 对比源码、IR 指令和最终字节码。
 * 运行方式：node docs/examples/03-compiler/01-expression-lowering.js
 */
const path = require('path')
const fs = require('fs')
const compile = require('../../../dist/compiler/pipeline').default

function compileAndShow(label, source) {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vm-expr-'))
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
  console.log('  常量池:', JSON.stringify(artifact.constantPool))
  console.log()
  console.log('  IR 指令:')
  if (artifact.debugInfo) {
    artifact.debugInfo.instructions.forEach(line => {
      const parsed = JSON.parse(line.split(':').slice(1).join(':'))
      console.log(`    ${parsed.op.toUpperCase().padEnd(18)} ${formatOperands(parsed)}`)
    })
  }
  console.log()

  fs.rmSync(tmpDir, { recursive: true })
}

function formatOperands(instr) {
  const parts = []
  if ('dst' in instr) parts.push(`dst=r${instr.dst}`)
  if ('src' in instr) parts.push(`src=r${instr.src}`)
  if ('left' in instr) parts.push(`left=r${instr.left}`)
  if ('right' in instr) parts.push(`right=r${instr.right}`)
  if ('value' in instr) parts.push(`value=${JSON.stringify(instr.value)}`)
  if ('operator' in instr) parts.push(`op="${instr.operator}"`)
  if ('name' in instr && instr.op !== 'label') parts.push(`name="${instr.name}"`)
  if ('depth' in instr) parts.push(`depth=${instr.depth}`)
  if ('slot' in instr) parts.push(`slot=${instr.slot}`)
  if ('object' in instr) parts.push(`obj=r${instr.object}`)
  if ('property' in instr) parts.push(`prop=r${instr.property}`)
  if ('callee' in instr) parts.push(`callee=r${instr.callee}`)
  if ('thisReg' in instr) parts.push(`this=${instr.thisReg >= 0 ? 'r' + instr.thisReg : 'global'}`)
  if ('args' in instr) parts.push(`args=[${instr.args.map(a => 'r' + a).join(',')}]`)
  if ('target' in instr) parts.push(`→ ${instr.target}`)
  if ('condition' in instr) parts.push(`cond=r${instr.condition}`)
  if ('functionId' in instr) parts.push(`funcId=${instr.functionId}`)
  if ('array' in instr) parts.push(`arr=r${instr.array}`)
  if ('key' in instr) parts.push(`key=r${instr.key}`)
  if (instr.op === 'label') parts.push(instr.name)
  return parts.join(', ')
}

// ═══════════════════════════════════════════════
// 各种表达式的编译结果
// ═══════════════════════════════════════════════

compileAndShow('1. 算术表达式', `
var x = 1 + 2 * 3;
`)

compileAndShow('2. 字符串拼接', `
var name = "World";
var msg = "Hello, " + name + "!";
`)

compileAndShow('3. 成员表达式 + 方法调用', `
var arr = [1, 2, 3];
var len = arr.length;
`)

compileAndShow('4. 三元表达式', `
var x = 10;
var label = x > 5 ? "big" : "small";
`)

compileAndShow('5. 逻辑短路 (&&)', `
var a = true;
var b = a && "yes";
`)

compileAndShow('6. 对象字面量', `
var obj = { name: "Alice", age: 30 };
`)

compileAndShow('7. 更新表达式 (i++, ++i)', `
var i = 0;
var a = i++;
var b = ++i;
`)
