import * as fs from 'node:fs'
import * as path from 'node:path'
import { bundle, hasCJSSyntax, hasModuleSyntax } from './bundler'
import { emitBytecode } from './emit'
import { normalizeAst, parseSource, resolveFormat as resolveFormatInternal } from './frontend'
import { lowerToIR } from './lowering'
import { packArtifact } from './pack'
import { allocateRegisters } from './regalloc'
import type { CompiledOutput, CompileOptions, ModuleFormat } from './types'

function defaultOutputPath(inputPath: string, format: ModuleFormat): string {
  const ext = path.extname(inputPath)
  const name = path.basename(inputPath, ext)
  const fileExt = format === 'esm' ? '.vm.mjs' : format === 'cjs' ? '.vm.cjs' : '.vm.js'
  return path.join(path.dirname(inputPath), `${name}${fileExt}`)
}

export function resolveFormat(sourceFile: string, sourceCode: string, format?: string): ModuleFormat {
  return resolveFormatInternal(sourceFile, sourceCode, format)
}

export default function compile(
  sourceFile: string,
  outputFile?: string | null,
  options: CompileOptions = {}
): CompiledOutput {
  if (options.obfuscate) {
    throw new Error('obfuscate is reserved for script-vm-next v0.2 and is not implemented in v0.1')
  }

  const sourceCode = fs.readFileSync(sourceFile, 'utf-8')
  const format = resolveFormatInternal(sourceFile, sourceCode, options.format)

  let codeToCompile = sourceCode
  let exportNames: string[] = []
  const shouldBundle = options.bundle !== false

  if (shouldBundle) {
    if (format === 'esm' && hasModuleSyntax(sourceCode)) {
      const bundled = bundle(sourceFile, {
        external: options.external,
        basePath: options.basePath,
        sourceType: 'module',
      })
      codeToCompile = bundled.code
      exportNames = bundled.entryExports
    } else if (format === 'cjs' && hasCJSSyntax(sourceCode)) {
      const bundled = bundle(sourceFile, {
        external: options.external,
        basePath: options.basePath,
        sourceType: 'script',
      })
      codeToCompile = bundled.code
      exportNames = bundled.entryExports
    }
  }

  const sourceType = format === 'esm' ? 'module' : 'script'
  const file = normalizeAst(parseSource(codeToCompile, sourceType))
  const lowered = lowerToIR(file)
  const allocated = allocateRegisters(lowered)
  const artifact = emitBytecode(allocated, format, exportNames, Boolean(options.debug))
  const code = packArtifact(artifact)

  if (typeof outputFile === 'string') {
    fs.writeFileSync(outputFile, code)
  } else if (outputFile === undefined) {
    fs.writeFileSync(defaultOutputPath(sourceFile, format), code)
  }

  return { code, artifact }
}
