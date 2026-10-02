# script-vm-next

A register-based JavaScript virtualization compiler. It converts source into bytecode and a self-contained JavaScript interpreter, with Node.js APIs, a CLI, and a browser playground.

This project implements a **tested subset of JavaScript**. The current release target is **`0.2.0-beta.1`**; complete ES2015/ES6 conformance and general production readiness are not claimed. Read the [compatibility matrix](docs/compatibility.md) before adopting it for application code.

## Try the playground

The GitHub Pages deployment is configured for [momeak9.github.io/script-vm-next](https://momeak9.github.io/script-vm-next/). Its first successful deployment enables that URL. Edit a standalone script, compile it, inspect the generated code and statistics, and run it with bounded console output and a stop button.

The playground accepts single-file JavaScript and emits an IIFE. It does not provide a DOM, local modules, `require`, or dynamic `import()`. Compilation runs locally in a browser worker. Execution uses a separate worker inside an opaque-origin sandbox iframe with a network-denying policy. Downloaded output uses the globals of its execution host: **the compiler's generated code is not itself a security sandbox**.

See [playground usage and deployment](docs/playground.md) for the execution model and GitHub Pages setup.

## Installation

Registry publication is a separate maintainer action. This repository's release workflow requires an approved license and npm publishing access; this README does not establish that a version has been published. Once the `beta` dist-tag is available:

```sh
npm install script-vm-next@beta
```

The installed Node.js package requires Node.js 20 or newer. Repository development tools have stricter minimum versions, listed below. Browser applications should import `script-vm-next/core` through a bundler.

Before registry publication, build and verify a local package:

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
pnpm build
pnpm test:package
```

The package check installs the real tarball in a fresh consumer, checks CommonJS, named ESM imports, strict TypeScript consumers, both API entry points, and the installed CLI. It saves the verified archive under `artifacts/`; install it in another project with `npm install /absolute/path/to/script-vm-next/artifacts/script-vm-next-0.2.0-beta.1.tgz`.

## Source API: Node.js and browser bundlers

```ts
import { compileSource, CompileError } from 'script-vm-next/core'

try {
  const result = compileSource('console.log(6 * 7)', {
    filename: 'example.js',
    format: 'iife',
  })

  console.log(result.code)
  console.log(result.artifact.bytecode.length)
  console.log(result.artifact.functions.length)
} catch (error) {
  if (error instanceof CompileError) {
    console.error(error.code, error.filename, error.line, error.column, error.message)
  } else {
    throw error
  }
}
```

`compileSource(source, options?)` is synchronous. It reads no files, writes no files, and does not execute the input. It accepts a standalone script, rejects module syntax and unbound CommonJS globals, and returns `{ code, artifact }`. `filename` labels diagnostics; it does not resolve a file. `debug: true` includes instruction debug information. Locations, when available, use one-based lines and columns.

CommonJS consumers can use `const { compileSource } = require('script-vm-next/core')`. Type declarations are included. The root package also re-exports `compileSource`, but browser bundlers should use the dedicated `core` entry to avoid Node filesystem dependencies.

## File API: Node.js

```ts
import { compile, transform } from 'script-vm-next'

// Read the entry file, bundle supported local modules, and write an output file.
const result = compile('./input.js', './output.vm.js', { format: 'iife' })

// Read and compile a file without writing output.
const inMemory = compile('./input.js', null, { format: 'iife' })
const code = transform('./input.js', { format: 'iife' })
```

`compile(inputPath, outputPath?, options?)` and `transform(inputPath, options?)` retain their file-based signatures. `transform` returns the generated string; `compile` returns the same `{ code, artifact }` shape as the source API. Omitting `outputPath` writes a sibling `.vm.js`, `.vm.mjs`, or `.vm.cjs` file according to the resolved format; passing `null` suppresses writing.

The file API supports `format: 'auto' | 'iife' | 'esm' | 'cjs'`, `bundle` (default `true`), `external: string[]`, and `debug`. Automatic format detection considers filename extensions and module syntax. Local module bundling has explicit limits, including rejected circular dependencies; external imports require host CommonJS resolution. The reserved `obfuscate` option is not implemented and is rejected.

## CLI

After installation:

```sh
npx script-vm-next input.js --output output.vm.js --format iife
node output.vm.js
npx script-vm-next --help
```

The `transform` subcommand is also accepted. Options include `--format auto|iife|esm|cjs`, `--no-bundle`, `--external module-a,module-b`, and `--debug`. Compilation failures return a nonzero status with a diagnostic code and a source location when available.

## Language boundaries

Tests cover selected cases of closures, lexical bindings, functions and arrows, destructuring, iterators, classes, generators, async functions, and module wrappers. These are scoped claims, not a checklist of fully implemented language editions. Known limits include strict/sloppy `this` distinctions, unresolved identifier reads, array destructuring of arbitrary iterables, inherited `for...in` properties, and several private-element cases. Consult the [compatibility matrix](docs/compatibility.md) for the current detail.

Compare representative application code with native JavaScript before use. Code that parses successfully can still hit an unverified semantic boundary. Generated programs use host built-ins such as `Promise`, `Map`, and `Symbol`; this package does not supply a polyfill layer.

## Development and validation

Use pnpm **10.34.6** with Node.js **20.19+**, **22.13+**, or **24** to meet the development tools' requirements:

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
pnpm build
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:package
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm test` builds and runs the compiler suite. Use `pnpm test:unit` after an existing build to avoid rebuilding it. `pnpm test:e2e` builds the playground, starts its preview server, and tests it in Chromium. Linux hosts may need `pnpm exec playwright install --with-deps chromium` to install browser system libraries.

To develop the playground:

```sh
pnpm demo:dev
```

To inspect a production build:

```sh
pnpm demo:build
pnpm demo:preview
```

The [CI workflow](.github/workflows/ci.yml) tests the compiler on Node.js 20, 22, and 24. Node.js 24 additionally runs lint, type checks, independent package consumers, and browser checks. Pages and npm release workflows require these same gates and deploy the artifacts produced by that validation run. See the [release guide](docs/releasing.md) for the remaining maintainer configuration and release process.

## Architecture and next work

Source → optional Node module bundling → Babel parsing and normalization → register-based IR → bytecode → runtime generation → output wrapping.

Read the [architecture guide](docs/01-architecture-overview.md), [tutorials](docs/00-tutorial-guide.md), and [compatibility matrix](docs/compatibility.md). Further compatibility work should add native-versus-VM regressions, resolve documented semantic gaps, integrate selected Test262 cases, and validate real application inputs. A stable release requires evidence for its declared language scope; packaging and a playground alone do not establish language conformance.

## License

The package is currently marked `UNLICENSED` pending the copyright holder's license decision. The release workflow blocks npm publication until a license is selected and a `LICENSE` file is included.
