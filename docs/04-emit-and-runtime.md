# 为什么只有把 IR 压成字节码并跑起来，系统才真正闭环？

## 本章目标

前面三章已经把“编译到 IR”走通了，这一章要完成真正的闭环。读完以后，你应该能回答：

1. emit 阶段究竟在做哪些压缩与整理？
2. 为什么跳转地址通常需要两遍处理？
3. `ProgramArtifact` 至少要带哪些元信息？
4. 为什么运行时最关键的状态就是 `pc`、`regs`、`env`？

---

## 先看地图：从 IR 到结果，还差最后两步

```mermaid
flowchart LR
    A["IR<br/>对人友好的执行步骤"] --> B["Emit<br/>压成数字字节码"]
    B --> C["Runtime<br/>读取 opcode 与操作数"]
    C --> D["Result<br/>得到最终行为"]
```

如果说 lowering 解决的是“把源码拆成动作”，那么 emit 和 runtime 解决的是“让这些动作真正可执行”。

---

## 为什么 IR 还不能直接交给运行时

IR 很适合编译器处理，但对运行时来说仍然太重了。它通常包含：

- 字符串形式的 `op`
- 标签名
- 字面量值
- 面向调试的对象结构

例如：

```json
{ "op": "jump_if_false", "condition": 3, "target": "if_else_0" }
```

运行时真正适合消费的是更稳定、更紧凑的数字协议：

```text
[10, 3, 17]
```

也就是：

- `10` 表示 `JUMP_IF_FALSE`
- `3` 表示条件寄存器
- `17` 表示目标字节码偏移

这正是 emit 阶段存在的原因。

---

## 用并排视图看“转换前后”

### IR 视图

```json
[
  { "op": "load_const", "dst": 0, "value": 40 },
  { "op": "load_const", "dst": 1, "value": 2 },
  { "op": "binary", "dst": 2, "left": 0, "right": 1, "operator": "+" },
  { "op": "jump_if_false", "condition": 2, "target": "if_else_0" }
]
```

### Bytecode 视图

```text
[
  1, 0, 0,
  1, 1, 1,
  8, 2, 0, 1, 1,
  10, 2, 16
]
```

从视觉上就能看出差异：

| 层次 | 优势 |
|------|------|
| IR | 易读、易调试、便于编译阶段改写 |
| Bytecode | 紧凑、稳定、便于运行时逐项读取 |

---

## emit 阶段具体在压缩什么

教程第四步对应的示例文件是：

- `docs/examples/tutorial-jsvm/04-emit-bytecode-and-run.js`

这一版的 emit 主要做三件事：

### 1. 把字面量统一收入常量池

```js
class ConstantPool {
  constructor() {
    this.values = []
    this.indexMap = new Map()
  }

  add(value) { ... }
}
```

这样做的直接收益是：字节码里不需要反复携带完整字面量，而只需要引用索引。

### 2. 把符号化 IR 编成数字序列

```js
case 'load_const':
  bytecode.push(OPCODES.LOAD_CONST, instruction.dst, pool.add(instruction.value))
  break
```

### 3. 处理标签和跳转回填

```js
case 'jump':
  bytecode.push(OPCODES.JUMP, -1)
  fixups.push({ index: bytecode.length - 1, target: instruction.target })
  break
```

标签回填之所以要分两步，是因为第一次扫描到跳转指令时，目标标签的位置可能还没有出现。

---

## 为什么 `label + jump` 通常要两遍处理

控制流 lowering 后会产生符号标签：

```text
jump_if_false r2, if_else_0
...
label if_else_0
```

emit 时第一遍只能先记账：

| 阶段 | 做什么 |
|------|--------|
| 第一遍 | 记录标签定义位置，给跳转目标先写占位值 |
| 第二遍 | 用真实字节码偏移回填占位值 |

这个模型很像汇编器处理标签引用。它的本质是：先收集地址，再解引用。

---

## 运行时真正消费的，不只是字节码

emit 的输出不是单独一条 `bytecode` 数组，而是一个最小程序包。教程版最小产物长这样：

```js
{
  slotCount: ir.slotNames.length,
  registerCount: ir.registerCount,
  constants: pool.values,
  bytecode,
}
```

这里每个字段都对应运行时的某种假设：

| 字段 | 运行时用途 |
|------|------------|
| `slotCount` | 初始化当前环境的 slot 容量 |
| `registerCount` | 初始化寄存器数组长度 |
| `constants` | 按索引读取常量值 |
| `bytecode` | 主循环逐项解释执行 |

也就是说，emit 不只是“压缩指令”，还在整理运行时真正需要的元信息。

---

## 运行时为什么可以概括成 `pc + regs + env`

教程第四步的 `run()` 会维护三块最关键的状态：

| 状态 | 含义 |
|------|------|
| `pc` | 当前读到字节码的哪里 |
| `regs` | 当前表达式计算中的临时值 |
| `env` | 当前作用域的变量存储 |

最小主循环如下：

```js
while (pc < code.length) {
  const op = code[pc++]

  switch (op) {
    case OPCODES.LOAD_CONST: { ... }
    case OPCODES.JUMP: { ... }
    case OPCODES.JUMP_IF_FALSE: { ... }
    case OPCODES.RETURN: { ... }
  }
}
```

这段代码的工程意义在于：运行时不再关心高层语法，只关心协议与状态迁移。

---

## 用一次 `if` 执行过程看清 `pc` 如何变化

考虑这段源码：

```js
var x = 40 + 2;
if (x > 20) {
  __result = x;
} else {
  __result = 0;
}
```

它会在 lowering 后生成 `jump_if_false + jump + label` 组合。运行时执行时，`pc` 的推进逻辑大致如下：

| 时刻 | 读到的指令 | `pc` 变化 |
|------|------------|-----------|
| 1 | `LOAD_CONST` | 顺序推进到下一条 |
| 2 | `BINARY` | 顺序推进到下一条 |
| 3 | `JUMP_IF_FALSE` | 条件为真则继续，条件为假则直接改写为 else 地址 |
| 4 | `JUMP` | 直接跳过 else，前往结束标签 |

所以 VM 中最隐蔽的 bug 往往不是计算错误，而是“多读了一个操作数”或“少推进了一步 `pc`”。

---

## 第四章真正完成了哪一次闭环

到本章为止，教程已经打通了这条最小路径：

```js
function compileAndRunSource(source, globalObject = {}) {
  const ir = compileSourceToIR(source)
  const program = emitBytecode(ir)
  run(program, globalObject)
  return globalObject.__result
}
```

这意味着系统第一次具备了下面四个能力：

1. 读入真实源码
2. 生成 IR
3. 发射字节码
4. 执行并产生可验证结果

从教学节奏看，这是整套教程的第一个里程碑。

---

## 本章小结

这一章的核心结论可以收成四句话：

- IR 解决“可编译”，Bytecode 解决“可执行”。
- emit 同时承担编码、常量池整理和跳转回填三项工作。
- 运行时最重要的状态就是 `pc`、`regs`、`env`。
- 当 `compileAndRunSource()` 跑通时，编译链才真正闭环。

下一章开始，我们会处理真正决定“像不像 JavaScript”的语义问题：闭包、`this`、`arguments`、提升与 TDZ。
