# Class evaluation compatibility

Class definitions now execute in a private lexical scope in the current VM frame. This preserves the enclosing `this`, `arguments`, `new.target`, and `super` when evaluating heritage and computed method names, including class definitions inside arrows and suspended generators. Helpers remain private and each class evaluation owns separate captured bindings. Named classes retain their immutable inner binding and its temporal dead zone during heritage and computed-key evaluation.

Explicit and default derived constructors resolve `super()` from the current constructor prototype at call time. Changing `Object.setPrototypeOf(Derived, Replacement)` therefore changes the constructor that runs while preserving `new.target`, instance prototype selection, built-in internal slots, and constructor validation.

Anonymous classes receive inferred names for variable declarations, identifier assignments, binding defaults, and object properties, including computed string and symbol keys. Inference changes the observable `name` property without inventing a lexical self binding. Computed keys are converted once. Names are assigned before static members are evaluated, so a static member named `name` can replace the inferred name.

The focused suite in `src/__tests__/class-lexical-semantics.test.ts` compares native execution with VM execution, covering successful results, exceptions, evaluation order, proxy constructors, closures, and suspension. One explicit specification fixture covers computed-property classes with static `name` methods: current V8 versions overwrite the static method, while ECMAScript [ClassDefinitionEvaluation](https://tc39.es/ecma262/#sec-runtime-semantics-classdefinitionevaluation) assigns the inferred name before evaluating class elements. A production-demo browser test exercises the public compiler and isolated runner.

This change does not claim complete Test262 conformance or expand dynamic import support. Class fields, private elements, and static blocks are newer than ES2015; their existing regression suites are retained, but this change does not certify every later class feature.
