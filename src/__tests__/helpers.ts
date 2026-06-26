import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vm from 'node:vm'
import { pathToFileURL } from 'node:url'
import { transform } from '../index'

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function writeTempFile(dir: string, name: string, source: string): string {
  const filePath = path.join(dir, name)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, source)
  return filePath
}

export function runIifeCode(code: string, sandbox: Record<string, any> = {}): Record<string, any> {
  const globalObject: Record<string, any> = {
    console,
    Reflect,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    JSON,
    Date,
    RegExp,
    Error,
    TypeError,
    Promise,
    Symbol,
    WeakMap,
    WeakSet,
    BigInt,
    Map,
    Set,
    ...sandbox,
  }

  const context = vm.createContext({
    globalThis: globalObject,
    window: globalObject,
    global: globalObject,
    ...globalObject,
  })

  vm.runInContext(code, context)
  return globalObject
}

export function compileAndRunSource(source: string): any {
  const dir = makeTempDir('script-vm-next-src-')
  const input = writeTempFile(dir, 'input.js', source)
  const code = transform(input, { format: 'iife' })
  return runIifeCode(code).__result
}

export async function compileToEsmModule(sourceFiles: Record<string, string>, entry = 'entry.js'): Promise<any> {
  const dir = makeTempDir('script-vm-next-esm-')
  for (const [name, source] of Object.entries(sourceFiles)) {
    writeTempFile(dir, name, source)
  }
  const input = path.join(dir, entry)
  const output = path.join(dir, 'output.mjs')
  fs.writeFileSync(output, transform(input, { format: 'esm', bundle: true }))
  return import(pathToFileURL(output).href)
}

export function compileToCjsModule(sourceFiles: Record<string, string>, entry = 'entry.cjs'): any {
  const dir = makeTempDir('script-vm-next-cjs-')
  for (const [name, source] of Object.entries(sourceFiles)) {
    writeTempFile(dir, name, source)
  }
  const input = path.join(dir, entry)
  const output = path.join(dir, 'output.cjs')
  fs.writeFileSync(output, transform(input, { format: 'cjs', bundle: true }))
  return require(output)
}
