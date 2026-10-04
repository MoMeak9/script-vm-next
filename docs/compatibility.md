# JavaScript compatibility

This document records the compiler's current test coverage and known limitations. **ES6 means ES2015**; async functions, optional chaining, and private fields belong to later editions. A feature's presence in Babel's parser or in the compiler is not proof of runtime conformance.

## Reading the matrix

- **Regression-covered**: focused tests compare selected native and VM observations, or check a specific representation invariant. The claim applies to those cases only.
- **Example-covered**: existing tests exercise representative cases. Full semantics and edge cases have not been established.
- **Known gap**: a supported-looking input can behave differently from native JavaScript. Check the limitation before using that feature.
- **Rejected**: the compiler reports an error for the identified case.

These categories can overlap: a feature can have useful test coverage and still have a known gap. No row implies full standards conformance. Untested combinations remain unverified. Standard-library objects such as `Map`, `Set`, `Promise`, and `Symbol` are provided by the execution host, not by a compiler polyfill layer.

## Automatic compatibility handling

Pass ordinary JavaScript to the existing API or CLI. The compiler lowers supported constructs and embeds its runtime helpers automatically; consumers do not need to rewrite source, configure Babel, or add a transpilation build step. Helpers use private bindings so user variables named `Object`, `Array`, or compiler-like temporary names do not replace them. This preserves the tested behavior while keeping user program bodies in the VM; it does not fall back to executing original source with `eval`.

Unsupported dependency-linking cases still produce a compiler error. Host built-ins remain a runtime requirement, and uncovered semantics are not a promise of compatibility. The known limits below belong to this library's implementation backlog.

## ES2015 and earlier

