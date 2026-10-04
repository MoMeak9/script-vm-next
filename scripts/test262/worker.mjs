import { parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { executeVariant } from './execute.mjs'
const require = createRequire(import.meta.url)
const { compileSource } = require('../../dist/cjs/core.js')
parentPort.on('message', job => {
  try {
    const harness = job.mode === 'raw' ? [] : ['sta.js', 'assert.js', ...job.metadata.includes].map(name => ({
      filename: `harness/${name}`, source: readFileSync(join(job.root, 'harness', name), 'utf8'),
    }))
    const result = executeVariant({ ...job, source: readFileSync(join(job.root, job.path), 'utf8'), filename: job.path, harness, compile: compileSource })
    parentPort.postMessage(result)
  } catch (error) {
    parentPort.postMessage({ status: 'fail', detail: `Runner error: ${error.stack ?? error}` })
  }
})
