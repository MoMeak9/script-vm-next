# Compile-time runtime assembly

The compiler retains its supported language features and generates an interpreter for each program. With the default `runtime: 'auto'`, programs include the instructions, execution loops and helper dependencies they need. A script that only calls `console.log` does not include class or generator support.

This happens inside the compiler. Consumers pass ordinary JavaScript without a Babel configuration, source rewrite or extra build step. The output remains a self-contained bytecode program and interpreter using host globals; it does not execute the original source as a fallback.

## Selecting a mode

```ts
import { compileSource } from 'script-vm-next/core'
import { compile, transform } from 'script-vm-next'

const output = compileSource('console.log("hello")') // runtime: 'auto'
const full = compileSource('console.log("hello")', { runtime: 'full' })

compile('./entry.js', './entry.vm.js', { runtime: 'auto' })
transform('./entry.js', { runtime: 'full' })

console.log(output.artifact.runtimeRequirements)
console.log(output.code.length, full.code.length)
```

```sh
script-vm-next entry.js --runtime auto
script-vm-next transform entry.js --runtime full --output entry.full.vm.js
```

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Analyze the compiled artifact and assemble the required interpreter. |
| `full` | Include the complete interpreter for debugging and differential validation. |

Both modes use the same bytecode, function metadata and constant pool. An invalid mode produces an `INVALID_OPTION` input diagnostic. The mode works with IIFE, CommonJS and ESM output; it does not change the source API's standalone-script restriction.

## How dependencies are selected

1. Decode actual instruction boundaries in every compiled function, including function bodies that have not run. Record opcodes, unary and binary operators, private intrinsic references and execution kinds.
2. Include requirements expressed by function metadata. For example, lexical `arguments` can be accessed through a slot, and generator parameter initialization can require the synchronous executor.
3. Specialize the runtime's parsed syntax tree: retain selected instruction and operator branches, choose the required execution loops, and resolve the dependencies between retained helper bindings. Shared helpers remain when another feature needs them.
4. Emit the selected runtime together with the unchanged bytecode and the requested output wrapper. The legacy dynamic-import bridge is emitted only when compiled code refers to it.

The analysis covers all compiled functions and bundled static dependencies. It does not delete a callback or export merely because it is not called during compilation. Compilation does not run the input or profile one execution path.

`artifact.runtimeRequirements` exposes the analysis manifest for inspection. Packing analyzes bytecode again instead of trusting a possibly stale manifest. The manifest describes compiler requirements, not a host capability detector or a guarantee of full ECMAScript conformance.

## Boundaries

- The optimization reduces each generated program. The installed compiler and the browser compiler bundle retain their complete compilation capabilities.
- Selection is conservative. Some shared frame, exception and helper machinery remains whenever a retained execution path depends on it; the output is not promised to be the smallest possible hand-written interpreter.
- `full` is an explicit diagnostic option. It does not implement unsupported syntax or repair existing semantic gaps. See the [compatibility matrix](compatibility.md).
- Host-built objects remain host-provided. Runtime selection adds neither polyfills nor a security sandbox.
- Dynamic `import()` support is unchanged. The source API rejects it; the file API retains its existing loading and resolution limitations.

## Validation

Regression tests compare explicit `auto` and `full` compilation and execute retained callbacks, generators, async functions, classes, private helpers and module outputs. Size regressions check both the emitted source and minimized code, while structural checks verify that simple scripts omit unused execution loops and helper families. The complete unit and pinned Test262 suites are also run in each mode; the pinned subset retains its [documented scope](test262.md).