| Feature / semantic boundary | Status and evidence | Remaining boundary |
| --- | --- | --- |
| Numeric literals and constant serialization | Regression-covered: [constant tests](../src/__tests__/constant-semantics.test.ts) cover non-finite numbers, negative zero, and preservation of primitive constants. | Representation checks do not establish all arithmetic semantics. |
| Calls, property access, compound assignment, and updates | Regression-covered: [expression tests](../src/__tests__/expression-semantics.test.ts) compare selected evaluation-order and numeric-conversion cases. | Uncovered operator combinations and exotic object coercions remain unverified. |
| `var`, functions, and closures | Example-covered by runtime tests; parameter regressions cover closures across separate parameter/body environments. | Complete declaration instantiation is not implemented. Named function expressions do not yet provide a fully correct self-name binding; block function declarations, including declarations inside `try`, remain a boundary. |
| `let` / `const`, TDZ, and block scope | Example-covered: runtime tests exercise shadowing, TDZ reads, const reassignment, per-iteration capture, and fresh catch bindings. | All declaration forms, nested scopes, and interactions with parameter initialization are not yet verified. |
| Arrow functions | Example-covered: runtime tests exercise lexical `this`, `arguments`, `super`, and `new.target`. | Interaction with all surrounding strict-mode and class contexts remains unverified. |
| Default parameters, rest parameters, and parameter destructuring | [Parameter regressions](../src/__tests__/parameter-semantics.test.ts) cover left-to-right initialization, parameter TDZ, body/default closure isolation, rest, length/name metadata, async parameters, and eager generator parameter initialization. | Full function reflection, named-function self bindings and direct `eval` interactions are not covered by this guarantee. |
| Object destructuring | [Iterator regressions](../src/__tests__/iterator-semantics.test.ts) cover object coercion, computed keys and defaults; nested declaration and assignment patterns use the same internal lowering. | Not every proxy/getter combination has been tested. Object rest is ES2018 and has additional computed/symbol-key cases in this suite. |
| Array destructuring | Iterator regressions cover `Set`, strings, custom iterators, generators, holes, rest, nested patterns, lazy stepping, TDZ, assignment return values, and closing on normal/abrupt completion. | The coverage is focused rather than exhaustive. Arbitrary combinations of nested control flow and host iterator side effects still require broader conformance testing. |
| Call / array / constructor spread | Iterator and expression regressions cover iterable consumption, rejection of noniterable array-like inputs, shadowed globals, argument/receiver order, and independence from `Symbol.isConcatSpreadable`. | Broader proxy/coercion and abrupt-completion combinations remain unverified. Object spread belongs to ES2018. |
| `for...of` and iterator closing | Iterator and [runtime regressions](../src/__tests__/runtime-semantics.test.ts) cover per-iteration bindings, `break`, `continue`, labeled exits, return/throw cleanup, finally completion, and generator cancellation. | Focused cases do not establish every nested label, exception and generator protocol combination. |
| `for...in` | Iterator regressions cover inherited enumerable keys, nonenumerable shadowing, and deletion during enumeration using an internal host iterator. | Host enumeration follows the execution engine; unusual proxy/prototype mutation combinations remain unverified. |
| Classes, inheritance, and `super` | [Class regressions](../src/__tests__/class-semantics.test.ts) cover call restrictions, nonenumerable/nonconstructable methods, accessors, static inheritance, receiver-preserving `super`, derived `this`/return rules, class TDZ, and selected `Array`/`Map`/`Error` subclasses. | `super()` still captures the original superclass when the constructor prototype is changed dynamically. Complete anonymous-class name inference and exotic nested class/computed-key contexts remain incomplete. Fields and private elements belong to ES2022. |
| Generators, `yield`, and `yield*` | Runtime examples plus regressions cover eager parameter initialization, suspension, cancellation cleanup, `return()` through yielding finally blocks, and selected delegation behavior. | External `return()` overridden by `break`/`continue` inside `finally` is still incomplete. Full injected-exception/delegation protocol coverage and cross-generator combinations remain unverified. |
| Object methods, getters, setters, and computed properties | Example-covered: runtime and complex tests exercise representative objects. | Complete descriptor semantics and getter ordering across transformed constructs are not yet verified. |
| Template literals and tagged templates | [Template regressions](../src/__tests__/template-semantics.test.ts) cover string-hint substitution coercion, Symbol rejection, per-site object identity, frozen cooked/raw arrays and descriptors, invalid tagged escapes, receiver/order, and shadowed globals. | This is targeted ES2015 coverage; all parser escape cases and cross-realm behavior have not been audited. |
| `if`, loops, labels, `switch`, and exceptions | Example-covered: runtime tests exercise branches, fallthrough, lexical switch bindings, labeled exits, and `try/catch/finally`. | All nested abrupt-completion combinations remain unverified. |
| `new`, `new.target`, `instanceof`, `in`, `delete`, and RegExp literals | Example-covered: runtime tests exercise selected forms. | Exhaustive construction, reflection, and strict-mode behavior are not established. |
| Strict-mode ordinary-function `this` | Runtime regressions cover undefined/null/primitive receivers, strict preservation, sloppy boxing/global substitution, and module strictness. | Full function and `arguments` reflection is a separate remaining boundary. |
| Unresolved identifier reads | Runtime regressions cover `ReferenceError` on absent bindings, valid `typeof missing`, lexical TDZ under `typeof`, and strict versus sloppy global writes. | Complete host-global/environment semantics, including direct `eval`, are not implemented. |
| `arguments` reflection and parameter aliasing | **Known gap**. Basic indexed reads and rest behavior are covered; non-simple parameters remain unmapped. | The VM does not implement the complete native Arguments object, including `callee`, reflection, and sloppy simple-parameter aliasing. |
| Strict-mode property mutation | **Known gap**. | Writes to nonwritable properties do not yet consistently throw the strict-mode `TypeError`. Strict global writes are separately covered by the runtime regression suite. |
| Direct `eval` | **Known gap**. | Host evaluation does not have access to VM lexical slots. Dynamic source execution is not a compatibility fallback. |
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
| Circular local ESM dependencies | [Module compatibility regressions](../src/__tests__/module-compatibility.test.ts) cover two-phase instantiation, hoisted function exports, lexical TDZ, `var`, live namespaces, cycle-safe star resolution, and depth-first single evaluation. | Applies to bundled local ESM. CommonJS cycles remain rejected; mixed external/native-loader cycles are not supported. |
| Destructuring writes to exported bindings | Module regressions cover declarations, assignment expressions, loop targets, callbacks observing intermediate updates, and partially completed writes before exceptions. | Generated setter references notify each binding update internally; callers do not need to split assignments. Wider nested/proxy combinations remain unverified. |
| `export *` from an external module | **Rejected** with a dependency-linking diagnostic. | Arbitrary external export-name discovery and native ESM dependency linking are not yet implemented. The library does not silently invent a namespace or execute dependencies during compilation. |
| External bare ESM imports | Transformed to host `require()` calls. | Requires compatible CommonJS host resolution; does not provide native ESM-only package loading or browser dependency resolution. |
| Local CommonJS modules | Example-covered by module tests. | Full Node.js resolution/cache/interoperability is not established; CommonJS cycles remain explicitly rejected. |
| IIFE / ESM / CJS output | Existing runtime, module, and CLI tests exercise the wrappers. | All three formats belong to the Node file API. The source API and playground accept standalone scripts and emit IIFEs only. |
| `compileSource` and browser compilation | The `script-vm-next/core` entry compiles source text without filesystem access or input execution. Package consumers and the browser playground exercise the entry point. | Static imports/exports, dynamic `import()`, `import.meta`, and unbound CommonJS globals are rejected. Browser bundlers should use the `core` entry rather than the Node root entry. |
| Browser playground execution | Generated IIFEs run in a separate worker inside an opaque-origin sandbox iframe, with a network-denying policy, bounded output, and stop/timeout behavior. | No DOM, module loader, or persistent application runtime is supplied. These runner controls are separate from the generated program and do not travel with downloaded code. |
| Host globals and built-ins | The generated interpreter uses the execution host. | It is not a sandbox. Untrusted code requires separate isolation and resource limits. |

