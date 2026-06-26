/**
 * 阶段五 示例 3：变量提升与作用域
 *
 * 演示 var 提升、function 提升、TDZ 和块级作用域。
 * 运行方式：node docs/examples/05-es5-features/03-hoisting-and-scope.js
 */
const path = require('path')
const fs = require('fs')
const vm = require('vm')
const { transform } = require('../../../dist/index')

function run(label, source) {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vm-scope-'))
  const inputPath = path.join(tmpDir, 'input.js')
  fs.writeFileSync(inputPath, source)
  const code = transform(inputPath, { format: 'iife' })

  const globalObject = {
    console, Reflect, Object, Array, String, Number,
    Boolean, Math, JSON, Date, RegExp, Error, TypeError,
  }
  const context = vm.createContext({ globalThis: globalObject, ...globalObject })
  vm.runInContext(code, context)

  console.log(`--- ${label} ---`)
  console.log('  源码:')
  source.trim().split('\n').forEach(line => console.log(`    ${line}`))
  console.log(`  结果: __result = ${JSON.stringify(globalObject.__result)}`)
  console.log()

  fs.rmSync(tmpDir, { recursive: true })
}

// ═══════════════════════════════════════════════
// 1. var 提升：声明提升，赋值不提升
// ═══════════════════════════════════════════════
run('1. var 提升', `
var before = typeof x;
var x = 10;
var after = typeof x;
__result = [before, after];
`)
// 预期: ["undefined", "number"]

// ═══════════════════════════════════════════════
// 2. function 提升：整个函数体都提升
// ═══════════════════════════════════════════════
run('2. function 提升', `
__result = add(3, 4);
function add(a, b) { return a + b; }
`)
// 预期: 7

// ═══════════════════════════════════════════════
// 3. let/const TDZ
// ═══════════════════════════════════════════════
run('3. let TDZ (Temporal Dead Zone)', `
var caught = false;
try {
  var x = y;
  let y = 1;
} catch (e) {
  caught = e.name === "ReferenceError";
}
__result = caught;
`)
// 预期: true

// ═══════════════════════════════════════════════
// 4. const 不可重新赋值
// ═══════════════════════════════════════════════
run('4. const 不可赋值', `
var caught = false;
try {
  const x = 42;
  x = 100;
} catch (e) {
  caught = e.name === "TypeError";
}
__result = caught;
`)
// 预期: true

// ═══════════════════════════════════════════════
// 5. 块级作用域 shadowing
// ═══════════════════════════════════════════════
run('5. let 块级作用域遮蔽', `
var value = "outer";
{
  let value = "inner";
}
__result = value;
`)
// 预期: "outer"

// ═══════════════════════════════════════════════
// 6. for-let 逐迭代捕获
// ═══════════════════════════════════════════════
run('6. for-let 逐迭代捕获（REPLACE_SCOPE）', `
var fns = [];
for (let i = 0; i < 3; i++) {
  fns.push(function() { return i; });
}
__result = [fns[0](), fns[1](), fns[2]()];
`)
// 预期: [0, 1, 2]

// ═══════════════════════════════════════════════
// 7. catch 变量作用域隔离
// ═══════════════════════════════════════════════
run('7. catch 变量不泄漏到外层', `
var e = "outer";
try {
  throw "error";
} catch (e) {
  // 这里 e 是 catch 局部变量
}
__result = e;
`)
// 预期: "outer"

// ═══════════════════════════════════════════════
// 8. arguments 对象
// ═══════════════════════════════════════════════
run('8. arguments 对象', `
function sum() {
  var total = 0;
  for (var i = 0; i < arguments.length; i++) {
    total += arguments[i];
  }
  return total;
}
__result = sum(1, 2, 3, 4, 5);
`)
// 预期: 15
