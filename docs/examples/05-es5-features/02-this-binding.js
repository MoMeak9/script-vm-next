/**
 * 阶段五 示例 2：this 绑定
 *
 * 演示 ScriptVM 中四种 this 绑定场景。
 * 运行方式：node docs/examples/05-es5-features/02-this-binding.js
 */
const path = require('path')
const fs = require('fs')
const vm = require('vm')
const { transform } = require('../../../dist/index')

function run(label, source) {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vm-this-'))
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
// 1. 方法调用：this = 对象
// ═══════════════════════════════════════════════
run('1. 方法调用 (this = obj)', `
var obj = {
  name: "Alice",
  greet: function() {
    return "Hello, " + this.name;
  }
};
__result = obj.greet();
`)
// 预期: "Hello, Alice"

// ═══════════════════════════════════════════════
// 2. 构造函数：this = 新对象
// ═══════════════════════════════════════════════
run('2. 构造函数 (this = new object)', `
function Person(name, age) {
  this.name = name;
  this.age = age;
}
var p = new Person("Bob", 25);
__result = p.name + " is " + p.age;
`)
// 预期: "Bob is 25"

// ═══════════════════════════════════════════════
// 3. 原型方法中的 this
// ═══════════════════════════════════════════════
run('3. 原型方法 (this = 实例)', `
function Dog(name) {
  this.name = name;
}
Dog.prototype.bark = function() {
  return this.name + " says woof!";
};
var d = new Dog("Rex");
__result = d.bark();
`)
// 预期: "Rex says woof!"

// ═══════════════════════════════════════════════
// 4. call/apply 显式绑定
// ═══════════════════════════════════════════════
run('4. call/apply 显式绑定', `
function greet(greeting) {
  return greeting + ", " + this.name;
}
var user = { name: "Charlie" };
__result = greet.call(user, "Hi");
`)
// 预期: "Hi, Charlie"

// ═══════════════════════════════════════════════
// 5. 丢失 this 的经典陷阱
// ═══════════════════════════════════════════════
run('5. var self = this 模式（保存 this）', `
var obj = {
  items: [1, 2, 3],
  sum: function() {
    var self = this;
    var total = 0;
    var callback = function(i) {
      total = total + self.items[i];
    };
    for (var i = 0; i < this.items.length; i++) {
      callback(i);
    }
    return total;
  }
};
__result = obj.sum();
`)
// 预期: 6