## Validation and release gates

`pnpm test` builds the library and runs Vitest; `pnpm test:unit` reuses an existing build. The [differential helper](../src/__tests__/differential.ts) runs synchronous source and generated code in fresh native VM contexts, captures structured-cloneable results, console observations, and exception names, and applies an execution deadline. It is a targeted regression tool: it does not compare every possible side effect or asynchronous scheduling behavior. Fixtures with uncloneable log values fail the harness rather than count as equivalent program errors. Module tests run separate Node processes with the native ESM loader to avoid Vitest's import transformations changing the reference behavior.

An older host engine is not always a correct oracle. Node 20.20.2's native derived constructor checks `this` too early for `try { return; } finally { super(); }`; Node 22/24 and the specification complete `finally` first. That regression asserts the specification result for compiled code on every supported Node version, without skipping VM execution.

The [CI workflow](../.github/workflows/ci.yml) defines compiler checks on Node.js 20, 22, and 24 with pnpm 10.34.6, a frozen lockfile, and dependency lifecycle scripts disabled. Node.js 24 also runs lint, type checks, independent tarball-consumer tests, and Chromium playground tests. The shared validation workflow gates both Pages deployment and npm release. Development uses Node.js 20.19+, 22.13+, or 24 to meet the build and lint tools' requirements. A workflow definition is not evidence of a successful run: use the MR checks for the result on each Node version.

Before claiming a broader compatibility level:

1. Add native-versus-VM regression cases for each known mismatch, including results, exceptions, and observable evaluation order.
2. Resolve the documented common-language gaps or reject unsupported forms with actionable diagnostics. Today, not all known gaps are detected at compile time.
3. Expand the [pinned Test262 baseline](test262.md), which currently runs 219 selected ES2015 files / 428 execution variants on Node.js 20, 22, and 24. The documented scope excludes known pending semantic gaps and is not the complete upstream suite. Every selected case must pass without skips.
4. Validate representative application code and the installed npm tarball in separate consumers.

The reliability work fixes specific regressions and records these limits. Packaging, the source API, and the playground make the compiler easier to consume and inspect; they do not complete every ES2015 feature or establish general production readiness. Registry publication and Pages availability must be verified through their separate release/deployment results. See the [release guide](releasing.md) and [playground guide](playground.md).
