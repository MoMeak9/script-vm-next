import * as fs from 'node:fs'
import * as path from 'node:path'
import { bundle, detectModuleFormat, hasCJSSyntax, hasModuleSyntax } from './bundler'
import { compileProgram } from './core-pipeline'
import { CompileError, compileStep } from './diagnostics'
import type { CompiledOutput, CompileOptions, ModuleFormat, ProgramArtifact } from './types'

function defaultOutputPath(inputPath: string, format: ModuleFormat): string {
  const ext = path.extname(inputPath)
  const name = path.basename(inputPath, ext)
  const fileExt = format === 'esm' ? '.vm.mjs' : format === 'cjs' ? '.vm.cjs' : '.vm.js'
  return path.join(path.dirname(inputPath), `${name}${fileExt}`)
}

export function resolveFormat(sourceFile: string, sourceCode: string, format?: string): ModuleFormat {
  if (format !== undefined && format !== 'auto') {
    if (format !== 'iife' && format !== 'esm' && format !== 'cjs') {
      throw new CompileError(`Unknown output format '${format}'; expected auto, iife, esm, or cjs.`, {
        code: 'INVALID_FORMAT', stage: 'input', filename: sourceFile,
      })
    }
    return format
  }
  return detectModuleFormat(sourceFile, sourceCode)
}

export default function compile(
  sourceFile: string,
  outputFile?: string | null,
  options: CompileOptions = {}
): CompiledOutput {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new CompileError('Options must be an object.', { code: 'INVALID_OPTION', stage: 'input' })
  }
  if (options.obfuscate) {
    throw new CompileError('obfuscate is reserved and is not implemented.', {
      code: 'UNSUPPORTED_FEATURE', stage: 'input', filename: sourceFile,
    })
  }

  const sourceCode = compileStep('read', sourceFile, () => fs.readFileSync(sourceFile, 'utf-8'))
  const format = resolveFormat(sourceFile, sourceCode, options.format)

  let codeToCompile = sourceCode
  let exportNames: string[] = []
  let notifyIdentifier: string | undefined
  let exportsIdentifier: string | undefined
  let hostImports: ProgramArtifact['hostImports']
  let hostExports: ProgramArtifact['hostExports']
  const shouldBundle = options.bundle !== false

  if (shouldBundle && (
    format === 'esm' && hasModuleSyntax(sourceCode) ||
    format === 'cjs' && hasCJSSyntax(sourceCode)
  )) {
    const bundled = compileStep('bundle', sourceFile, () => bundle(sourceFile, {
      external: options.external,
      basePath: options.basePath,
      sourceType: format === 'esm' ? 'module' : 'script',
    }))
    codeToCompile = bundled.code
    exportNames = bundled.entryExports
    notifyIdentifier = bundled.notifyIdentifier
    exportsIdentifier = bundled.exportsIdentifier
    hostImports = bundled.hostImports
    hostExports = bundled.hostExports
  }

  const output = compileProgram(codeToCompile, {
    filename: sourceFile, format, debug: options.debug,
    exportNames, exportsIdentifier, notifyIdentifier, hostImports, hostExports,
  })

  if (typeof outputFile === 'string') {
    compileStep('write', outputFile, () => fs.writeFileSync(outputFile, output.code))
  } else if (outputFile === undefined) {
    const target = defaultOutputPath(sourceFile, format)
    compileStep('write', target, () => fs.writeFileSync(target, output.code))
  }

  return output
}
