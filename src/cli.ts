#!/usr/bin/env node

import { Command } from 'commander'
import compile, { resolveFormat } from './compiler'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const program = new Command()

program.name('script-vm-next').description('Register-based JS VM compiler').version('0.1.0')

function runCompile(input: string, options: any) {
  const resolvedOptions = typeof options?.opts === 'function' ? options.opts() : options
  const inputPath = resolve(process.cwd(), input)
  const outputPath = resolvedOptions.output ? resolve(process.cwd(), resolvedOptions.output) : undefined
  const source = readFileSync(inputPath, 'utf-8')
  const resolvedFormat = resolveFormat(inputPath, source, resolvedOptions.format)

  compile(inputPath, outputPath, {
    format: resolvedFormat,
    bundle: resolvedOptions.bundle,
    external: resolvedOptions.external ? resolvedOptions.external.split(',').map((item: string) => item.trim()) : undefined,
    debug: Boolean(resolvedOptions.debug),
  })
}

const registerCommand = (command: Command) =>
  command
    .argument('<input>', 'Input file path')
    .option('-o, --output <path>', 'Output file path')
    .option('-f, --format <format>', 'Output format (auto|iife|esm|cjs)', 'auto')
    .option('--no-bundle', 'Disable module bundling')
    .option('--external <modules>', 'Comma-separated external module names')
    .option('--debug', 'Emit debug information')
    .action(runCompile)

registerCommand(program)
registerCommand(program.command('transform').description('Transform JS source into register-based VM output'))

if (process.argv[2] === 'transform') {
  process.argv.splice(2, 1)
}

program.parse()
