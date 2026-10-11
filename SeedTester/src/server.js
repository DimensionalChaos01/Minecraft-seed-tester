// Interactive map: a small web server on this computer only (127.0.0.1) that serves the map page
// and computes biome tiles on demand with the worker pool.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { appliedFixes } from './deepslate-fixes.js'
import { pickFolder } from './folder-dialog.js'
import { readWorldFolder } from './worldfolder.js'
import { PackSet, ROOT_DIR } from './packs.js'
import { biomeColor } from './palette.js'
import { Pool, defaultThreadCount } from './pool.js'
import { displayNames } from './render.js'
import { parseSeed } from './seed.js'
import { resolveBiomeNames, waterMask } from './stats.js'
import { findStructures, prepareStructures } from './structures.js'
import { WorldSampler, listDimensions, openWorld, registerWorldgen } from './world.js'
import { locateBiomes } from './mode-locate.js'

const WEB_DIR = path.join(ROOT_DIR, 'web')
const PACK_DIR = path.join(ROOT_DIR, 'datapacks')
const TILE = 256 // tile edge in samples at full quality
const LOW = 64 // tile edge in samples for the quick preview
const CACHE_BYTES = 192 * 1024 * 1024
const MAX_UPLOAD = 256 * 1024 * 1024

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Everything that depends on the chosen packs + dimension. Replaced as a whole on "Load". */
class World {
  constructor(spec, threads, colors, waterBiomes) {
    this.spec = spec
    const { packs, dim } = openWorld(spec)
    this.packs = packs
    this.dim = dim
    this.pool = new Pool(spec, threads)
    // Without a handler a failing worker would take the whole server down; requests report it instead.
    this.pool.ready.catch(() => {})
    this.colors = dim.biomes.map(id => biomeColor(id, colors))
    this.isWater = waterMask(dim.biomes, waterBiomes)
    this.sampleY = dim.seaLevel + 1
    this.cache = new Map() // key -> Buffer, in least-recently-used order
    this.cacheBytes = 0
    this.inflight = new Map() // key -> { promise, cancels, waiting }
    this.structures = null
    this.samplers = new Map()
  }

  sampler(seed) {
    const key = seed.toString()
    if (!this.samplers.has(key)) {
      if (this.samplers.size >= 4) this.samplers.delete(this.samplers.keys().next().value)
      this.samplers.set(key, new WorldSampler(this.dim, seed))
    }
    return this.samplers.get(key)
  }

  remember(key, buffer) {
    this.cache.set(key, buffer)
    this.cacheBytes += buffer.length
    while (this.cacheBytes > CACHE_BYTES) {
      const [oldKey, old] = this.cache.entries().next().value
      this.cache.delete(oldKey)
      this.cacheBytes -= old.length
    }
  }

  /**
   * Biome indices of one tile as a Uint16Array buffer. Tile (tx, tz) at `bpp` blocks per sample
   * covers blocks tx*256*bpp .. (tx+1)*256*bpp. quality "low" is a 64x64 preview of the same area.
   * Returns { promise, release }: call release() if the requester goes away.
   */
  tile(seed, bpp, tx, tz, quality) {
    const key = `${seed}|${bpp}|${tx}|${tz}|${quality}`
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return { promise: Promise.resolve(cached), release() {} }
    }
    let entry = this.inflight.get(key)
    if (!entry) {
      const edge = quality === 'low' ? LOW : TILE
      const step = bpp * (TILE / edge)
      const base = { kind: 'biomes', seed: seed.toString(), x0: tx * TILE * bpp, width: edge, blocksPerPixel: step, y: this.sampleY, surface: true }
      // A full tile is split in two so that a browser's six connections keep twelve workers busy.
      const bands = quality === 'low' ? 1 : 2
      const rows = edge / bands
      const jobs = Array.from({ length: bands }, (_, i) => this.pool.submit({ ...base, z0: tz * TILE * bpp + i * rows * step, height: rows }, quality === 'low'))
      entry = { waiting: 0, cancels: jobs.map(j => j.cancel) }
      entry.promise = Promise.all(jobs.map(j => j.promise)).then(parts => {
        const out = new Uint16Array(edge * edge)
        parts.forEach((part, i) => out.set(part, i * rows * edge))
        const buffer = Buffer.from(out.buffer)
        this.remember(key, buffer)
        return buffer
      }).finally(() => this.inflight.delete(key))
      entry.promise.catch(() => {})
      this.inflight.set(key, entry)
    }
    entry.waiting++
    let released = false
    return {
      promise: entry.promise,
      release: () => {
        if (released) return
        released = true
        if (--entry.waiting === 0) entry.cancels.forEach(cancel => cancel())
      },
    }
  }

  structuresIn(seed, bounds) {
    if (!this.structures) this.structures = prepareStructures(this.packs, this.dim, true)
    const sampler = this.sampler(seed)
    const found = findStructures(this.structures, seed, bounds, (x, z) => sampler.biomeAt(x, this.sampleY, z, true))
    return found.map(s => ({ id: s.structure, x: s.x, z: s.z }))
  }

  describe() {
    const dim = this.dim
    return {
      dimension: dim.id,
      datapacks: this.spec.datapacks.map(p => path.basename(p)),
      biomes: dim.biomes,
      names: displayNames(dim.biomes),
      colors: this.colors,
      water: this.isWater,
      minY: dim.minY,
      height: dim.height,
      seaLevel: dim.seaLevel,
      generator: dim.generatorType,
      biomeSource: dim.source.kind,
      fixes: appliedFixes,
    }
  }

  async close() {
    await this.pool.close()
  }
}

