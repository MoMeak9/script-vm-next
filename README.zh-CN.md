# script-vm-next

[English](README.md) | **简体中文** | [Documentation / 文档导航](docs/README.md)

基于寄存器的 JavaScript 虚拟化编译器，将源代码转换为字节码和自包含的 JavaScript 解释器，提供 Node.js API、命令行工具和浏览器演示页。

项目当前实现的是 **经过测试的 JavaScript 子集**，目标版本为 **`0.2.0-beta.1`**，尚不宣称完整符合 ES2015/ES6，也不宣称已适用于所有生产场景。接入应用代码前，请阅读[兼容性矩阵（英文）](docs/compatibility.md)。

## 在线体验

演示页已通过 GitHub Actions 部署到 GitHub Pages：**[momeak9.github.io/script-vm-next](https://momeak9.github.io/script-vm-next/)**。可以编辑独立脚本、编译、查看生成代码和统计信息，并在带有日志上限和停止按钮的环境中运行。

演示页接受单文件 JavaScript，输出 IIFE。运行环境不提供 DOM、本地模块、`require` 或动态 `import()`。编译在浏览器本地 Worker 中完成；执行使用独立 Worker，位于具有不透明来源、禁止网络访问的沙箱 iframe 内。下载后的代码使用其执行宿主的全局对象：**编译产物本身不是安全沙箱**。

执行模型和 GitHub Pages 配置见[演示页使用与部署（英文）](docs/playground.md)。

## 安装

npm 包目前**尚未发布**，发布需要版权持有人确定许可证，并配置 npm 发布权限。待 `beta` 标签可用后，可通过以下命令安装：

```sh
npm install script-vm-next@beta
```

安装后的 Node.js 包要求 Node.js 20 或更新版本。仓库开发工具的最低版本要求更高，见下文。浏览器应用应通过打包工具导入 `script-vm-next/core`。

在 npm 发布前，可以本地构建并验证安装包：

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
pnpm build
pnpm test:package
```

安装包验收会在独立目录安装真实 tarball，检查 CommonJS、ESM 命名导入、严格 TypeScript 使用方、两个 API 入口以及安装后的 CLI。验收通过的压缩包保存在 `artifacts/`；其他项目可使用 `npm install /absolute/path/to/script-vm-next/artifacts/script-vm-next-0.2.0-beta.1.tgz` 安装。

## 源码 API：Node.js 与浏览器打包工具

```ts
import { compileSource, CompileError } from 'script-vm-next/core'

try {
  const result = compileSource('console.log(6 * 7)', {
    filename: 'example.js',
    format: 'iife',
  })

  console.log(result.code)
  console.log(result.artifact.bytecode.length)
  console.log(result.artifact.functions.length)
} catch (error) {
  if (error instanceof CompileError) {
    console.error(error.code, error.filename, error.line, error.column, error.message)
  } else {
    throw error
  }
}
```

`compileSource(source, options?)` 是同步 API，不读写文件，也不执行输入代码。它接受独立脚本，拒绝模块语法和没有局部绑定的 CommonJS 全局变量，返回 `{ code, artifact }`。`filename` 只用于诊断信息，不会解析或读取对应文件；`debug: true` 可附带指令调试信息。诊断位置如可用，行号和列号均从 1 开始。

默认的 `runtime: 'auto'` 会在编译期分析所有已编译函数所需的指令和辅助函数，按需组装解释器。简单的 `console.log` 程序无需携带类、异步或生成器实现。排查问题时可使用 `runtime: 'full'` 保留完整解释器。两种模式使用相同字节码，并保持相同的受支持语言行为；调用方无需改写源码或配置额外构建步骤。依赖分析与边界说明见[运行时按需组装（英文）](docs/runtime-assembly.md)。

CommonJS 使用方可以写 `const { compileSource } = require('script-vm-next/core')`。包中包含类型声明。根入口也导出 `compileSource`，但浏览器打包工具应使用专门的 `core` 入口，避免引入 Node 文件系统依赖。

## 文件 API：Node.js

```ts
import { compile, transform } from 'script-vm-next'

// 读取入口文件，打包受支持的本地模块，并写入输出文件。
const result = compile('./input.js', './output.vm.js', { format: 'iife' })

// 读取并编译文件，不写入输出文件。
const inMemory = compile('./input.js', null, { format: 'iife' })
const code = transform('./input.js', { format: 'iife' })
```

`compile(inputPath, outputPath?, options?)` 和 `transform(inputPath, options?)` 都以文件路径作为输入。`transform` 返回生成代码字符串；`compile` 返回与源码 API 相同的 `{ code, artifact }` 结构。省略 `outputPath` 时，会根据最终格式在输入文件旁写入 `.vm.js`、`.vm.mjs` 或 `.vm.cjs` 文件；传入 `null` 则不写文件。

文件 API 支持 `format: 'auto' | 'iife' | 'esm' | 'cjs'`、`runtime: 'auto' | 'full'`（默认为 `auto`）、`bundle`（默认为 `true`）、`external: string[]` 和 `debug`。自动格式检测会结合文件扩展名与模块语法。模块加载和输出格式的当前边界见[兼容性矩阵（英文）](docs/compatibility.md)。预留的 `obfuscate` 选项尚未实现，传入后会被拒绝。

## 命令行

安装后可以运行：

```sh
npx script-vm-next input.js --output output.vm.js --format iife
node output.vm.js
npx script-vm-next --help
```

也支持 `transform` 子命令。选项包括 `--format auto|iife|esm|cjs`、`--runtime auto|full`（默认为 `auto`）、`--no-bundle`、`--external module-a,module-b` 和 `--debug`。编译失败时返回非零退出码，并输出诊断代码；可获取源代码位置时，也会一并报告。

## 语言支持边界

直接将普通 JavaScript 传给源码 API、文件 API 或 CLI 即可。已支持功能的兼容处理默认由编译器和运行时内部完成，调用方无需配置 Babel、额外增加转译步骤或改写源代码。剩余缺口属于编译器和运行时需要继续补齐的工作，统一记录在[兼容性矩阵（英文）](docs/compatibility.md)。

测试覆盖了闭包、词法绑定、普通函数与箭头函数、解构、迭代器、类、生成器、异步函数和模块包装的部分场景。这些结论仅适用于已经覆盖的场景，不代表完整实现了对应语言版本。ES6 指 ES2015，后续版本的功能单独记录覆盖情况。代码能够解析成功，也可能遇到尚未验证的语义边界。生成程序使用宿主提供的 `Promise`、`Map`、`Symbol` 等内置对象；当前包不提供 polyfill 层。

## 开发与验证

使用 pnpm **10.34.6**，以及 Node.js **20.19+**、**22.13+** 或 **24**，以满足开发工具要求：

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
pnpm build
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:package
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm test` 会先构建，再运行编译器测试。已有构建产物时，可以使用 `pnpm test:unit` 避免重复构建。`pnpm test:e2e` 会构建演示页、启动预览服务并在 Chromium 中测试。Linux 环境可能需要运行 `pnpm exec playwright install --with-deps chromium`，同时安装浏览器依赖的系统库。

开发演示页：

```sh
pnpm demo:dev
```

查看生产构建：

```sh
pnpm demo:build
pnpm demo:preview
```

[CI 工作流](.github/workflows/ci.yml) 在 Node.js 20、22、24 上验证编译器；Node.js 24 还会运行 lint、类型检查、独立安装包验收和浏览器测试。Pages 与 npm 发布工作流使用相同的验收门槛，并部署该次验收产出的文件。剩余维护者配置和发布步骤见[发布指南（英文）](docs/releasing.md)。

## 架构与后续工作

源代码 → 可选的 Node 模块打包 → Babel 解析与规范化 → 寄存器式 IR → 字节码与运行时需求 → 编译期按需组装运行时 → 输出包装。

从[文档导航](docs/README.md)开始阅读，索引会标明每份文档的语言。[架构概览](docs/01-architecture-overview.md)与[系列教程](docs/00-tutorial-guide.md)目前为简体中文，[兼容性矩阵](docs/compatibility.md)目前为英文。目前已接入[固定版本的 Test262 基线](docs/test262.md)，在 Node.js 20、22、24 上执行 219 个选定的 ES2015 测试文件（428 个执行变体）。后续工作包括扩大已记录的测试范围、增加原生 JavaScript 与 VM 的差分回归测试、修复已知语义缺口，以及验证实际应用代码。稳定版需要足以支撑其语言支持范围的验证证据，打包与演示页本身不能证明语言语义完整。

## 许可证

目前包标记为 `UNLICENSED`，等待版权持有人确定许可证。在选定许可证并提供 `LICENSE` 文件前，发布工作流会阻止 npm 发布。
