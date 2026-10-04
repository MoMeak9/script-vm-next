import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'))
const temporary = await mkdtemp(path.join(tmpdir(), 'script-vm-package-'))
const consumer = path.join(temporary, 'consumer')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const commandEnvironment = {
  ...process.env,
  // Consumer imports must resolve through its installation, never a global path.
  NODE_PATH: '',
  npm_config_cache: path.join(temporary, 'npm-cache'),
  npm_config_update_notifier: 'false',
}

function run(command, args, { cwd = consumer, timeout = 180_000, expectedCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: commandEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeout)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`Cannot start ${command}: ${error.message}`, { cause: error }))
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut || code !== expectedCode) {
        reject(new Error([
          `${command} ${args.join(' ')} ${timedOut ? 'timed out' : `exited with ${code}${signal ? ` (${signal})` : ''}`}`,
          `Working directory: ${cwd}`,
          stdout.trim(),
          stderr.trim(),
        ].filter(Boolean).join('\n')))
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

try {
  await mkdir(consumer)
  console.log('[package] Packing the built release with lifecycle scripts disabled.')
  const packed = await run(npm, [
    'pack', '--ignore-scripts', '--json', '--pack-destination', temporary,
  ], { cwd: repository })
  const [tarball] = JSON.parse(packed.stdout)
  assert.equal(tarball.name, manifest.name)
  assert.equal(tarball.version, manifest.version)
  assert.ok(tarball.files.some(({ path: name }) => name === 'package.json'))
  assert.ok(tarball.files.some(({ path: name }) => name === manifest.bin['script-vm-next']))
  for (const { path: name } of tarball.files) {
    assert.doesNotMatch(name, /(?:^|\/)(?:__tests__|tests?|fixtures|demo|\.github|node_modules)(?:\/|$)/,
      `Development files must not ship: ${name}`)
    assert.doesNotMatch(name, /\.(?:test|spec)\.[cm]?[jt]sx?(?:\.map)?$/,
      `Test files must not ship: ${name}`)
  }
  const tarballPath = path.join(temporary, tarball.filename)
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({
    name: 'script-vm-package-consumer', private: true, version: '1.0.0',
  }, null, 2))
  console.log('[package] Installing the actual tarball in an isolated production consumer.')
  await run(npm, [
    'install', tarballPath, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org',
  ])

  const source = [
    'globalThis.__packageResult = 6 * 7;',
    'const [first, ...rest] = new Set([1, 2, 3]);',
    'var outer = 1; function parameter(read = () => outer) { var outer = 9; return read(); }',
    'class Base { static value() { return 7; } } class Derived extends Base {}',
    'function tag(strings) { return strings; } function template() { return tag`shared`; }',
    'const strings = template();',
    'globalThis.__compatibilityChecks = [first, rest, parameter(), Derived.value(),',
    '  strings === template(), Object.isFrozen(strings), Object.isFrozen(strings.raw)];',
  ].join('\n')
  await writeFile(path.join(consumer, 'input.js'), source)
  const smokeAssertions = `
    const source = ${JSON.stringify(source)};
    for (const [name, api] of [['root', root], ['core', core]]) {
      assert.equal(typeof api.compileSource, 'function', name + ' compileSource');
      assert.equal(typeof api.CompileError, 'function', name + ' CompileError');
      const output = api.compileSource(source, { format: 'iife', filename: 'consumer.js' });
      assert.equal(typeof output.code, 'string');
      assert.ok(Array.isArray(output.artifact.bytecode));
      assert.ok(output.artifact.bytecode.length > 0);
      const context = {};
      runInNewContext(output.code, context, { timeout: 3000 });
      assert.equal(context.__packageResult, 42, name + ' compiled execution');
      assert.deepEqual(JSON.parse(JSON.stringify(context.__compatibilityChecks)),
        [1, [2, 3], 1, 7, true, true, true], name + ' automatic ES2015 compatibility');
      assert.throws(() => api.compileSource('const = ;', { filename: 'broken.js' }),
        (error) => error instanceof api.CompileError && error.code === 'SYNTAX_ERROR');
    }
    assert.equal(root.VERSION, ${JSON.stringify(manifest.version)});
    assert.equal(root.resolveFormat('input.js', source, 'iife'), 'iife');
    for (const code of [
      root.compile('input.js', null, { format: 'iife' }).code,
      root.transform('input.js', { format: 'iife' }),
    ]) {
      const context = {};
      runInNewContext(code, context, { timeout: 3000 });
      assert.equal(context.__packageResult, 42, 'file API execution');
      assert.deepEqual(JSON.parse(JSON.stringify(context.__compatibilityChecks)),
        [1, [2, 3], 1, 7, true, true, true], 'file API automatic ES2015 compatibility');
    }
  `
  await writeFile(path.join(consumer, 'consumer.cjs'), `
    const assert = require('node:assert/strict');
    const { runInNewContext } = require('node:vm');
    const root = require('script-vm-next');
    const core = require('script-vm-next/core');
    ${smokeAssertions}
  `)
  await writeFile(path.join(consumer, 'consumer.mjs'), `
    import assert from 'node:assert/strict';
    import { runInNewContext } from 'node:vm';
    import { compile, transform, resolveFormat, compileSource, CompileError, VERSION } from 'script-vm-next';
    import { compileSource as coreCompileSource, CompileError as CoreCompileError } from 'script-vm-next/core';
    const root = { compile, transform, resolveFormat, compileSource, CompileError, VERSION };
    const core = { compileSource: coreCompileSource, CompileError: CoreCompileError };
    ${smokeAssertions}
  `)
  console.log('[package] Testing CommonJS and named ESM imports, both core entries, and file APIs.')
  await run(process.execPath, ['consumer.cjs'])
  await run(process.execPath, ['consumer.mjs'])

  const typedAssertions = `
    const options: CompileOptions = { format: 'iife' };
    const sourceOptions: CompileSourceOptions = { format: 'iife', filename: 'consumer.js' };
    const fileResult: CompiledOutput = root.compile('input.js', null, options);
    const sourceResult: CompiledOutput = core.compileSource('1 + 2', sourceOptions);
    const code: string = root.transform('input.js', options);
    const sourceCode: string = sourceResult.code;
    const bytecode: number[] = sourceResult.artifact.bytecode;
    const version: string = root.VERSION;
    const diagnostic: Error = new core.CompileError('message', { code: 'SYNTAX_ERROR', stage: 'parse' });
    // @ts-expect-error Output formats are checked, not any.
    root.compile('input.js', null, { format: 'invalid' });
    // @ts-expect-error Source input is a string.
    core.compileSource(42);
    // @ts-expect-error Compiled output is typed, not any.
    const invalidCode: number = sourceResult.code;
  `
  await writeFile(path.join(consumer, 'consumer.mts'), `
    import * as root from 'script-vm-next';
    import * as core from 'script-vm-next/core';
    import type { CompileOptions, CompiledOutput } from 'script-vm-next';
    import type { CompileSourceOptions } from 'script-vm-next/core';
    ${typedAssertions}
  `)
  await writeFile(path.join(consumer, 'consumer.cts'), `
    import root = require('script-vm-next');
    import core = require('script-vm-next/core');
    import type { CompileOptions, CompiledOutput } from 'script-vm-next';
    import type { CompileSourceOptions } from 'script-vm-next/core';
    ${typedAssertions}
  `)
  await writeFile(path.join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2022'],
    },
    files: ['consumer.mts', 'consumer.cts'],
  }, null, 2))
  console.log('[package] Checking strict NodeNext ESM and CommonJS type consumers without skipLibCheck.')
  await run(process.execPath, [
    path.join(repository, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.json',
  ])

  const cli = path.join(consumer, 'node_modules/.bin', process.platform === 'win32' ? 'script-vm-next.cmd' : 'script-vm-next')
  console.log('[package] Running the installed CLI executable and its generated program.')
  const cliVersion = await run(cli, ['--version'])
  assert.equal(cliVersion.stdout.trim(), manifest.version)
  await writeFile(path.join(consumer, 'cli-input.js'), 'console.log("package-cli-ok");')
  await run(cli, ['cli-input.js', '--output', 'cli-output.cjs', '--format', 'iife'])
  const execution = await run(process.execPath, ['cli-output.cjs'])
  assert.equal(execution.stdout.trim(), 'package-cli-ok')

  const artifactDirectory = path.join(repository, 'artifacts')
  await mkdir(artifactDirectory, { recursive: true })
  const savedTarball = path.join(artifactDirectory, tarball.filename)
  await copyFile(tarballPath, savedTarball)
  console.log(`[package] Passed: ${tarball.files.length} published files, ${tarball.size} compressed bytes.`)
  console.log(`[package] Verified release tarball: ${path.relative(repository, savedTarball)}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
