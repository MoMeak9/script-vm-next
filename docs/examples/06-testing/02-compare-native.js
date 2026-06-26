/**
 * 阶段六 示例 2：ScriptVM vs 原生引擎对比测试
 *
 * 将同一段代码分别在原生 JS 引擎和 ScriptVM 中执行，
 * 对比两者的结果是否一致。
 *
 * 运行方式：node docs/examples/06-testing/02-compare-native.js
 * (需要先 pnpm build)
 */
const path = require('path')
const fs = require('fs')
const vm = require('vm')
const { transform } = require('../../../dist/index')

function compareExecution(label, source) {
  // ─── 1. 原生引擎执行 ───
  const nativeGlobal = {
    console, Object, Array, String, Number, Boolean, Math, JSON,
    Reflect, Date, RegExp, Error, TypeError, Symbol, Promise,
    WeakMap, WeakSet, Map, Set,
  }
  const nativeContext = vm.createContext({
    globalThis: nativeGlobal,
    ...nativeGlobal,
  })
  vm.runInContext(source, nativeContext)
  const nativeResult = nativeContext.__result

  // ─── 2. ScriptVM 编译并执行 ───
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vm-cmp-'))
  const inputPath = path.join(tmpDir, 'input.js')
  fs.writeFileSync(inputPath, source)
  const compiled = transform(inputPath, { format: 'iife' })

  const vmGlobal = {
    console, Reflect, Object, Array, String, Number,
    Boolean, Math, JSON, Date, RegExp, Error, TypeError,
  }
  const vmContext = vm.createContext({ globalThis: vmGlobal, ...vmGlobal })
  vm.runInContext(compiled, vmContext)
  const vmResult = vmGlobal.__result

  fs.rmSync(tmpDir, { recursive: true })

  // ─── 3. 对比 ───
  const match = JSON.stringify(nativeResult) === JSON.stringify(vmResult)
  const icon = match ? '\u2713' : '\u2717'

  console.log(`${icon} ${label}`)
  console.log(`    Native:  ${JSON.stringify(nativeResult)}`)
  console.log(`    ScriptVM:   ${JSON.stringify(vmResult)}`)
  if (!match) {
    console.log(`    *** MISMATCH! ***`)
  }
  console.log()

  return match
}

// ═══════════════════════════════════════════════
// 对比测试用例
// ═══════════════════════════════════════════════
console.log('=== ScriptVM vs Native JS Engine ===\n')

const results = [
  compareExecution('基础算术', `__result = (1 + 2) * 3 - 4 / 2;`),

  compareExecution('字符串操作', `
    var s = "Hello";
    __result = s.charAt(0) + s.slice(1).toUpperCase();
  `),

  compareExecution('数组操作', `
    var arr = [3, 1, 4, 1, 5];
    arr.sort(function(a, b) { return a - b; });
    __result = arr;
  `),

  compareExecution('闭包', `
    function adder(x) {
      return function(y) { return x + y; };
    }
    __result = adder(10)(32);
  `),

  compareExecution('递归（斐波那契）', `
    function fib(n) {
      if (n <= 1) return n;
      return fib(n-1) + fib(n-2);
    }
    __result = fib(10);
  `),

  compareExecution('构造函数 + 原型', `
    function Animal(name) { this.name = name; }
    Animal.prototype.speak = function() { return this.name + " makes a sound"; };
    var a = new Animal("Cat");
    __result = a.speak();
  `),

  compareExecution('try-catch-finally', `
    var log = [];
    try {
      log.push(1);
      throw "err";
    } catch(e) {
      log.push(2);
    } finally {
      log.push(3);
    }
    __result = log;
  `),

  compareExecution('for-let 逐迭代捕获', `
    var fns = [];
    for (let i = 0; i < 5; i++) {
      fns.push(function() { return i; });
    }
    __result = fns.map(function(f) { return f(); });
  `),

  compareExecution('逻辑短路', `
    var x = null;
    var a = x && x.toString();
    var b = x || "default";
    __result = [a, b];
  `),

  compareExecution('var 提升', `
    var before = typeof x;
    var x = 42;
    __result = before;
  `),
]

const passed = results.filter(Boolean).length
const total = results.length
console.log(`\n=== 结果: ${passed}/${total} 通过 ===`)
