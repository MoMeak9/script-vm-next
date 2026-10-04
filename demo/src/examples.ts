export interface Example {
  id: string;
  label: string;
  description: string;
  source: string;
}

export const examples: Example[] = [
  {
    id: 'closures',
    label: '01 · 闭包与词法作用域',
    description: '从一个小小的计数器开始：编译后的函数依然记得自己的作用域。',
    source: `// 每个计数器，都有自己的小宇宙。
function createCounter(label, initial = 0) {
  let value = initial;

  return {
    next: () => ++value,
    describe: () => \`\${label}: \${value}\`,
  };
}

const counter = createCounter('hello, vm', 40);
console.log('第一次计数 →', counter.next());
console.log('第二次计数 →', counter.next());
console.log(counter.describe());

// 循环里的 let 绑定，每次迭代独立捕获。
const callbacks = [];
for (let i = 0; i < 3; i++) {
  callbacks.push(() => i);
}
console.log('闭包捕获 →', callbacks.map(fn => fn()));
`,
  },
  {
    id: 'classes',
    label: '02 · 类与私有字段',
    description: '构造实例、更新私有状态、调用访问器：观察 VM 如何保留面向对象的行为。',
    source: `class Wallet {
  #balance = 0;

  constructor(owner) {
    this.owner = owner;
  }

  deposit(amount) {
    this.#balance += amount;
    return this;
  }

  get balance() {
    return this.#balance;
  }

  describe() {
    return \`\${this.owner} 的余额：¥\${this.#balance}\`;
  }
}

const wallet = new Wallet('小明');
wallet.deposit(100).deposit(42);
console.log(wallet.describe());
console.log('访问器读取 →', wallet.balance);
console.log('实例检查 →', wallet instanceof Wallet);
`,
  },
  {
    id: 'async',
    label: '03 · async / await',
    description: '使用本地 Promise 演示异步计算；演示环境中的网络请求已禁用。',
    source: `async function computeScore(name, scores) {
  const values = await Promise.resolve(scores);
  const total = values.reduce((sum, score) => sum + score, 0);
  return { name, total, average: total / values.length };
}

async function main() {
  console.log('开始异步计算…');
  const result = await computeScore('JavaScript', [88, 94, 100]);
  console.log('项目 →', result.name);
  console.log('总分 →', result.total);
  console.log('平均分 →', result.average);
  console.log('完成 ✓');
}

main().catch(error => console.error(error.message));
`,
  },
  {
    id: 'iteration',
    label: '04 · 迭代器与 BigInt',
    description: '用生成器生成斐波那契数列，通过 BigInt 保持整数精度。',
    source: `function* fibonacci(count) {
  let current = 0n;
  let next = 1n;

  for (let i = 0; i < count; i++) {
    yield current;
    [current, next] = [next, current + next];
  }
}

const sequence = [...fibonacci(12)];
console.log('斐波那契数列 →');
console.log(sequence.map(value => value.toString()).join(', '));

let large = 9007199254740991n;
const previous = large++;
console.log('BigInt 自增 →', previous, '→', large);
console.log('精确计算 →', large + 1n);
`,
  },
  {
    id: 'es6-compatibility',
    label: '05 · ES6 兼容',
    description: '直接使用 ES6：迭代解构、参数作用域、静态继承与标签模板语义由编译器和运行时处理。',
    source: `// 直接编译原始 JavaScript，无需额外的 Babel 配置。
const [first, ...rest] = new Set([1, 2, 3]);
console.log('Set 解构 →', first, rest.join(', '));

// 默认参数中的闭包捕获参数作用域，不受函数体 var 赋值影响。
function parameterScopes(value = 1, read = () => value) {
  var value = 2;
  return [read(), value].join(', ');
}
console.log('参数作用域 →', parameterScopes());

class Parent {
  static answer() {
    return 42;
  }
}
class Child extends Parent {}
console.log('静态继承 →', Child.answer());

// 同一标签模板位置复用模板对象，其 cooked/raw 数组均被冻结。
function tag(strings) {
  return strings;
}
function readTemplate() {
  return tag\`value=\${42}\`;
}
const template = readTemplate();
console.log('模板对象复用 →', template === readTemplate());
console.log('模板对象冻结 →', Object.isFrozen(template), Object.isFrozen(template.raw));
`,
  },
];
