# Static ES module dependency linking

The Node file API automatically resolves and bundles static ES module package
imports and re-exports, including ESM-only packages. Callers do not need Babel,
a separate bundler configuration, or source rewrites:

```js
import { transform } from 'script-vm-next'
const output = transform('./entry.mjs', { format: 'esm' })
```

```js
// entry.mjs
export * from 'an-esm-package'
export { default as example } from 'an-esm-package/examples/example'
```

Package source is compiled into the VM. Resolution never imports or executes a
dependency during compilation. Bundled dependencies preserve binding identities,
live imports and exports, namespace sharing, ambiguous star-export omission,
default exports, and the existing two-phase instantiation of circular ESM graphs.
A bundle containing only inlined ESM dependencies can be moved and run after the
original sources and packages are removed.

## Resolution and module formats

- Node's native resolver chooses `node`/`import`/`default` conditions, conditional
  object order, export patterns and arrays, package `imports`, package self
  references, package boundaries, and canonical symlink identities. `require`
  conditions are not used to resolve static imports.
- `.mjs` and `type: module` JavaScript dependencies are compiled. Ambiguous `.js`
  files without an explicit package type use syntax detection; this also keeps
  the file API's existing support for local JavaScript ESM sources on Node 20.
- Local relative imports retain extension and directory-index conveniences.
  Package `exports` and `imports` targets must resolve as Node specifies and do
  not receive that fallback.
- `.cjs`, `type: commonjs`, builtins, and dependencies selected with `external`
  remain host dependencies. ESM output contains native static imports, preserving
  Node's CommonJS default export, named-export snapshots, and namespace behavior.
  Missing host exports produce native link-time errors. Direct and indirect
  re-exports of host ESM bindings use native forwarding, so subsequent writes
  remain visible through the public generated module.

The synchronous file API uses a bounded Node subprocess to resolve each module's
unique import specifiers in one batch. A source file is visited once per bundle;
modules with no static dependencies require no subprocess. The resolver has a
10-second timeout and a 4 MiB output limit. It runs no user loaders or preloads,
does not inherit `NODE_OPTIONS`, and adds no package dependency. Custom Node
loader hooks, custom CLI condition flags, and browser-specific resolution are
outside this Node resolver's scope. Browser `compileSource` remains filesystem
and subprocess free.

## Explicit boundaries

- Dynamic `import()` and a multiple-file browser Demo are not changed here.
- JSON, native addons, WebAssembly, import attributes, non-file URL loaders, and
  query/fragment module identities receive compilation diagnostics rather than
  being parsed as ordinary JavaScript or merged into another module identity.
- `export *` requires analyzable inlined ESM source. Star exports from CommonJS,
  builtins, or dependencies explicitly marked `external` remain rejected; their
  export sets cannot be obtained by executing dependencies during compilation.
  Named re-exports and namespace imports are available for host dependencies.
- Host dependencies use canonical absolute file URLs (builtins use `node:`).
  This preserves nested package versions and source-relative resolution. They
  must remain at those paths when the result runs; recompile after relocating
  that dependency installation. Inlined ESM has no such path requirement.
- Native external modules execute before the generated VM module. The compiler
  checks source dependency order and rejects a host dependency first encountered
  after an inlined module would already have evaluated, rather than silently
  moving its side effects. Repeated dependencies and builtins are allowed; host
  imports retain their first-encounter source order even in inlined cycles.
  The check is conservative and does not assume any module body is side-effect
  free. Keep ESM dependencies in the default inlined graph for interleaved
  evaluation. Dependencies of host modules are opaque; cycles that cross back
  from a host dependency into VM source are outside this graph's guarantee.
- This change does not claim full module-namespace exotic-object conformance or
  full ES2015 conformance. It extends the existing VM module implementation.

## Automated checks

`src/__tests__/static-package-modules.test.ts` compares generated modules with
Node's native loader in fresh processes. It covers conditional package exports,
subpaths, imports and self references, patterns and array fallback, shared and
cyclic bindings, ambiguous exports, symlinks, package scopes, CommonJS interop,
explicit external ESM live forwarding, missing exports, relocation, and loader
diagnostics. `pnpm test:package` also compiles an ESM-only package through the
installed production tarball and runs the output after removing that package.
