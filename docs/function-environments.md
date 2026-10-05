# Function environments and arguments compatibility

The compiler now keeps named function-expression bindings in their own immutable
lexical environment. Recursion survives reassignment of the outer variable;
parameters and body declarations can shadow the private name. Sloppy writes to a
private function name are ignored and strict writes throw `TypeError`. Anonymous
functions, arrows, generators and classes receive inferred names from variable
initializers, identifier assignments, defaults and static object properties.
Inferred names do not introduce a private lexical binding. Computed property
names are handled by the object compatibility work.

Block function declarations are initialized when the block is entered and close
over that block's lexical environment. This includes loops, switch cases,
try/catch/finally and labeled declarations. Strict block functions remain local.
Sloppy Annex B declarations also copy their value to an eligible enclosing var
binding when the declaration statement is reached; skipped branches do not copy.
Parameter and lexical conflicts suppress that extra var binding. Generator and
async block declarations remain lexical.

Each ordinary function has a mutable implicit `arguments` binding unless an
explicit declaration replaces it. Arrows resolve the live enclosing binding.
Strict functions and functions with default, destructured or rest parameters use
a native unmapped Arguments object. Sloppy simple-parameter functions use a
private parameter map which handles duplicate formals, missing arguments, index
writes, deletion, descriptor changes, sealing/freezing and escaped closures.
The map disconnects when an index is deleted, becomes an accessor, or becomes
non-writable. Callee access, property flags, iteration and reflection are covered
by native-versus-VM differential tests.

## Reflection boundary

Mapped arguments are implemented using a Proxy so that parameter aliasing also
works when the generated artifact executes in an ES module. No user function
body is executed natively, no `eval`/`Function` constructor is used, and no host
prototype is patched. A Proxy has no native Arguments internal tag, so the
runtime supplies a virtual `Symbol.toStringTag` value. Consequently:

- `Object.prototype.toString.call(arguments)` returns `[object Arguments]`;
- own keys and property descriptors do not expose an added tag property;
- reading `arguments[Symbol.toStringTag]` on a mapped object with no explicit tag
  returns `'Arguments'`, while native mapped arguments return `undefined`;
- non-string explicit tag overrides can reveal the Proxy's ordinary-object tag.

This is an explicit remaining reflection difference, not a claim of complete
Arguments exotic-object conformance. Strict/non-simple native unmapped arguments
do not have this difference.

## Verification

`function-environment-semantics.test.ts` and `arguments-semantics.test.ts` compare
behavior with fresh native JavaScript realms, including mutation and abrupt-error
cases. Argument fixtures also execute generated scripts as native ES modules and
compare native ESM source behavior. The browser E2E fixture compiles and executes
recursion, block scope, argument descriptors and inferred names using the actual
Demo worker and runner. Existing module, class, parameter, iterator and runtime
suites remain part of the regression gate.

The suite establishes the covered behaviors; it is not a complete Test262 report.
Dynamic import and direct `eval` compatibility are outside this change.
