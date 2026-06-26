import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTempDir, runIifeCode, writeTempFile } from './helpers'

describe('cli', () => {
  it('builds output files from relative paths', () => {
    const dir = makeTempDir('script-vm-next-cli-')
    writeTempFile(dir, 'input.js', 'var x = 41 + 1\n__result = x\n')

    execFileSync(
      process.execPath,
      [path.resolve(__dirname, '..', '..', 'dist', 'cli.js'), 'input.js', '-o', 'output.vm.js', '-f', 'iife'],
      {
        cwd: dir,
        stdio: 'pipe',
      }
    )

    const output = fs.readFileSync(path.join(dir, 'output.vm.js'), 'utf-8')
    const globalObject = runIifeCode(output)
    expect(globalObject.__result).toBe(42)
  })

  it('supports the transform subcommand', () => {
    const dir = makeTempDir('script-vm-next-cli-transform-')
    writeTempFile(dir, 'entry.js', 'var ok = true\n__result = ok\n')

    execFileSync(
      process.execPath,
      [path.resolve(__dirname, '..', '..', 'dist', 'cli.js'), 'transform', 'entry.js', '-o', 'out.vm.js'],
      {
        cwd: dir,
        stdio: 'pipe',
      }
    )

    expect(fs.existsSync(path.join(dir, 'out.vm.js'))).toBe(true)
  })
})
