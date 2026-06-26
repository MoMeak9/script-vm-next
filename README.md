# script-vm-next

`script-vm-next` is a register-based JavaScript virtualization prototype that emits pure JavaScript output.

## Current Scope

- Pure JS self-contained runtime output
- Register-based bytecode with per-function register frames
- Lexical slot environments for closures
- IIFE / ESM / CJS output wrapping
- ESM / CJS module bundling before compilation
- CLI, `compile()`, and `transform()` entry points

## Architecture

1. Parse and normalize source with Babel
2. Lower AST into a simple non-SSA IR
3. Emit compact numeric bytecode plus function metadata
4. Generate a JavaScript runtime interpreter
5. Pack runtime + metadata into the final JS artifact

## Supported In v0.1

- Variable declarations and assignments
- Compound assignments and update expressions
- Arithmetic, comparison, logical, and unary operators
- Nullish coalescing, `instanceof`, and `in`
- Functions, closures, member access, method calls, and `this`
- `new`, object literals, array literals, and array holes
- Object/array destructuring with nesting, defaults, and rest
- Rest parameters and spread in calls, arrays, objects, and `new`
- `if`, `for`, `while`, `do-while`, `break`, `continue`
- `for...of`, `for...in`, and `for await...of`
- `let` / `const` block scoping
- Temporal Dead Zone checks for lexical bindings
- Per-iteration lexical capture for `for (let ...)`
- Fresh catch bindings for repeated `catch` execution
- `try/catch/finally`, `throw`
- `class`, `extends`, `super`
- Instance and static class fields
- Private class fields, methods, and accessors
- `async` / `await`
- `async function*`
- `function*`, `yield`, `yield*`
- Template literals
- `switch` statements (with fallthrough, default, and lexical declarations)
- Optional chaining (`?.`)
- Object literal methods, getters, and setters
- RegExp literals
- `delete` operator
- Class static blocks (`static {}`)
- `BigInt` literals
- Constructor/function parameter patterns (destructuring, defaults, rest)
- Tagged template expressions
- Labeled statements, labeled `break`, labeled `continue`
- `debugger` (no-op in VM)
- Dynamic `import()`
- `new.target`
- Arrow functions with lexical `this`, `arguments`, `super`, and `new.target`
- Module bundling and export wrappers

## Known Limitations

script-vm-next v0.1 supports a substantial subset of modern JavaScript, but it does **not** provide full ES6+ language coverage yet.

### Explicitly Unsupported Syntax

- `with`

### Supported with Caveats

- `for...of` / `for await...of` call `iterator.return()` on `break`/`return`/`throw`, but do not model full iterator-closing semantics for every edge case.
- `for...in` is desugared through `Object.keys(...)` rather than the full spec enumeration model (no prototype chain properties).
- Dynamic `import()` resolves relative to the packed output location, not the original source.

### Outside v0.1 Scope

- Extra obfuscation pipeline (reserved for v0.2)

## Next Syntax Roadmap

### ~~Priority 1 — Common Real-World Blockers~~ (Done)

All Priority 1 items have been implemented: optional chaining, `switch`, object literal methods/getters/setters, RegExp literals.

### ~~Priority 2 — Semantic Correctness Gaps~~ (Done)

Completed: arrow function lexical `this`/`arguments`, iterator closing for `for...of`/`for await...of`, assignment destructuring defaults and rest. `for...in` kept as `Object.keys()` (documented caveat).

### ~~Priority 3 — Class and Expression Completeness~~ (Done)

Completed: `delete` operator, class static blocks, constructor/function parameter pattern desugaring, `BigInt` literals.

### ~~Priority 4 — Longer Tail Features~~ (Done)

Completed: tagged template expressions, labeled statements, `debugger` (no-op), dynamic `import()`.

### ~~Remaining Feature Gaps~~ (Done)

Completed: arrow `super` in class methods (fixed class visitor traversal), `new.target` (full pipeline: opcode + IR + runtime + arrow capture).

### v0.2 Scope

- Obfuscation pipeline
