# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

script-vm-next is a register-based JavaScript virtualization compiler that transforms JS source code into compact bytecode executed by a pure-JS runtime interpreter. It produces self-contained JavaScript output (no native dependencies).

## Commands

```bash
pnpm build              # Compile TypeScript (tsc -p tsconfig.json) → dist/
pnpm test               # Build then run all tests (vitest run)
pnpm test:watch         # Watch mode tests
npx vitest run src/__tests__/runtime.test.ts  # Run a single test file
npx vitest run -t "test name"                 # Run a single test by name
pnpm dev -- <input>     # Run CLI in dev mode via ts-node
```

Note: `pnpm test` requires a successful build first (the script chains `pnpm build && vitest run`).

## Architecture

The compiler is a multi-stage pipeline (`src/compiler/pipeline.ts`):

```
Source JS → [Bundle] → Parse (Babel) → Normalize AST → Lower to IR → Register Alloc → Emit Bytecode → Generate Runtime → Pack Artifact
```

### Pipeline Stages

1. **Bundler** (`bundler.ts`) — Optional. Resolves ESM/CJS imports, topologically sorts modules, detects circular dependencies. Runs before compilation when the source has module syntax.

2. **Frontend** (`frontend.ts`) — Parses source with Babel, normalizes AST (e.g., converts `ForStatement` init to preceding declarations), detects module format from file extension and syntax.

3. **Lowering** (`lowering.ts`) — The largest and most complex file. Converts AST into a flat register-based IR. Key abstractions:
   - `FunctionBuilder`: manages per-function state (slots, registers, labels, instruction stream)
   - `ScopeFrame`: tracks lexical scopes with runtime depth for closure environment resolution
   - Handles hoisting, TDZ checks, const write protection, and all JS control flow

4. **Register Allocation** (`regalloc.ts`) — Assigns virtual register indices to IR operands.

5. **Bytecode Emission** (`emit.ts`) — Converts IR instructions to numeric bytecode arrays, builds the constant pool, resolves jump labels to offsets.

6. **Runtime Generation** (`runtime-gen.ts`) — Auto-generates the JavaScript interpreter function (`__scriptvmRun`) that executes the bytecode. Includes environment/scope management, operator dispatch, closure creation, and async/generator support.

7. **Packing** (`pack.ts`) — Combines runtime code + bytecode + metadata into final JS output, wrapped as IIFE/ESM/CJS.

### Key Data Structures

- **IR** (`ir.ts`): `IRInstruction` (40+ instruction types), `FunctionIR` (per-function IR with slots), `BindingRef` (slot or global reference), `SlotKind` (var/let/const/param/function/catch)
- **Opcodes** (`runtime/opcodes.ts`): 31 numeric opcodes covering memory, arithmetic, control flow, function calls, async, generators
- **Types** (`compiler/types.ts`): `CompileOptions`, `FunctionMeta`, `ProgramArtifact`, `CompiledOutput`

### Entry Points

- **API**: `src/index.ts` exports `compile()`, `transform()`, `resolveFormat()`
- **CLI**: `src/cli.ts` — `script-vm-next <input> [-o output] [-f format] [--no-bundle] [--external] [--debug]`

## Testing

Tests live in `src/__tests__/` and use Vitest:

- `runtime.test.ts` — Core language feature tests (arithmetic, closures, classes, async, generators, etc.). Uses `compileAndRunSource()` helper that writes temp files, compiles to IIFE, and executes in a sandboxed `vm.Context`.
- `modules.test.ts` — ESM/CJS module bundling and re-export tests.
- `cli.test.ts` — End-to-end CLI compilation tests.

Test pattern: write JS source as a string → compile via `transform()` → execute output → assert `__result` global equals expected value. See `src/__tests__/helpers.ts` for the `compileAndRunSource`, `compileToEsmModule`, and `compileToCjsModule` utilities.

## Key Conventions

- Output format is auto-detected from file extension (`.mjs` → ESM, `.cjs` → CJS) and source syntax, but can be overridden with `--format`.
- Obfuscation is reserved for v0.2 — calling `compile()` with `obfuscate: true` throws.
- TypeScript is configured with `strict: false`, ES2020 target, CommonJS output.
- The runtime interpreter is generated as a string (not a static file) so it can be tree-shaken to only include opcodes actually used.
