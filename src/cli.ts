#!/usr/bin/env node

import { Command } from 'commander'
import compile from './compiler'
import { CompileError } from './compiler/diagnostics'
import { resolve } from 'node:path'
import { VERSION } from './version'
import type { RuntimeMode } from './compiler/types'

const program = new Command()

program.name('script-vm-next').description('Register-based JS VM compiler').version(VERSION)

interface CliOptions {
  output?: string
  format?: string
  bundle?: boolean
  external?: string
  debug?: boolean
  runtime?: string
}

function runCompile(input: string, options: CliOptions) {
  const inputPath = resolve(process.cwd(), input)
  const outputPath = options.output ? resolve(process.cwd(), options.output) : undefined
  try {
    compile(inputPath, outputPath, {
      format: options.format as 'auto' | 'iife' | 'esm' | 'cjs',
      bundle: options.bundle,
      external: options.external?.split(',').map(item => item.trim()).filter(Boolean),
      debug: Boolean(options.debug),
      runtime: options.runtime as RuntimeMode,
    })
  } catch (error) {
    if (error instanceof CompileError) {
      const location = error.filename
        ? `${error.filename}${error.line === undefined ? '' : `:${error.line}:${error.column ?? 1}`}: `
        : ''
      process.stderr.write(`${location}${error.code}: ${error.message}\n`)
    } else {
      process.stderr.write(`Compilation failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    process.exitCode = 1
  }
}

const registerCommand = (command: Command) =>
  command
    .argument('<input>', 'Input file path')
    .option('-o, --output <path>', 'Output file path')
    .option('-f, --format <format>', 'Output format (auto|iife|esm|cjs)', 'auto')
    .option('--no-bundle', 'Disable module bundling')
    .option('--external <modules>', 'Comma-separated external module names')
    .option('--debug', 'Emit debug information')
    .option('--runtime <mode>', 'Interpreter assembly (auto|full)', 'auto')
    .action(runCompile)

registerCommand(program)
registerCommand(program.command('transform').description('Transform JS source into register-based VM output'))

if (process.argv[2] === 'transform') {
  process.argv.splice(2, 1)
}

program.parse()
