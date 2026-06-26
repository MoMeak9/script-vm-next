# script-vm-next — Project Index

> Register-based JavaScript virtualization tool that compiles JavaScript into custom bytecode and emits pure JavaScript with an embedded runtime interpreter.

**Version:** 0.1.0
**Package:** `script-vm-next`
**Runtime:** Node.js ≥20
**Package Manager:** pnpm

---

## Table of Contents

- [Directory Structure](#directory-structure)
- [Architecture](#architecture)
- [Compilation Pipeline](#compilation-pipeline)
- [Module Reference](#module-reference)
- [Opcode System](#opcode-system)
- [Runtime Engine](#runtime-engine)
- [Key Data Structures](#key-data-structures)
- [Module Bundler](#module-bundler)
- [Test Infrastructure](#test-infrastructure)
- [CLI Usage](#cli-usage)
- [API Usage](#api-usage)
- [Supported Features](#supported-features)
- [Roadmap / Not Yet Implemented](#roadmap)
- [Dependencies](#dependencies)

---

## Directory Structure

```
script-vm-next/
├── src/
│   ├── index.ts                 # Public API (compile, transform, resolveFormat)
│   ├── cli.ts                   # CLI entry (commander-based)
│   ├── compiler/
│   │   ├── index.ts             # Barrel export
│   │   ├── pipeline.ts          # Orchestrates 7-stage compilation
│   │   ├── frontend.ts          # Babel parse + AST normalization
│   │   ├── lowering.ts          # AST → IR generation
│   │   ├── ir.ts                # IR instruction & type definitions
│   │   ├── regalloc.ts          # Register allocation (stub)
│   │   ├── emit.ts              # IR → numeric bytecode
│   │   ├── pack.ts              # Bytecode + runtime → final JS
│   │   ├── runtime-gen.ts       # Generates VM interpreter source
│   │   ├── bundler.ts           # ESM/CJS module bundler
│   │   ├── constants.ts         # Global preamble, ROOT_THIS
│   │   └── types.ts             # TypeScript interfaces
│   ├── runtime/
│   │   └── opcodes.ts           # Opcode & operator numeric codes
│   └── __tests__/
│       ├── helpers.ts           # Test utilities (sandbox, temp files)
│       ├── runtime.test.ts      # 16 runtime feature tests
│       ├── modules.test.ts      # ESM/CJS bundling tests
│       └── cli.test.ts          # CLI command tests
├── dist/                        # Compiled JS output
├── index.js                     # Example input (Hello World IIFE)
├── index.vm.cjs                # Example compiled output
├── package.json
├── tsconfig.json
└── README.md
```

---

## Architecture

The compiler follows a classic multi-pass pipeline from source to self-contained JavaScript:

```
┌──────────┐    ┌───────┐    ┌───────────┐    ┌─────────┐    ┌────────┐    ┌──────┐    ┌──────┐
│  Bundle  │ →  │ Parse │ →  │ Normalize │ →  │  Lower  │ →  │ RegAll │ →  │ Emit │ →  │ Pack │
│(optional)│    │(Babel)│    │  (AST)    │    │ (→ IR)  │    │ (stub) │    │(→BC) │    │(→JS) │
└──────────┘    └───────┘    └───────────┘    └─────────┘    └────────┘    └──────┘    └──────┘
```

**Key design decisions:**
- **Register-based VM** — per-function register frames for temporaries, slot-based environments for closures
- **No external runtime dependency** — output is pure, self-contained JavaScript
- **Non-SSA IR** — simple flat instruction list with labels for jumps
- **Label-based control flow** — all branches use symbolic labels, resolved to bytecode offsets during emission

---

## Compilation Pipeline

### Stage 1 — Bundle (`bundler.ts`, 1056 lines)
Optional. Resolves relative imports (ESM `import`/`export`, CJS `require`/`module.exports`), builds dependency graph, topologically sorts modules, and inlines them into a single source with a module registry (`__m`). External modules are preserved as `require()` calls.

### Stage 2 — Parse (`frontend.ts:parseSource`)
Uses `@babel/parser` with plugins: `classProperties`, `classPrivateProperties`, `classPrivateMethods`, `optionalChaining`, `nullishCoalescingOperator`.

### Stage 3 — Normalize (`frontend.ts:normalizeAst`)
AST transformations:
- Arrow functions → `FunctionExpression`
- Class declarations → variable declaration + IIFE
- Private fields → `WeakMap`-based get/set helpers
- Private methods → `WeakSet` validation + helper functions
- `super()` → `_super` helper wrapping `Reflect.construct`

### Stage 4 — Lower (`lowering.ts`, 910 lines)
Converts normalized AST into IR instructions. Key abstractions:
- **`FunctionBuilder`** — manages register allocation, scope tracking, label generation per function
- **`ScopeFrame`** — tracks bindings (`var`, `let`, `const`, `param`, `function`, `catch`) with slot numbers
- Hoists `var` and `function` declarations to function root; `let`/`const` to inner block scopes
- Resolves closure bindings via `depth` parameter for parent scope traversal

### Stage 5 — Register Allocation (`regalloc.ts`)
Currently a pass-through stub. Framework in place for future optimization.

### Stage 6 — Emit (`emit.ts`, 186 lines)
- `ConstantPool` deduplicates literal values
- Converts each IR instruction to numeric bytecode `[opcode, ...operands]`
- Label fixup pass replaces symbolic label references with bytecode offsets
- Generates optional debug info

### Stage 7 — Pack (`pack.ts`, 46 lines)
Wraps bytecode artifact + generated runtime interpreter into final JS:
- **IIFE** (default): self-executing, returns result
- **ESM**: adds `export` statements
- **CJS**: adds `module.exports` assignment

---

## Module Reference

| File | Lines | Purpose |
|------|------:|---------|
| `pipeline.ts` | 72 | Orchestrates all 7 compilation stages |
| `frontend.ts` | 699 | Babel parse, AST normalization (classes, private fields, arrows) |
| `lowering.ts` | 910 | AST → IR with scope analysis, hoisting, closure capture |
| `ir.ts` | 56 | IR instruction types, `FunctionIR`, `SlotKind`, `BindingRef` |
| `emit.ts` | 186 | IR → bytecode with constant pool and label fixup |
| `regalloc.ts` | 7 | Register allocation stub |
| `bundler.ts` | 1056 | Module resolution, dependency graph, inline bundling |
| `pack.ts` | 46 | Artifact + runtime → final JS wrapper |
| `runtime-gen.ts` | 1055 | Generates complete VM interpreter source code |
| `constants.ts` | 6 | `JS_PREAMBLE`, `ROOT_THIS`, `ARGUMENTS_NAME` |
| `types.ts` | 49 | `CompileOptions`, `ProgramArtifact`, `FunctionMeta`, etc. |
| `opcodes.ts` | 65 | 33 opcodes, 15 binary ops, 5 unary ops |
| `cli.ts` | 45 | Commander-based CLI |
| `index.ts` | 10 | Public API exports |

**Total:** ~4,300 lines of TypeScript source

---

## Opcode System

Defined in `src/runtime/opcodes.ts`.

### Opcodes (33)

| Code | Name | Operands | Description |
|-----:|------|----------|-------------|
| 1 | `ENTER_SCOPE` | funcId | Create new lexical scope environment |
| 2 | `LEAVE_SCOPE` | — | Exit current scope |
| 3 | `REPLACE_SCOPE` | funcId | Replace current scope (loop iteration) |
| 4 | `LOAD_CONST` | dst, poolIdx | Load constant from pool into register |
| 5 | `MOVE` | dst, src | Copy register value |
| 6 | `LOAD_SLOT` | dst, depth, slot | Read variable from scope chain |
| 7 | `INIT_SLOT` | depth, slot, src | Initialize let/const binding |
| 8 | `STORE_SLOT` | depth, slot, src | Write to variable in scope |
| 9 | `LOAD_GLOBAL` | dst, nameIdx | Load global variable |
| 10 | `STORE_GLOBAL` | nameIdx, src | Write global variable |
| 11 | `GET_PROP` | dst, obj, prop | Property access |
| 12 | `SET_PROP` | obj, prop, val | Property assignment |
| 13 | `BINARY` | dst, op, lhs, rhs | Binary operation |
| 14 | `UNARY` | dst, op, src | Unary operation |
| 15 | `JUMP` | target | Unconditional jump |
| 16 | `JUMP_IF_FALSE` | cond, target | Conditional jump |
| 17 | `CALL` | dst, fn, this, argc, ...args | Function call |
| 18 | `MAKE_FUNCTION` | dst, funcId | Create closure |
| 19 | `RETURN` | src | Return from function |
| 20 | `LOAD_THIS` | dst | Load `this` value |
| 21 | `LOAD_ARGUMENTS` | dst | Load arguments array |
| 22 | `ARRAY_NEW` | dst | Create empty array |
| 23 | `OBJECT_NEW` | dst | Create empty object |
| 24 | `ARRAY_PUSH` | arr, val | Push value to array |
| 25 | `OBJECT_SET` | obj, key, val | Set object property |
| 26 | `LOAD_UNDEFINED` | dst | Load `undefined` |
| 27 | `NEW` | dst, ctor, argc, ...args | Constructor call |
| 28 | `THROW` | src | Throw exception |
| 29 | `TRY` | tryStart, catchStart, finallyStart, end, catchSlot | Exception handling block |
| 30 | `AWAIT` | dst, src | Await expression |
| 31 | `YIELD` | dst, src, delegate | Yield expression |

### Binary Operators (15)

| Code | Operator |
|-----:|----------|
| 1–5 | `+` `-` `*` `/` `%` |
| 6–9 | `==` `===` `!=` `!==` |
| 10–13 | `>` `>=` `<` `<=` |
| 14–15 | `&&` `\|\|` |

### Unary Operators (5)

| Code | Operator |
|-----:|----------|
| 1–5 | `!` `-` `+` `typeof` `void` |

---

## Runtime Engine

Generated by `runtime-gen.ts`. The output is a self-contained JS function: `__scriptvmRun(metadata, globalObject)`.

### Execution Model

```
metadata (JSON)
├── bytecode: number[]         ← flat instruction stream
├── constantPool: any[]        ← deduplicated literals
├── functions: FunctionMeta[]  ← per-function register/slot counts, entry offsets
└── entryFunctionId: number    ← main function index
```

### Environment Chain

Each function call creates an `env` object:
```
env {
  slots: any[]          ← variable storage
  slotState: number[]   ← 0=uninitialized, 1=initialized (TDZ enforcement)
  parent: env | null    ← closure scope chain
  thisVal: any          ← bound this
  args: any[]           ← arguments array
}
```

### Execution Modes

| Flag Combination | Execution Function | Mechanism |
|-----------------|-------------------|-----------|
| `async:false, generator:false` | `executeSync()` | Direct bytecode loop |
| `async:true, generator:false` | `executeAsync()` | `async function` wrapper |
| `async:false, generator:true` | `executeGenerator()` | `function*` wrapper with yield |
| `async:true, generator:true` | `executeAsyncGenerator()` | `async function*` wrapper |

### Completion Values

Control flow uses a completion model:
```
{ type: 'normal' | 'return' | 'throw', value: any }
```

### Key Runtime Helpers

- `resolveEnv(env, depth)` — walk parent chain for closure variable access
- `readSlot(env, slot)` — read with TDZ check (throws `ReferenceError` if uninitialized)
- `writeSlot(env, slot, value, isInit)` — write with `const` protection (`TypeError`)
- `createEnv(meta, parent, thisVal, args)` — create new scope environment
- `createClosure(functionId, parentEnv)` — bind function ID with parent scope

---

## Key Data Structures

### `CompileOptions` (`types.ts`)
```typescript
{
  format?: 'iife' | 'esm' | 'cjs' | 'auto'
  bundle?: boolean
  external?: string[]
  basePath?: string
  debug?: boolean
  obfuscate?: boolean  // reserved for v0.2
}
```

### `ProgramArtifact` (`types.ts`)
```typescript
{
  format: 'iife' | 'esm' | 'cjs'
  bytecode: number[]
  constantPool: any[]
  functions: FunctionMeta[]
  entryFunctionId: number
  exportNames: string[]
  debugInfo?: { instructions: string[] }
}
```

### `FunctionMeta` (`types.ts`)
```typescript
{
  id: number
  name: string | null
  entry: number           // bytecode offset
  end: number
  registerCount: number   // temp register count
  slotCount: number       // local variable slots
  params: number
  slotNames: string[]
  slotKinds: SlotKind[]   // 'var'|'let'|'const'|'param'|'function'|'catch'
  async: boolean
  generator: boolean
}
```

### `FunctionIR` (`ir.ts`)
```typescript
{
  id: number
  name: string | null
  params: number
  registers: number
  slots: { name: string; kind: SlotKind }[]
  body: IRInstruction[]
  async: boolean
  generator: boolean
}
```

### `SlotKind` — `'var' | 'let' | 'const' | 'param' | 'function' | 'catch'`

---

## Module Bundler

The bundler (`bundler.ts`) handles both ESM and CJS module systems:

### Resolution Strategy
1. Resolve relative imports with extension fallback: `.js`, `.ts`, `.mjs`, `.cjs`
2. Build dependency graph via recursive traversal
3. Detect circular dependencies
4. Topological sort for correct evaluation order

### Transform Strategy
| Source Pattern | Transformed To |
|---------------|---------------|
| `import { x } from './mod'` | `var x = __m['mod'].x` |
| `export function f() {}` | `__exports.f = function f() {}` |
| `require('./mod')` | `__m['mod']` |
| `module.exports = x` | `__exports = x` |
| External import | Preserved as `require('pkg')` |

### Output Structure
```javascript
var __m = {};
// Module 0 (dependency)
(function(__exports) { ... __m['dep'] = __exports; })({});
// Module 1 (entry)
(function(__exports) { ... })({});
```

---

## Test Infrastructure

**Framework:** Vitest 2.1.0
**Location:** `src/__tests__/`

### Test Suites

| File | Tests | Coverage |
|------|------:|---------|
| `runtime.test.ts` | 16 | Arithmetic, closures, constructors, loops, scoping, TDZ, classes, private fields, async/await, generators, format detection |
| `modules.test.ts` | 2 | ESM and CJS bundling with dependencies |
| `cli.test.ts` | 2 | File output and transform subcommand |

### Test Helpers (`helpers.ts`)

| Function | Purpose |
|----------|---------|
| `makeTempDir(prefix)` | Create temp directory for test artifacts |
| `writeTempFile(dir, name, src)` | Write source to temp file |
| `runIifeCode(code, sandbox)` | Execute IIFE code in Node.js VM sandbox |
| `compileAndRunSource(source)` | Compile → run → return `__result` |
| `compileToEsmModule(files, entry)` | Bundle → compile → dynamic import |
| `compileToCjsModule(files, entry)` | Bundle → compile → require |

### Sandbox Globals
`console`, `Reflect`, `Object`, `Array`, `String`, `Number`, `Boolean`, `Math`, `JSON`, `Date`, `RegExp`, `Error`, `TypeError`, `Promise`, `Symbol`, `WeakMap`, `WeakSet`

### Running Tests
```bash
pnpm test          # build + vitest run
pnpm test:watch    # vitest in watch mode
```

---

## CLI Usage

```bash
# Default: compile input.js → stdout (IIFE format)
script-vm-next input.js

# Specify output file and format
script-vm-next input.js -o output.vm.js -f esm

# Disable bundling, mark packages as external
script-vm-next input.js --no-bundle --external lodash --external axios

# Transform subcommand (alias)
script-vm-next transform input.js -o output.js

# Enable debug info in output
script-vm-next input.js --debug
```

### CLI Options

| Flag | Description |
|------|-------------|
| `-o, --output <file>` | Output file path (default: stdout) |
| `-f, --format <fmt>` | Output format: `iife`, `esm`, `cjs`, `auto` |
| `--no-bundle` | Skip module bundling |
| `--external <pkg>` | Mark packages as external (repeatable) |
| `--debug` | Include debug info in output |

---

## API Usage

```typescript
import { compile, transform, resolveFormat } from 'script-vm-next';

// Full compilation with options
const result = compile('path/to/input.js', {
  format: 'esm',
  bundle: true,
  external: ['lodash'],
  debug: false,
});
// result: { code: string, artifact: ProgramArtifact }

// Quick transform (returns code string only)
const code = transform('path/to/input.js', { format: 'iife' });

// Detect module format from source
const format = resolveFormat(sourceCode, 'auto');
// Returns: 'esm' | 'cjs' | 'iife'
```

---

## Supported Features

### Fully Supported (v0.1)

| Category | Features |
|----------|----------|
| **Variables** | `var`, `let`, `const` with proper scoping, hoisting, TDZ |
| **Operators** | All arithmetic, comparison, logical, unary (`!`, `-`, `+`, `typeof`, `void`) |
| **Functions** | Declarations, expressions, arrow functions, closures, default params |
| **Async** | `async`/`await`, async error handling |
| **Generators** | `function*`, `yield`, `yield*`, async generators |
| **Classes** | Declarations, expressions, `extends`, `super`, instance/static fields, instance/static methods, private fields (`#field`), private methods (`#method`) |
| **Control Flow** | `if`/`else`, `for`, `while`, `do-while`, `break`, `continue` |
| **Exceptions** | `try`/`catch`/`finally`, `throw` |
| **Objects** | Literals, member access, computed properties, method calls |
| **Arrays** | Literals, element access, push operations |
| **Other** | Template literals, `new`, `this`, `arguments`, `typeof` |
| **Modules** | ESM `import`/`export`, CJS `require`/`module.exports`, bundling |

### Not Yet Implemented {#roadmap}

- Private accessors (`get`/`set` on private fields)
- Per-iteration lexical capture for `for (let ...)` closures
- Fresh runtime bindings for repeated `catch` blocks in closure paths
- `for await...of` and async generator edge cases
- Destructuring assignments
- Spread/rest operators
- Obfuscation pipeline (reserved for v0.2)

---

## Dependencies

### Runtime
| Package | Version | Purpose |
|---------|---------|---------|
| `@babel/parser` | ^7.25.6 | JavaScript parsing |
| `@babel/traverse` | ^7.25.6 | AST traversal |
| `@babel/generator` | ^7.25.6 | AST → source code |
| `@babel/types` | ^7.25.6 | AST type utilities |
| `commander` | ^13.1.0 | CLI argument parsing |

### Development
| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.6.2 | TypeScript compiler |
| `vitest` | ^2.1.0 | Test framework |
| `ts-node` | ^10.9.2 | TypeScript execution |
| `@types/node` | ^22.5.4 | Node.js type definitions |

---

## Module Dependency Graph

```
src/index.ts
└── compiler/pipeline.ts
    ├── compiler/bundler.ts
    ├── compiler/frontend.ts
    │   └── @babel/* (parser, traverse, types)
    ├── compiler/lowering.ts
    │   └── compiler/ir.ts
    ├── compiler/regalloc.ts
    ├── compiler/emit.ts
    │   └── runtime/opcodes.ts
    └── compiler/pack.ts
        ├── compiler/constants.ts
        └── compiler/runtime-gen.ts
            └── runtime/opcodes.ts

src/cli.ts
└── compiler/index.ts → compiler/pipeline.ts
```
