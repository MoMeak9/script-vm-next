# JavaScript compatibility

This document records the compiler's current test coverage and known limitations. **ES6 means ES2015**; async functions, optional chaining, and private fields belong to later editions. A feature's presence in Babel's parser or in the compiler is not proof of runtime conformance.

## Reading the matrix

- **Regression-covered**: focused tests compare selected native and VM observations, or check a specific representation invariant. The claim applies to those cases only.
- **Example-covered**: existing tests exercise representative cases. Full semantics and edge cases have not been established.
- **Known gap**: a supported-looking input can behave differently from native JavaScript. Check the limitation before using that feature.
- **Rejected**: the compiler reports an error for the identified case.

These categories can overlap: a feature can have useful test coverage and still have a known gap. No row implies full standards conformance. Untested combinations remain unverified. Standard-library objects such as `Map`, `Set`, `Promise`, and `Symbol` are provided by the execution host, not by a compiler polyfill layer.

## ES2015 and earlier

| Feature / semantic boundary | Status and evidence | Remaining boundary |
| --- | --- | --- |
| Numeric literals and constant serialization | Regression-covered: [constant tests](../src/__tests__/constant-semantics.test.ts) cover non-finite numbers, negative zero, and preservation of primitive constants. | Representation checks do not establish all arithmetic semantics. |
| Calls, property access, compound assignment, and updates | Regression-covered: [expression tests](../src/__tests__/expression-semantics.test.ts) compare selected evaluation-order and numeric-conversion cases. | Uncovered operator combinations and exotic object coercions remain unverified. |
| `var`, functions, and closures | Example-covered: [runtime tests](../src/__tests__/runtime.test.ts) exercise lexical slot resolution and closure capture. | Complete declaration instantiation and function reflection semantics have not been audited. |
| `let` / `const`, TDZ, and block scope | Example-covered: runtime tests exercise shadowing, TDZ reads, const reassignment, per-iteration capture, and fresh catch bindings. | All declaration forms, nested scopes, and interactions with parameter initialization are not yet verified. |
| Arrow functions | Example-covered: runtime tests exercise lexical `this`, `arguments`, `super`, and `new.target`. | Interaction with all surrounding strict-mode and class contexts remains unverified. |
| Default parameters, rest parameters, and parameter destructuring | Example-covered: runtime tests exercise defaults, rest, and constructor/function patterns. | Separate parameter environments, TDZ between parameters, and all evaluation-order cases remain unverified. |
| Object destructuring | Example-covered: runtime and [complex examples](../src/__tests__/complex-e2e.test.ts) exercise nesting, aliases, defaults, and assignment patterns. | Full computed-key evaluation order and coercion behavior are not established. Object rest belongs to ES2018. |
| Array destructuring | Example-covered for arrays; **known gap** for arbitrary iterables. | Lowering uses indexed reads and slicing; a `Set` or custom iterator is not equivalent to an array. Iterator closing during destructuring is not implemented as the specification requires. |
| Call / array / constructor spread | Example-covered: runtime tests exercise spread in calls, arrays, and `new`. | Iterator consumption, abrupt completion, and all getter/order interactions need broader verification. Object spread belongs to ES2018. |
| `for...of` and iterator closing | Example-covered: runtime tests check closing on `break` and no closing on normal completion. | Known incomplete closing semantics for abrupt-completion edge cases; selected tests do not establish all `return` / `throw` paths. |
| `for...in` | Example-covered for own enumerable properties; **known gap**. | Uses `Object.keys`, so inherited enumerable properties are omitted and specification enumeration behavior is not reproduced. |
| Classes, inheritance, and `super` | Example-covered: runtime tests exercise constructors, `extends`, and `super` method calls. | Class call restrictions, built-in subclassing, property descriptors, and all derived-constructor rules are not established. Fields and private elements belong to ES2022. |
| Generators, `yield`, and `yield*` | Example-covered: runtime tests exercise suspension and delegation. | The full iterator protocol, injected exceptions, and abrupt delegation paths need wider coverage. |
| Object methods, getters, setters, and computed properties | Example-covered: runtime and complex tests exercise representative objects. | Complete descriptor semantics and getter ordering across transformed constructs are not yet verified. |
| Template literals and tagged templates | Example-covered: runtime tests exercise substitutions and tagged raw strings. | Template-object identity, freezing, and all escape cases remain unverified. |
| `if`, loops, labels, `switch`, and exceptions | Example-covered: runtime tests exercise branches, fallthrough, lexical switch bindings, labeled exits, and `try/catch/finally`. | All nested abrupt-completion combinations remain unverified. |
| `new`, `new.target`, `instanceof`, `in`, `delete`, and RegExp literals | Example-covered: runtime tests exercise selected forms. | Exhaustive construction, reflection, and strict-mode behavior are not established. |
| Strict-mode ordinary-function `this` | **Known gap**. | The VM does not consistently preserve the distinction between strict and sloppy calls; a strict bare call cannot be assumed to receive `undefined`. |
| Unresolved identifier reads | **Known gap**. | Looking up an absent host-global property can produce `undefined` where native JavaScript throws `ReferenceError`. This is distinct from the valid `typeof missing` case. |
| `debugger` | Implemented as a no-op; covered by runtime tests. | Does not pause execution in a native debugger. |
| `with` | **Rejected**. | Unsupported by the lowering stage. |

