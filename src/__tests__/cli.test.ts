import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTempDir, runIifeCode, writeTempFile } from './helpers'

const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'))
const cliPath = path.resolve(__dirname, '..', '..', packageJson.bin['script-vm-next'])

describe('cli', () => {
  it('builds output files from relative paths', () => {
    const dir = makeTempDir('script-vm-next-cli-')
    writeTempFile(dir, 'input.js', 'var x = 41 + 1\n__result = x\n')

    execFileSync(
      process.execPath,
      [cliPath, 'input.js', '-o', 'output.vm.js', '-f', 'iife'],
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
      [cliPath, 'transform', 'entry.js', '-o', 'out.vm.js'],
      {
        cwd: dir,
        stdio: 'pipe',
      }
    )

    expect(fs.existsSync(path.join(dir, 'out.vm.js'))).toBe(true)
  })
  it('reports the package version', () => {
    expect(execFileSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' }).trim()).toBe(packageJson.version)
  })

  it.each([
    ['const broken = ;', [], 'SYNTAX_ERROR'],
    ['var n = 1;', ['--format', 'invalid'], 'INVALID_FORMAT'],
  ])('reports concise diagnostics with nonzero exit status: %s', (source, args, code) => {
    const dir = makeTempDir('script-vm-next-cli-errors-')
    writeTempFile(dir, 'input.js', source)
    const result = spawnSync(process.execPath, [cliPath, 'input.js', ...args], { cwd: dir, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(code)
    expect(result.stderr).toContain('input.js')
    expect(result.stderr).not.toMatch(/\n\s+at /)
    expect(result.stdout).toBe('')
    expect(fs.readdirSync(dir)).toEqual(['input.js'])
  })

  it('reports missing input files without a stack trace', () => {
    const dir = makeTempDir('script-vm-next-cli-missing-')
    const result = spawnSync(process.execPath, [cliPath, 'missing.js'], { cwd: dir, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('IO_ERROR')
    expect(result.stderr).not.toMatch(/\n\s+at /)
  })
})
