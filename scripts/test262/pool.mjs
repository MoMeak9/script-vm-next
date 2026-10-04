import { Worker } from 'node:worker_threads'

// One fresh VM realm per variant; a bounded worker pool isolates compilation too.
// Terminate a worker on wall-clock timeout, then continue with a replacement.
export async function runJobs(jobs, { workers = 2, timeoutMs = 10000, workerFile = new URL('./worker.mjs', import.meta.url) } = {}) {
  if (!Number.isInteger(workers) || workers < 1 || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Worker count and timeout must be positive integers')
  const results = new Array(jobs.length)
  let next = 0
  async function lane() {
    let worker
    while (next < jobs.length) {
      const index = next++
      if (jobs[index].skip) {
        results[index] = { ...jobs[index], status: 'skip', detail: jobs[index].skip }
        continue
      }
      worker ??= new Worker(workerFile)
      const result = await new Promise(resolve => {
        const finish = value => {
          clearTimeout(timer)
          worker.off('message', finish)
          worker.off('error', onError)
          worker.off('exit', onExit)
          resolve(value)
        }
        const timer = setTimeout(() => finish({ status: 'fail', timeout: true, detail: 'Worker wall-clock timeout' }), timeoutMs)
        const onError = error => finish({ status: 'fail', workerError: true, detail: error.message })
        const onExit = code => finish({ status: 'fail', workerError: true, detail: `Worker exited (${code}) without a result` })
        worker.once('message', finish)
        worker.once('error', onError)
        worker.once('exit', onExit)
        worker.postMessage(jobs[index])
      })
      results[index] = { ...jobs[index], ...result }
      if (result.timeout || result.workerError) {
        await worker.terminate()
        worker = undefined
      }
    }
    await worker?.terminate()
  }
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, lane))
  return results
}
