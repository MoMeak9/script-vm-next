# script-vm-next

`script-vm-next` is a register-based JavaScript virtualization prototype that emits pure JavaScript output.

## Current Scope

- Pure JS self-contained runtime output
- Register-based bytecode with per-function register frames
- Lexical slot environments for closures
- IIFE / ESM / CJS output wrapping
- Local ESM / CJS module bundling before compilation
- CLI, `compile()`, and `transform()` entry points

## Language Compatibility

The project implements a **tested subset of JavaScript**, with known semantic gaps. Parsing or compiling a construct successfully does not guarantee that every variant behaves like native JavaScript. It does not yet claim complete ES2015 (ES6) or later ECMAScript conformance, or general production readiness.

Existing tests cover examples of lexical bindings and closures, functions and arrows, expressions, control flow, destructuring, spread/rest, classes, generators, async functions, and module wrappers. These features are partially implemented; their coverage and remaining boundaries are listed in the [compatibility matrix](docs/compatibility.md).

Before adopting the compiler, check that matrix and compare representative application code with native execution. In particular:

- Strict-mode `this` and unresolved identifier reads have known semantic gaps.
- Array destructuring does not implement the full iterable protocol.
- `for...in` enumerates own keys only; iterator closing has incomplete edge-case coverage.
- Circular local module dependencies are rejected. External imports require a compatible host `require`.
- Dynamic `import()` is resolved relative to the generated output.

Generated code uses host globals. Virtualization does not provide a security sandbox for untrusted code.

## Development and Validation

Use Node.js 20 or newer and pnpm 10.34.6 (pnpm 11 requires Node.js 22.13 or newer):

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry https://registry.npmjs.org
pnpm test
```

`pnpm test` runs the TypeScript build followed by Vitest. Tests include native-versus-VM regression checks for expression evaluation, private-field operations, module bindings, and constant preservation. The [CI workflow](.github/workflows/ci.yml) runs the build and tests on Node.js 20, 22, and 24. The existing lint script is not a release gate yet: the repository still needs ESLint dependencies and configuration.

## Architecture

1. Parse and normalize source with Babel
2. Lower AST into a simple non-SSA IR
3. Emit compact numeric bytecode plus function metadata
4. Generate a JavaScript runtime interpreter
5. Pack runtime + metadata into the final JS artifact

See the [architecture guide](docs/01-architecture-overview.md) and [tutorials](docs/00-tutorial-guide.md) for implementation details.

## Roadmap

1. Grow the native-versus-VM regression suite, resolve known semantic mismatches, and verify common ES2015 capabilities against their edge cases.
2. Expand ES2016+ coverage according to application needs. Add relevant Test262 cases; no Test262 conformance claim is made today.
3. Provide a browser-compatible source compilation entry point and validate the published npm tarball in independent consumers.
4. Add an isolated browser playground and a GitHub Pages deployment workflow.
5. Add automated npm release tooling after package and compatibility gates are in place.

The npm packaging work, browser playground, Pages deployment, and release workflow are subsequent milestones. The current semantic-reliability work does not publish a package or deploy a site. The previously planned obfuscation pipeline remains deferred.
