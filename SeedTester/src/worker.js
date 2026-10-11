// Worker thread: loads the same packs as the main thread, then samples tiles on request.

import { parentPort, workerData } from 'node:worker_threads'
import { openWorld, WorldSampler } from './world.js'

let dim
try {
  dim = openWorld(workerData.world).dim
  parentPort.postMessage({ type: 'ready' })
} catch (e) {
  parentPort.postMessage({ type: 'fatal', message: e.message })
}

let sampler = null
let samplerSeed = null
function samplerFor(seed) {
  if (samplerSeed !== seed) {
    sampler = new WorldSampler(dim, BigInt(seed))
    samplerSeed = seed
  }
  return sampler
}

// Pixel (px, py) of a tile covers the blocks starting at x0 + px * bpp; it is sampled at its centre.
function sampleBiomes(task) {
  const { x0, z0, width, height, blocksPerPixel: bpp, y, surface } = task
  const s = samplerFor(task.seed)
  const out = new Uint16Array(width * height)
  for (let py = 0; py < height; py++) {
    const z = Math.floor(z0 + (py + 0.5) * bpp)
    for (let px = 0; px < width; px++) {
      out[py * width + px] = s.biomeAt(Math.floor(x0 + (px + 0.5) * bpp), y, z, surface)
    }
  }
  return out
}

function sampleHeights(task) {
  const { x0, z0, width, height, blocksPerPixel: bpp } = task
  const s = samplerFor(task.seed)
  const out = new Int16Array(width * height)
  for (let py = 0; py < height; py++) {
    // Snapped to the 4-block noise grid: exact there, and several times faster to evaluate.
    const z = (Math.floor(z0 + (py + 0.5) * bpp) >> 2) << 2
    for (let px = 0; px < width; px++) {
      out[py * width + px] = s.surfaceHeightAt((Math.floor(x0 + (px + 0.5) * bpp) >> 2) << 2, z)
    }
  }
  return out
}

parentPort.on('message', task => {
  try {
    const data = task.kind === 'heights' ? sampleHeights(task) : sampleBiomes(task)
    parentPort.postMessage({ type: 'done', id: task.id, data }, [data.buffer])
  } catch (e) {
    parentPort.postMessage({ type: 'error', id: task.id, message: e.stack ?? e.message })
  }
})
