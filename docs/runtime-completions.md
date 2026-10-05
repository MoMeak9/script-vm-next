# Runtime property mutations and generator completions

The compiler handles these semantics internally. Callers do not need source
rewrites, Babel configuration, or native execution of user functions.

## Property operations

Each property write, property delete, global write, and lexical-slot write carries
its source strictness in bytecode. This matters when a strict region is nested in
otherwise sloppy code, and when a compiled script is wrapped in an ESM artifact.
The generated runtime's own strictness no longer determines user property writes.

Property writes preserve the original receiver for inherited accessors and Proxy
traps, including primitive receivers. Failed writes and deletes throw `TypeError`
in strict code and preserve their normal sloppy-mode result otherwise. Nullish
bases, getter-only properties, nonextensible objects, nonconfigurable properties,
Proxy invariants, assignment results, and evaluation order follow host object
operations. Internal Reflect helpers are captured before user code executes.

## Generator resumption

A native generator wrapper retains the public generator brand and protocol. Its
private driver converts `next`, `throw`, and `return` requests into completion
records before resuming the interpreter. Bytecode control flow then handles them
in the same way as explicit return and throw statements.

This allows an interpreted `finally` block to replace an external return or throw
with `break`, `continue`, a different return, or a new exception. Pending
completions survive a yielding finalizer, nested finalizers run in order, and
iterator cleanup executes when control leaves a `for...of` loop.

Delegated yields use a private protocol adapter that forwards unfinished iterator
results unchanged, without eagerly reading their value. Native `yield*` validates
results; the adapter translates completion records into iterator methods and
performs missing-throw cleanup. All user statements and surrounding completion
handling remain inside the VM. Async wrappers retain native request queuing,
promise handling, and async-from-sync delegation.

Known limitation: the existing layered generator interpreter can read an
unfinished delegated result's `done` getter more than once while forwarding it.
Accessor side effects that depend on the exact read count remain a conformance
gap; ordinary data-property iterator results are unaffected.

## Labels

Normalization preserves every contiguous label on an ES2015 iteration statement.
Lowering attaches the complete label set to the destination loop, rather than
using a single mutable pending label. Labeled arbitrary statements support
labeled breaks while an unlabeled break still selects its nearest loop or switch.

## Regression coverage

- `src/__tests__/strict-property-semantics.test.ts`: strict/sloppy mutations,
  receivers, primitives, Proxy behavior, operation ordering, and actual Node
  IIFE/CJS/ESM execution across ordinary, async, generator, and async-generator
  functions.
- `src/__tests__/completion-semantics.test.ts`: native/VM differential fixtures
  for external completions, nested and yielding finalizers, delegation protocol
  errors, generator brands, queued async requests, iterator closing, and labels.
- `demo/e2e/runtime-semantics.spec.ts`: compilation in the browser worker and
  execution in the demo runner under the GitHub Pages subpath.

These are focused conformance regressions, not a claim of complete ECMAScript
conformance. Dynamic imports and the separate post-ES2015 `for await...of`
normalization path are outside this change.
