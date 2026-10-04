# Enhanced object literal compatibility

Object literals are normalized inside the compiler. Callers can use the source API,
Node file API, CLI and browser playground without a separate transpilation step.
User method bodies still execute as VM bytecode.

The object-literal path supports:

- Own data-property creation, property descriptors, duplicate properties and
  getter/setter merging without invoking inherited setters.
- Computed string and symbol keys, including `ToPropertyKey` before data-value
  evaluation, and keys containing `this`, `arguments`, `new.target` or `yield`.
- Prototype initializers (`__proto__: value`) separately from computed, shorthand
  and method properties named `__proto__`.
- Nonconstructable concise methods and accessors, their names and parameter
  lengths, and anonymous function/arrow names in data properties.
- Method `super` reads, calls, tagged templates, assignment, compound assignment,
  updates and deletion errors, including use from nested arrows and parameter
  defaults. Each method retains its original home object when detached or copied;
  changing that object's prototype affects subsequent calls.
- The existing object-spread extension with own enumerable string/symbol copying,
  source getters and proxy descriptor ordering, and no inherited target setters.

Compiler-only operations use reserved intrinsic names and captured host operations.
Source bindings named `Object` or `Reflect`, and later replacement of their methods,
do not change literal creation or `super` behavior.

## Reference semantics and test oracles

The focused regression file is `src/__tests__/object-semantics.test.ts`. Ordinary
cases compare results, side effects and exception names against native execution
in fresh realms. A production browser regression in
`demo/e2e/object-semantics.spec.ts` exercises the compiler worker and runner.

For computed `super` references the implementation follows **ECMA-262 2025**:

1. [SuperProperty evaluation and MakeSuperPropertyReference](https://262.ecma-international.org/16.0/#sec-super-keyword-runtime-semantics-evaluation)
   capture the base and the unconverted key.
2. [GetValue](https://262.ecma-international.org/16.0/#sec-getvalue) and
   [PutValue](https://262.ecma-international.org/16.0/#sec-putvalue) validate the
   base, then convert and cache the key. Simple assignment therefore converts its
   key after the right-hand side; a compound assignment reuses the converted key.

Node 20.20.2 and 24.19.0 still differ from those algorithms in some combinations:
compound updates can coerce keys twice, and key/RHS side effects can affect which
prototype native execution subsequently uses. These cases have explicit
specification-derived assertions, with the source algorithms cited in the tests.
This is a deliberate modern-specification target: early ES2015-era algorithms
used different coercion ordering.

This focused coverage is not a claim of full ECMAScript conformance. General
function `arguments`, direct `eval`, class-name inference, module linking and
other VM subsystems have their own implementations and compatibility limits.