## ES2016 and later

| Edition / feature | Status and evidence | Remaining boundary |
| --- | --- | --- |
| ES2016 exponentiation (`**`, `**=`) | Regression-covered for selected numeric cases in [expression tests](../src/__tests__/expression-semantics.test.ts), including BigInt operations from ES2020. | All coercion and exceptional combinations are not established. |
| ES2017 `async` / `await` | Example-covered: runtime tests exercise awaited results and exceptions. | Promise/microtask ordering and all thenable interactions are not audited. |
| ES2018 async generators and `for await...of` | Example-covered: runtime and complex tests exercise async delegation and async iterator closing on `break`. | Async-from-sync adaptation and all abrupt-closing paths remain unverified. |
| ES2018 object rest/spread | Example-covered: runtime and complex tests exercise object copies and destructuring rest. | Symbol keys, descriptors, and all getter side effects are not established. |
| ES2020 optional chaining and nullish coalescing | Example-covered: runtime tests exercise property access, calls, and nullish fallbacks. | All receiver/evaluation-order combinations and interactions with surrounding expressions require further checks. |
| ES2020 BigInt | Example-covered for literals; expression regressions cover selected updates and exponentiation. | Full operator/coercion coverage is not claimed. Host BigInt support is required. |
| ES2020 dynamic `import()` | Syntax compilation is covered by a runtime test. | Runtime import loading is not validated by that test; resolution is relative to generated output, not original source files. |
| ES2022 public fields and static blocks | Example-covered: runtime tests exercise initialization and declaration order. | All inheritance, field-definition, and descriptor rules remain unverified. |
| ES2022 private fields, methods, and accessors | Example-covered in runtime tests; [private-field regressions](../src/__tests__/private-field-semantics.test.ts) exercise selected compound assignments, updates, and access ordering. | Known gaps remain in repeated receiver evaluation for private-method calls, automatic binding of extracted private methods, nested-class private-name shadowing, and callable private fields. Full inheritance and `super` behavior remain unverified. |

Unlisted ES2016+ syntax and APIs are not part of a general compatibility promise. In particular, the presence of `await` support does not establish top-level-await module semantics.

## Modules and execution hosts

| Boundary | Status and evidence | Constraint |
| --- | --- | --- |
| Local ESM imports/exports and live bindings | [Module regressions](../src/__tests__/module-semantics.test.ts) cover selected mutable exports, imports, and re-export behavior; [module tests](../src/__tests__/modules.test.ts) cover basic bundling. | This is a local bundler and wrapper, not a complete implementation of the ECMAScript module loader. |
| Circular local dependencies | **Rejected** by the bundler's cycle detection. | Native ESM can handle some cycles; this bundler does not implement that initialization model. |
| Destructuring writes to exported bindings | **Rejected**, including destructuring loop targets. | A partially completed write followed by an exception cannot yet synchronize every external binding. Use separate assignments. Destructuring declarations are supported in tested cases. |
| `export *` from an external module | **Rejected**. | List external re-export names explicitly; external dependency resolution remains CommonJS-based. |
| External bare ESM imports | Transformed to host `require()` calls. | Requires compatible CommonJS host resolution; does not provide native ESM-only package loading or browser dependency resolution. |
| Local CommonJS modules | Example-covered by module tests. | Full Node.js resolution, cache, cycles, and CommonJS/ESM interop are not established. |
| IIFE / ESM / CJS output | Existing runtime, module, and CLI tests exercise the wrappers. | These formats do not make the file-based compiler API browser-compatible. A pure source compilation entry point is future work. |
| Host globals and built-ins | The generated interpreter uses the execution host. | It is not a sandbox. Untrusted code requires separate isolation and resource limits. |

## Validation and release gates

`pnpm test` builds with TypeScript and runs Vitest. The [differential helper](../src/__tests__/differential.ts) runs synchronous source and generated code in fresh native VM contexts, captures structured-cloneable results, console observations, and exception names, and applies an execution deadline. It is a targeted regression tool: it does not compare every possible side effect or asynchronous scheduling behavior. Fixtures with uncloneable log values fail the harness rather than count as equivalent program errors. Module tests run separate Node processes with the native ESM loader to avoid Vitest's import transformations changing the reference behavior.

The [CI workflow](../.github/workflows/ci.yml) defines checks on Node.js 20, 22, and 24 with pnpm 11.19.0, a frozen lockfile, and dependency lifecycle scripts disabled. A workflow definition is not evidence of a successful run: use the MR checks for the result on each Node version. Lint is excluded until its dependencies and configuration are supplied.

Before claiming a broader compatibility level:

1. Add native-versus-VM regression cases for each known mismatch, including results, exceptions, and observable evaluation order.
2. Resolve the documented common-language gaps or reject unsupported forms with actionable diagnostics. Today, not all known gaps are detected at compile time.
3. Add selected Test262 suites with their supported feature scope recorded. Test262 has not yet been integrated.
4. Validate representative application code and the installed npm tarball in separate consumers.

The initial reliability milestone fixes specific regressions and records these limits. It does not complete every ES2015 feature, establish production readiness, publish an npm release, or deploy the planned playground.
