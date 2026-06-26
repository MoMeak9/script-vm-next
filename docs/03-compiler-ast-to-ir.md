# 为什么 AST 不能直接执行，而必须先降成 IR？

## 本章目标

这一章进入编译器真正开始“干活”的地方。读完以后，你应该能回答：

1. AST 与 IR 的职责差异到底是什么？
2. lowering 阶段为什么要分配寄存器、映射 slot、生成线性步骤？
3. 为什么 `var` 需要先预声明，再正式编译？
4. 为什么控制流最终都要变成 `label + jump`？

---

## 先看地图：AST 与 IR 之间到底差了什么

```mermaid
flowchart LR
    A["AST<br/>树状语法结构"] --> B["Lowering"]
    B --> C["IR<br/>线性执行步骤"]
```

lowering 的任务不是“再解释一遍源码”，而是把树形结构压平为执行顺序。它做的是从“描述代码长相”切换到“描述机器动作”。

---

## 用同一个例子并排看 AST 与 IR

### 输入源码

```js
var x = 40 + 2;
__result = x;
```

### AST：更接近语法树

```json
{
  "type": "Program",
  "body": [
    {
      "type": "VariableDeclaration",
      "declarations": [
        {
          "id": { "type": "Identifier", "name": "x" },
          "init": {
            "type": "BinaryExpression",
            "operator": "+",
            "left": { "type": "NumericLiteral", "value": 40 },
            "right": { "type": "NumericLiteral", "value": 2 }
          }
        }
      ]
    }
  ]
}
```

### IR：更接近执行清单

```json
[
  { "op": "load_const", "dst": 0, "value": 40 },
  { "op": "load_const", "dst": 1, "value": 2 },
  { "op": "binary", "dst": 2, "left": 0, "right": 1, "operator": "+" },
  { "op": "init_slot", "slot": 0, "src": 2 },
  { "op": "load_slot", "dst": 3, "slot": 0 },
  { "op": "store_global", "name": "__result", "src": 3 }
]
```

对比后可以得到一个非常清晰的结论：

> AST 负责表达“父子关系”，IR 负责表达“先后关系”。

VM 更适合消费后者。

---

## 为什么 lowering 必须维护一个 Builder

教程第三步对应的示例文件是：

- `docs/examples/tutorial-jsvm/03-ast-to-ir.js`

这一版第一次引入 `Builder`，因为 lowering 不是无状态递归，而是持续积累编译期信息。

### `Builder` 负责哪些状态

| 状态 | 作用 |
|------|------|
| `slotMap` | 记录变量名到 slot 编号的映射 |
| `slotNames` | 记录 slot 编号对应的名字 |
| `instructions` | 收集生成出来的 IR |
| `regCount` | 分配新的寄存器编号 |

对应代码非常短，但职责非常完整：

```js
class Builder {
  constructor() {
    this.slotMap = new Map()
    this.slotNames = []
    this.instructions = []
    this.regCount = 0
  }

  predeclareVar(name) { ... }
  allocReg() { ... }
  emit(instruction) { ... }
  resolve(name) { ... }
}
```

这意味着 lowering 不是“看一个节点吐一条指令”那么简单，而是在持续维护一个编译现场。

---

## 表达式为什么天然适合“递归编译到寄存器”

表达式 lowering 的核心模式很稳定：

1. 先递归编译子表达式。
2. 子表达式各自产生寄存器结果。
3. 当前节点再把这些结果组装成一条新指令。

教程示例里的 `compileExpression()` 正是这个结构：

```js
function compileExpression(node, builder) {
  switch (node.type) {
    case 'NumericLiteral': {
      const dst = builder.allocReg()
      builder.emit({ op: 'load_const', dst, value: node.value })
      return dst
    }
    case 'Identifier': {
      const dst = builder.allocReg()
      const binding = builder.resolve(node.name)
      // ... load_slot 或 load_global ...
      return dst
    }
    case 'BinaryExpression': {
      const left = compileExpression(node.left, builder)
      const right = compileExpression(node.right, builder)
      const dst = builder.allocReg()
      builder.emit({ op: 'binary', dst, left, right, operator: node.operator })
      return dst
    }
  }
}
```

