import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from '@babel/parser'

export interface ResolvedImport {
  /** Canonical source file for an inlined ESM dependency. */
  filename?: string
  /** Native import URL for a CommonJS, builtin or explicitly external module. */
  external?: string
}

// Use Node's own resolver instead of approximating conditional exports, package
// imports, package self-references or symlink semantics. This process resolves
// URLs only: no dependency is imported, required, or evaluated at build time.
const RESOLVER = `
import { readFileSync } from 'node:fs';
const { parent, specifiers } = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(specifiers.map(specifier => {
  try { return { url: import.meta.resolve(specifier, parent) }; }
  catch (error) { return { error: error.message, code: error.code }; }
})));
`

export function resolveStaticImports(
  specifiers: string[], importer: string, externals: Set<string>,
): Map<string, ResolvedImport> {
  const unique = [...new Set(specifiers)]
  if (!unique.length) return new Map()
  let results: Array<{ url?: string; error?: string; code?: string }>
  try {
    const response = execFileSync(process.execPath, [
      '--experimental-import-meta-resolve', '--input-type=module', '--eval', RESOLVER,
    ], {
      input: JSON.stringify({ parent: pathToFileURL(importer).href, specifiers: unique }),
      encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      // User loader/preload flags must not execute arbitrary code in the resolver.
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    results = JSON.parse(response)
    if (!Array.isArray(results) || results.length !== unique.length) throw new Error('invalid resolver response')
  } catch (error) {
    const failure = new Error(`Cannot run the Node static module resolver for '${importer}': ${error instanceof Error ? error.message : String(error)}`)
    Object.defineProperty(failure, 'cause', { value: error, configurable: true })
    throw failure
  }
  const resolved = new Map<string, ResolvedImport>()
  unique.forEach((specifier, index) => {
    const result = results[index]
    if (result.code === 'ERR_UNSUPPORTED_DIR_IMPORT' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      result.url = new URL(specifier, pathToFileURL(importer)).href
      delete result.error
    }
    if (result.error || !result.url) {
      throw new Error(`Cannot resolve module '${specifier}' from '${importer}': ${result.code ?? ''} ${result.error ?? 'missing URL'}`)
    }
    if (result.url.startsWith('node:')) {
      resolved.set(specifier, { external: result.url })
      return
    }
    if (!result.url.startsWith('file:')) {
      throw new Error(`Unsupported static module loader for '${specifier}' in '${importer}': only JavaScript file: and node: modules are supported`)
    }
    const url = new URL(result.url)
    if (url.search || url.hash) {
      // Queries and fragments create distinct module identities in Node. Do not
      // silently merge them with the realpath-keyed VM dependency graph.
      throw new Error(`Unsupported static module URL '${result.url}': query and fragment module identities are not supported`)
    }
    let filename = fileURLToPath(url)
    // Keep the file API's existing extension/index convenience for local source
    // imports. Package exports/imports targets remain governed by Node exactly.
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && (!fs.existsSync(filename) || !fs.statSync(filename).isFile())) {
      const candidates = ['.js', '.ts', '.mjs', '.cjs'].map(extension => filename + extension)
      candidates.push(...['.js', '.ts', '.mjs', '.cjs'].map(extension => path.join(filename, 'index' + extension)))
      filename = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? filename
    }
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
      throw new Error(`Cannot resolve module '${specifier}' from '${importer}': '${filename}' is not a file`)
    }
    const extension = path.extname(filename)
    if (!['.js', '.mjs', '.cjs', '.ts', ''].includes(extension)) {
      throw new Error(`Unsupported static module loader for '${specifier}' in '${importer}': '${extension}' requires a loader; only JavaScript modules are supported`)
    }
    const canonical = fs.realpathSync(filename)
    if (externals.has(specifier) || isCommonJS(canonical)) {
      resolved.set(specifier, { external: pathToFileURL(canonical).href })
    } else {
      resolved.set(specifier, { filename: canonical })
    }
  })
  return resolved
}

function isCommonJS(filename: string): boolean {
  if (filename.endsWith('.cjs')) return true
  if (filename.endsWith('.mjs') || filename.endsWith('.ts')) return false
  let directory = path.dirname(filename)
  while (true) {
    const manifest = path.join(directory, 'package.json')
    if (fs.existsSync(manifest)) {
      const info = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if (info.type === 'module') return false
      if (info.type === 'commonjs') return true
      break
    }
    // Node package scopes do not inherit the consuming project's package type.
    if (path.basename(directory) === 'node_modules') break
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  // Preserve the compiler's existing support for untyped local .js ESM and
  // Node's syntax detection for ambiguous .js packages. Explicit commonjs scopes
  // above remain authoritative, regardless of the file's source text.
  const source = fs.readFileSync(filename, 'utf8')
  return parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, allowNewTargetOutsideFunction: true }).program.sourceType !== 'module'
}
