/**
 * 阶段五 示例 1：闭包
 *
 * 演示闭包的编译和执行，展示环境帧链（env chain）如何工作。
 * 运行方式：node docs/examples/05-es5-features/01-closure.js
 */
const path = require('path')
const fs = require('fs')
const vm = require('vm')
const { transform } = require('../../../dist/index')

function run(label, source) {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vm-closure-'))
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
  return globalObject.__result
}

// ═══════════════════════════════════════════════
// 1. 基础闭包：计数器
// ═══════════════════════════════════════════════
run('1. 基础闭包：计数器', `
function makeCounter() {
  var count = 0;
  return function() {
    count = count + 1;
    return count;
  };
}
var counter = makeCounter();
counter();
counter();
__result = counter();
`)
// 预期: 3

// ═══════════════════════════════════════════════
// 2. 闭包共享变量
// ═══════════════════════════════════════════════
run('2. 多个闭包共享同一个外层变量', `
function make() {
  var shared = 0;
  return {
    inc: function() { shared++; return shared; },
    dec: function() { shared--; return shared; },
    get: function() { return shared; }
  };
}
var o = make();
o.inc();
o.inc();
o.inc();
o.dec();
__result = o.get();
`)
// 预期: 2

// ═══════════════════════════════════════════════
// 3. 闭包链（三层嵌套）
// ═══════════════════════════════════════════════
run('3. 三层嵌套闭包', `
function outer() {
  var a = 10;
  return function middle() {
    var b = 20;
    return function inner() {
      return a + b;
    };
  };
}
__result = outer()()();
`)
// 预期: 30

// ═══════════════════════════════════════════════
// 4. IIFE (立即执行函数) 中的闭包
// ═══════════════════════════════════════════════
run('4. IIFE 闭包模式', `
var getSecret = (function() {
  var secret = 42;
  return function() { return secret; };
})();
__result = getSecret();
`)
// 预期: 42
