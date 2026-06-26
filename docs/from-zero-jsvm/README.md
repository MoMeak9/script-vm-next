# From Zero JSVM 系列阅读说明

这组文章的首要目标不是“解释已有源码”，而是让读者即使完全没有 `script-vm-next` 源码，也能仅凭文章从 0 到 1 实现出一台最小 JavaScript VM。

## 写作原则

1. **先实现，再映射源码**：每篇文章先给教学版模型、伪代码和可运行 JavaScript，再说明正式源码中如何工程化处理。
2. **每篇都能独立动手**：读者可以只复制本篇的教学代码完成当前阶段能力。
3. **源码不是前置条件**：源码路径只用于帮助已有项目读者定位真实实现，不作为理解文章的必要条件。
4. **逐步扩大能力边界**：从 `1 + 2` 开始，依次引入 bytecode、register、slot/env、AST lowering、emit、控制流、函数、闭包、对象、打包和最终复盘。
5. **明确教学版和正式版差异**：避免把简化代码误认为生产实现。

## 推荐阅读顺序

| 篇章 | 文件 | 可独立实现的能力 |
|---|---|---|
| 01 | `01-build-first-jsvm.md` | 最小栈式 VM |
| 02 | `02-bytecode-opcode-constant-pool.md` | opcode、bytecode、constant pool |
| 03 | `03-stack-to-register-vm.md` | 寄存器式 VM |
| 04 | `04-variables-environment-tdz.md` | slot、environment、TDZ |
| 05 | `05-ast-to-ir-compiler.md` | AST 到 IR lowering |
| 06 | `06-ir-to-bytecode-emit.md` | IR 到 bytecode emit |
| 07 | `07-control-flow-jump.md` | if、while、jump |
| 08 | `08-functions-call-frame-return.md` | 函数调用与 return |
| 09 | `09-closures-scope-chain.md` | 闭包与作用域链 |
| 10 | `10-objects-arrays-properties.md` | 对象、数组与属性访问 |
| 11 | `11-pack-modules-cli-debug.md` | 打包为可运行产物 |
| 12 | `12-complete-mini-jsvm-review.md` | 完整最小 JSVM 复盘 |

## 对源码读者的说明

如果你正在阅读 `script-vm-next` 源码，可以把每篇末尾的“与原始源码的差异”作为导航；如果你没有源码，也可以忽略这些映射，直接按教学版代码完成自己的实现。