function listPackFiles() {
  fs.mkdirSync(PACK_DIR, { recursive: true })
  return fs.readdirSync(PACK_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() || /\.(zip|jar)$/i.test(e.name))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b))
}

/** Pack names from the page are file names inside the datapacks folder, nothing else. */
function packPath(name) {
  const clean = path.basename(String(name))
  const full = path.join(PACK_DIR, clean)
  if (clean !== name || !fs.existsSync(full)) throw new HttpError(400, `Datapack "${name}" is not in the datapacks folder.`)
  return full
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, 'That file is too large.'))
        req.destroy()
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }

export async function startServer(config, options = {}) {
  const threads = Math.max(1, config.threads || defaultThreadCount())
  const colors = config.colors ?? {}
  const waterBiomes = config.waterBiomes ?? ['ocean']
  let generation = 0
  let world = null
  let startupError = null

  const load = spec => {
    let next
    try {
      next = new World(spec, threads, colors, waterBiomes)
    } catch (e) {
      // A bad pack keeps the old world, but loading it has already replaced the shared noise
      // registry, so put the old world's data back.
      if (world) registerWorldgen(world.packs)
      throw e
    }
    const old = world
    world = next
    generation++
    old?.close()
  }

  // Start with what config.json says; if that fails, fall back to vanilla so the page still opens.
  const packsInFolder = p => path.dirname(p) === PACK_DIR
  const initialPacks = (config.datapacks ?? []).filter(p => fs.existsSync(p))
  for (const p of initialPacks) {
    if (!packsInFolder(p)) console.log(`Note: ${p} is outside the datapacks folder; it is loaded now but will not be listed on the page.`)
  }
  try {
    load({ datapacks: initialPacks, dimension: config.dimension ?? 'minecraft:overworld', vanilla: true })
  } catch (e) {
    startupError = e.message
    console.log(`Could not load the configured world (${e.message}). Starting with vanilla instead.`)
    load({ datapacks: [], dimension: 'minecraft:overworld', vanilla: true })
  }

  // Set while a world folder is open: its packs and level.dat replace the datapacks-folder choice.
  let worldInfo = null
  let picking = false
  let lastFolder = ''

  const preferredDimension = packs => {
    // The overworld unless something else is chosen; other dimensions are one dropdown away.
    const all = listDimensions(packs)
    return all.includes('minecraft:overworld') ? 'minecraft:overworld' : all[0]
  }

  const openWorldFolder = folder => {
    const info = readWorldFolder(folder)
    const spec = { datapacks: info.packs, vanilla: true, extra: [info.levelPack] }
    spec.dimension = preferredDimension(PackSet.load(spec.datapacks, { extra: spec.extra }))
    load(spec)
    lastFolder = path.dirname(info.folder)
    worldInfo = {
      folder: info.folder,
      name: info.name,
      version: info.version,
      seed: info.seed,
      packs: info.packs.map(p => path.basename(p)),
      skipped: info.skipped,
      versionNote: info.version.startsWith('1.20') ? null : `This world was saved by Minecraft ${info.version}. Seed Tester generates terrain the 1.20.1 way, so the map can differ from the game.`,
    }
    startupError = null
    console.log(`Opened world "${info.name}" (${info.version}), seed ${info.seed}, ${info.packs.length} datapack(s), showing ${world.dim.id}`)
  }

  const state = () => ({
    generation,
    threads,
    startupError,
    worldInfo,
    available: listPackFiles(),
    selected: worldInfo ? [] : world.spec.datapacks.filter(packsInFolder).map(p => path.basename(p)),
    dimensions: listDimensions(world.packs),
    world: world.describe(),
    defaultSeed: String(config.seed ?? 0),
  })

  const json = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(text)
  }

  const handlers = {
    'GET /api/state': async (req, res) => json(res, 200, state()),

    // Text seeds are hashed like Minecraft does; "random" becomes a concrete number.
    'GET /api/seed': async (req, res, q) => json(res, 200, { seed: parseSeed(q.get('text') ?? '').toString() }),

    'GET /api/dimensions': async (req, res, q) => {
      const packs = PackSet.load(q.getAll('pack').map(packPath))
      json(res, 200, { dimensions: listDimensions(packs) })
    },

    // Opens the Windows folder window, then reads the chosen world: seed, datapacks, dimensions.
    'POST /api/open-world': async (req, res) => {
      if (picking) throw new HttpError(409, 'The folder window is already open. Look for it on your taskbar.')
      const saves = path.join(process.env.APPDATA ?? '', '.minecraft', 'saves')
      picking = true
      let folder
      try {
        folder = await pickFolder({
          title: 'Select the Minecraft world folder (the one that contains level.dat)',
          start: lastFolder || (fs.existsSync(saves) ? saves : ''),
        })
      } catch (e) {
        throw new HttpError(500, e.message)
      } finally {
        picking = false
      }
      if (!folder) return json(res, 200, { cancelled: true })
      lastFolder = folder
      try {
        openWorldFolder(folder)
      } catch (e) {
        throw new HttpError(400, e.message)
      }
      json(res, 200, state())
    },

    'POST /api/load': async (req, res) => {
      const body = JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}')
      // With a world open, only the dimension changes; its packs and level.dat stay as they are.
      const keepWorld = body.useWorld === true && worldInfo !== null
      const datapacks = keepWorld ? world.spec.datapacks : (body.datapacks ?? []).map(packPath)
      const extra = keepWorld ? world.spec.extra : []
      const dimension = body.dimension || preferredDimension(PackSet.load(datapacks, { extra }))
      try {
        load({ datapacks, dimension, vanilla: true, extra })
      } catch (e) {
        throw new HttpError(400, e.message)
      }
      if (!keepWorld) worldInfo = null
      startupError = null
      console.log(`Loaded ${world.dim.id} with ${datapacks.length} datapack(s): ${datapacks.map(p => path.basename(p)).join(', ') || 'vanilla only'}`)
      json(res, 200, state())
    },

    'POST /api/upload': async (req, res, q) => {
      const name = path.basename(String(q.get('name') ?? ''))
      if (!/^[^<>:"/\\|?*\x00-\x1f]+\.(zip|jar)$/i.test(name)) throw new HttpError(400, 'Only .zip or .jar datapacks can be added here. Copy folders into the datapacks folder by hand.')
      const data = await readBody(req, MAX_UPLOAD)
      if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) throw new HttpError(400, `"${name}" is not a zip file.`)
      fs.mkdirSync(PACK_DIR, { recursive: true })
      const target = path.join(PACK_DIR, name)
      const temp = `${target}.uploading`
      fs.writeFileSync(temp, data)
      try {
        new PackSet().addZip(temp, name) // refuses archives without worldgen data
      } catch (e) {
        fs.rmSync(temp, { force: true })
        throw new HttpError(400, e.message.replace(temp, name))
      }
      fs.renameSync(temp, target)
      console.log(`Added datapack ${name} (${(data.length / 1024).toFixed(0)} KB)`)
      json(res, 200, { name, available: listPackFiles() })
    },

    'GET /api/tile': async (req, res, q) => {
      if (Number(q.get('g')) !== generation) throw new HttpError(409, 'The world was reloaded.')
      const seed = parseSeed(q.get('seed') ?? '0')
      const bpp = Number(q.get('bpp'))
      const tx = Number(q.get('x'))
      const tz = Number(q.get('z'))
      const quality = q.get('q') === 'low' ? 'low' : 'high'
      if (![4, 8, 16, 32, 64, 128, 256, 512].includes(bpp) || !Number.isInteger(tx) || !Number.isInteger(tz) || Math.abs(tx) > 1e6 || Math.abs(tz) > 1e6) {
        throw new HttpError(400, 'Bad tile request.')
      }
      const request = world.tile(seed, bpp, tx, tz, quality)
      res.on('close', () => {
        if (!res.writableEnded) request.release()
      })
      let buffer
      try {
        buffer = await request.promise
      } catch (e) {
        if (e.message === 'cancelled') return res.destroy()
        throw e
      }
      const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')
      const body = gzip ? zlib.gzipSync(buffer, { level: 1 }) : buffer
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
        ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
      })
      res.end(body)
    },

    'GET /api/structures': async (req, res, q) => {
      if (Number(q.get('g')) !== generation) throw new HttpError(409, 'The world was reloaded.')
      const seed = parseSeed(q.get('seed') ?? '0')
      const bounds = Object.fromEntries(['minX', 'maxX', 'minZ', 'maxZ'].map(k => [k, Math.round(Number(q.get(k)))]))
      if (Object.values(bounds).some(v => !Number.isFinite(v))) throw new HttpError(400, 'Bad area.')
      if ((bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ) > 40000 * 40000) throw new HttpError(400, 'Zoom in to see structures.')
      const candidates = world.structuresIn(seed, bounds)
      // Every structure that can generate somewhere in this dimension, for the panel's type list.
      const types = [...new Set(world.structures.sets.flatMap(s => s.entries.filter(e => e.allowed.size > 0).map(e => e.id)))].sort()
      json(res, 200, { candidates, types, skipped: world.structures.skipped })
    },

    // Nearest biome, found with the same search as /locate biome.
    'GET /api/locate': async (req, res, q) => {
      if (Number(q.get('g')) !== generation) throw new HttpError(409, 'The world was reloaded.')
      const seed = parseSeed(q.get('seed') ?? '0')
      const { indices } = resolveBiomeNames(world.dim.biomes, [q.get('biome') ?? ''])
      if (indices.size === 0) throw new HttpError(400, 'Unknown biome.')
      const from = [Math.round(Number(q.get('x')) || 0), world.sampleY, Math.round(Number(q.get('z')) || 0)]
      const { found } = locateBiomes(world.sampler(seed), world.dim, [...indices], from, {})
      const hit = [...found.values()].sort((a, b) => a.distance - b.distance)[0]
      json(res, 200, { found: hit ?? null, from })
    },
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Only this computer may talk to the server, and only pages it served itself may change
      // anything: a website open in another tab cannot send the custom header without permission.
      const host = (req.headers.host ?? '').replace(/:\d+$/, '')
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new HttpError(403, 'Forbidden.')
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'POST' && req.headers['x-seed-tester'] !== '1') throw new HttpError(403, 'Forbidden.')

      const handler = handlers[`${req.method} ${url.pathname}`]
      if (handler) return await handler(req, res, url.searchParams)

      if (req.method !== 'GET') throw new HttpError(404, 'Not found.')
      const file = path.join(WEB_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([/\\]|\.\.)+/, ''))
      if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found.')
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
      res.end(fs.readFileSync(file))
    } catch (e) {
      if (res.headersSent) return res.destroy()
      const status = e.status ?? 500
      if (status === 500) console.error(e)
      json(res, status, { error: e.message })
    }
  })

  // "node src/cli.js map --world <folder>" opens a world straight away.
  if (options.world) {
    try {
      openWorldFolder(path.resolve(String(options.world)))
    } catch (e) {
      startupError = e.message
      console.log(`Could not open the world: ${e.message}`)
    }
  }

  const port = await new Promise((resolve, reject) => {
    let candidate = Number(options.port) || 8123
    let attempts = 0
    server.on('error', err => {
      if (err.code === 'EADDRINUSE' && attempts++ < 20) server.listen(++candidate, '127.0.0.1')
      else reject(err)
    })
    server.on('listening', () => resolve(candidate))
    server.listen(candidate, '127.0.0.1')
  })

  const address = `http://127.0.0.1:${port}/`
  console.log('')
  console.log(`Seed Tester map is running at ${address}`)
  console.log(`Showing ${world.dim.id}, ${threads} threads. Keep this window open; close it to stop.`)
  if (options.open !== false && process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', address], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  }
  return { server, address, close: async () => { server.close(); await world.close() } }
}
