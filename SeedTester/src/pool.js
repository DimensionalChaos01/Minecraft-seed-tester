// A small worker-thread pool. Every worker loads the datapacks once, then takes sampling tasks.

import os from 'node:os'
import { Worker } from 'node:worker_threads'

export function defaultThreadCount() {
  const cores = os.availableParallelism?.() ?? os.cpus().length
  return Math.max(1, cores - 1)
}

export class Pool {
  constructor(world, threads) {
    this.size = Math.max(1, threads || defaultThreadCount())
    this.queue = []
    this.pending = new Map()
    this.nextId = 1
    this.idle = []
    this.workers = []
    this.failed = null
    this.ready = Promise.all(Array.from({ length: this.size }, () => this.spawn(world)))
  }

  spawn(world) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { world } })
      this.workers.push(worker)
      worker.on('message', msg => {
        if (msg.type === 'ready') {
          this.idle.push(worker)
          resolve()
          this.pump()
        } else if (msg.type === 'fatal') {
          reject(new Error(msg.message))
        } else {
          const job = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          this.idle.push(worker)
          if (msg.type === 'done') job.resolve(msg.data)
          else job.reject(new Error(msg.message))
          this.pump()
        }
      })
      worker.on('error', err => {
        this.failed = err
        reject(err)
        for (const job of this.pending.values()) job.reject(err)
        this.pending.clear()
      })
    })
  }

  pump() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()
      const job = this.queue.shift()
      this.pending.set(job.task.id, job)
      worker.postMessage(job.task)
    }
  }

  run(task) {
    if (this.failed) return Promise.reject(this.failed)
    return new Promise((resolve, reject) => {
      this.queue.push({ task: { ...task, id: this.nextId++ }, resolve, reject })
      this.pump()
    })
  }

  /**
   * Like run(), but the job can be withdrawn while it is still waiting in the queue (used by the
   * interactive map when a tile scrolls out of view). front=true jumps the queue.
   */
  submit(task, front = false) {
    let job
    const promise = new Promise((resolve, reject) => {
      job = { task: { ...task, id: this.nextId++ }, resolve, reject }
    })
    if (this.failed) {
      job.reject(this.failed)
    } else {
      if (front) this.queue.unshift(job)
      else this.queue.push(job)
      this.pump()
    }
    return {
      promise,
      cancel: () => {
        const i = this.queue.indexOf(job)
        if (i === -1) return false
        this.queue.splice(i, 1)
        job.reject(new Error('cancelled'))
        return true
      },
    }
  }

  /**
   * Samples a width x height grid by splitting it into horizontal bands.
   * kind: 'biomes' (Uint16Array of biome indices) or 'heights' (Int16Array of surface Y).
   */
  async sampleGrid(kind, params, onProgress) {
    const { width, height, blocksPerPixel } = params
    const out = kind === 'heights' ? new Int16Array(width * height) : new Uint16Array(width * height)
    // Enough bands that every worker stays busy and progress updates are frequent.
    const rowsPerBand = Math.max(1, Math.min(32, Math.ceil(height / (this.size * 4))))
    let doneRows = 0
    const jobs = []
    for (let row = 0; row < height; row += rowsPerBand) {
      const rows = Math.min(rowsPerBand, height - row)
      jobs.push(this.run({ ...params, kind, z0: params.z0 + row * blocksPerPixel, height: rows }).then(data => {
        out.set(data, row * width)
        doneRows += rows
        onProgress?.(doneRows / height)
      }))
    }
    await Promise.all(jobs)
    return out
  }

  async close() {
    await Promise.all(this.workers.map(w => w.terminate()))
  }
}

/** Single-line progress display for the console. */
export function progressPrinter(label) {
  const started = Date.now()
  let lastDraw = 0
  const interactive = process.stdout.isTTY
  return {
    update(fraction, extra = '') {
      const now = Date.now()
      if (!interactive || (now - lastDraw < 150 && fraction < 1)) return
      lastDraw = now
      const elapsed = (now - started) / 1000
      const eta = fraction > 0.02 ? ` - about ${Math.max(0, Math.round(elapsed / fraction - elapsed))}s left` : ''
      process.stdout.write(`\r${label}: ${(fraction * 100).toFixed(0).padStart(3)}%${fraction < 1 ? eta : ''}${extra ? ' - ' + extra : ''}          `)
    },
    done(summary = '') {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1)
      if (interactive) process.stdout.write('\r' + ' '.repeat(78) + '\r')
      console.log(`${label}: done in ${elapsed}s${summary ? ' - ' + summary : ''}`)
    },
  }
}
