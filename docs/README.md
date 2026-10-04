# Documentation / 文档导航

[English README](../README.md) · [中文 README](../README.zh-CN.md) · [Live playground / 在线演示](https://momeak9.github.io/script-vm-next/)

Choose a document by topic and language below. The project README is available in English and Simplified Chinese. Operational guides are currently in English; architecture guides and tutorials are in Simplified Chinese. The language labels describe the linked document's actual language, not a promised translation.

请按主题和语言选择文档。项目 README 提供英文和简体中文；使用、兼容性与发布指南目前为英文；架构与系列教程目前为简体中文。下表标注的是链接目标的实际语言，不代表该文档已提供翻译。

## Using and maintaining the package / 使用与维护

| Document / 文档 | Language / 语言 | Contents / 内容 |
| --- | --- | --- |
| [Project README](../README.md) | English | Installation, APIs, CLI, validation / 安装、API、CLI、验证 |
| [项目 README](../README.zh-CN.md) | 简体中文 | 安装、API、CLI、验证 / Installation, APIs, CLI, validation |
| [JavaScript compatibility / JavaScript 兼容性](compatibility.md) | English | Verified cases and remaining semantic boundaries / 已验证场景与剩余语义边界 |
| [Test262 baseline / Test262 基线](test262.md) | English | Pinned upstream tests, runner, scope and known exclusions / 固定上游版本、执行器、范围与已知排除项 |
| [Browser playground / 浏览器演示页](playground.md) | English | Usage, execution isolation, Pages deployment / 使用、执行隔离、Pages 部署 |
| [Release guide / 发布指南](releasing.md) | English | Package validation, license and npm publishing setup / 安装包验收、许可证与 npm 发布配置 |

The playground is deployed through GitHub Actions to GitHub Pages. npm publication remains pending the license decision and publishing access. For supported language features, compatibility handling is part of the compiler and runtime; consumers do not need to configure Babel or rewrite their JavaScript. The compatibility matrix records the remaining limits.

演示页已通过 GitHub Actions 部署到 GitHub Pages。npm 发布仍需确定许可证并配置发布权限。已支持语言功能的兼容处理由编译器和运行时承担，使用方无需配置 Babel 或改写 JavaScript；剩余边界见兼容性矩阵。

## Architecture tutorials / 架构教程

All documents in this section are in **Simplified Chinese**. Examples illustrate the teaching model; use the compatibility matrix for the package's current supported behavior.

本节文档均为**简体中文**。示例用于讲解教学模型；实际包的当前支持范围以兼容性矩阵为准。

| Chapter / 章节 | Document / 文档 |
| --- | --- |
| 00 | [教程导读 / Tutorial guide](00-tutorial-guide.md) |
| 01 | [架构概览 / Architecture overview](01-architecture-overview.md) |
| 02 | [指令集设计 / Instruction-set design](02-instruction-set-design.md) |
| 03 | [AST 到 IR 编译 / AST-to-IR compilation](03-compiler-ast-to-ir.md) |
| 04 | [字节码发射与运行时 / Bytecode emission and runtime](04-emit-and-runtime.md) |
| 05 | [ES5 核心功能 / ES5 core features](05-es5-core-features.md) |
| 06 | [测试与调试 / Testing and debugging](06-testing-and-debugging.md) |

Runnable examples / 可运行示例：[examples/](examples/)。

## Build a VM from zero / 从零构建 VM

This separate, twelve-part tutorial is also in **Simplified Chinese**. Start with its [reading guide](from-zero-jsvm/README.md).

这套独立的十二篇教程同样为**简体中文**，建议先阅读[系列说明](from-zero-jsvm/README.md)。

| Chapter / 章节 | Document / 文档 |
| --- | --- |
| 01 | [第一台最小 VM / Your first VM](from-zero-jsvm/01-build-first-jsvm.md) |
| 02 | [字节码、指令与常量池 / Bytecode, opcodes, and constants](from-zero-jsvm/02-bytecode-opcode-constant-pool.md) |
| 03 | [从栈式到寄存器式 VM / From stack to register VM](from-zero-jsvm/03-stack-to-register-vm.md) |
| 04 | [变量、环境与暂时性死区 / Variables, environments, and TDZ](from-zero-jsvm/04-variables-environment-tdz.md) |
| 05 | [AST 到 IR 编译器 / AST-to-IR compiler](from-zero-jsvm/05-ast-to-ir-compiler.md) |
| 06 | [IR 到字节码 / IR-to-bytecode emission](from-zero-jsvm/06-ir-to-bytecode-emit.md) |
| 07 | [控制流与跳转 / Control flow and jumps](from-zero-jsvm/07-control-flow-jump.md) |
| 08 | [函数、调用帧与返回 / Functions, call frames, and returns](from-zero-jsvm/08-functions-call-frame-return.md) |
| 09 | [闭包与作用域链 / Closures and scope chains](from-zero-jsvm/09-closures-scope-chain.md) |
| 10 | [对象、数组与属性 / Objects, arrays, and properties](from-zero-jsvm/10-objects-arrays-properties.md) |
| 11 | [打包、模块、CLI 与调试 / Packaging, modules, CLI, and debugging](from-zero-jsvm/11-pack-modules-cli-debug.md) |
| 12 | [完整最小 JSVM 复盘 / Complete mini-JSVM review](from-zero-jsvm/12-complete-mini-jsvm-review.md) |
