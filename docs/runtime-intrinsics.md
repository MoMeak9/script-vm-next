# Stable intrinsics for compiler-generated operations

Replacing a public helper such as `Reflect.apply` or `Object.defineProperty`
should affect explicit calls to that helper. It should not change the meaning of
an ordinary function call, `new`, a function declaration, or class construction.
The VM captures the host operations needed by its implementation before running
user code.

The captured operations cover:

- Function calls and construction in ordinary, async, generator, and async
  generator execution.
- Function metadata and generator prototype initialization.
- Original ReferenceError and TypeError constructors for TDZ and const writes.
- Interpreter array allocation, argument-list construction, and parameter copies.
- Implicit global writes and module notification proxy global lookup.
- Internal completion-record tracking used by the existing generator runtime.

Compiler-generated class helpers resolve reserved Object and Reflect namespaces.
These private namespaces contain snapshots of the original own descriptors;
Object retains native call and construction behavior through a bound constructor.
User-written Object and Reflect references continue resolving to the real public
bindings, including replacements made by user code. The VM does not patch or
restore host globals on the caller's behalf.

`src/__tests__/intrinsic-semantics.test.ts` compares native and VM executions after
replacing individual methods and global bindings. Fixtures restore their own
changes in `finally`, cover all four execution loops, and execute actual IIFE,
CommonJS, and ESM artifacts in separate Node processes. Explicit calls to replaced
public methods are checked too, so captured internal operations cannot silently
hide user-visible replacements.

This is a bounded correction for the compiler's demonstrated dependency on public
helper methods. It does not claim support for every possible mutation of built-in
prototypes, private-field implementation details, or host globals before VM
initialization. It does not add syntax polyfills or execute source natively.