这里最重要的不是语法分支本身，而是一个固定套路：

> 子节点先落寄存器，父节点再引用这些寄存器。

这正是寄存器机与 AST lowering 天然契合的地方。

---

## 为什么变量名会在这一层被改写成 slot

源码里我们写的是变量名，运行时真正需要的却是稳定的位置编号。`resolve(name)` 做的就是这件事：

```js
resolve(name) {
  if (this.slotMap.has(name)) {
    return { kind: 'slot', slot: this.slotMap.get(name) }
  }

  return { kind: 'global', name }
}
```

它把名字解析为两类目标：

| 解析结果 | 含义 |
|----------|------|
| `{ kind: 'slot', slot }` | 当前编译单元内部可控的局部绑定 |
| `{ kind: 'global', name }` | 不在本地作用域中的宿主访问 |

这一步的价值在于：从这里开始，编译器已经在主动消解“变量名字符串”。

---

## 为什么 `var` 需要两遍扫描

教程中的 `compileSourceToIR()` 有一个非常关键的设计：先预声明，再正式编译。

```js
for (const statement of ast.program.body) {
  if (statement.type === 'VariableDeclaration' && statement.kind === 'var') {
    for (const declaration of statement.declarations) {
      builder.predeclareVar(declaration.id.name)
    }
  }
}

for (const statement of ast.program.body) {
  compileStatement(statement, builder)
}
```

这样设计的原因不是“实现上方便”，而是它与 JavaScript 的绑定语义一致：

- `var` 绑定在进入作用域时就已经存在。
- 真正的初始化发生在执行到赋值语句时。

因此，“先有抽屉，再往抽屉里放值”才是更准确的编译模型。

---

## 语句 lowering 的本质：把结构化语法改成线性步骤

在教程第三步里，我们先处理两类最小语句：

| 语句类型 | 降级后的核心动作 |
|----------|------------------|
| `VariableDeclaration` | 先编译右值，再 `init_slot` |
| `AssignmentExpression` | 先编译右值，再 `store_slot` 或 `store_global` |

对应代码的结构非常直接：

```js
function compileStatement(node, builder) {
  switch (node.type) {
    case 'VariableDeclaration':
      // ... init_slot ...
      return
    case 'ExpressionStatement':
      // ... store_slot / store_global ...
      return
  }
}
```

这一步真正重要的结论是：

> 无论源码里的语句长什么样，进入 IR 后都会变成“先算右侧，再写目标位置”的执行步骤。

---

## 为什么控制流最终要改写成 `label + jump`

第三章教程脚手架还没有完整展开 `if`，但第四章就会用到这个模式。这里先把核心思想讲清楚。

结构化语法：

```js
if (x > 20) {
  __result = x;
} else {
  __result = 0;
}
```

线性 IR：

```text
binary         r2, r0, r1, >
jump_if_false  r2, if_else_0
store_global   "__result", r3
jump           if_end_0
label          if_else_0
store_global   "__result", r4
label          if_end_0
```

这次转换说明了一件事：控制流在底层不会继续保留“语法块”的形状，而是会还原为跳转关系。

---

## 第三章的编译产物，第一次让源码进入机器世界

执行 `docs/examples/tutorial-jsvm/03-ast-to-ir.js` 后，你会得到一份最小 IR。它标志着三个变化同时发生：

1. 输入不再是手写 `program` 对象，而是真实源码字符串。
2. 变量绑定已经从名字变成 slot。
3. 执行顺序已经从树结构变成线性列表。

从教程节奏看，这一章是整个系列的分界线：前面两章在搭机器模型，这一章开始，编译器真正接管了“翻译”工作。

---

## 本章小结

这一章需要带走的核心结论有四个：

- AST 擅长表达结构，IR 擅长表达顺序。
- Builder 是 lowering 阶段的状态容器，不是可有可无的辅助类。
- 表达式 lowering 的固定模式是“子表达式先落寄存器，父表达式再引用寄存器”。
- `var` 的预声明让编译期模型开始对齐 JavaScript 的绑定语义。

下一章开始，我们会把这份“人还能读懂的 IR”压成数字字节码，再交给运行时真正执行。
