// Mode "locate": reproduces the search that "/locate biome" runs in 1.20.1, so the result can be
// compared directly with the game.
//
// The game checks a square spiral of points around the start, every 32 blocks out to 6400 blocks,
// and at each point tries several heights 64 blocks apart, starting at the start height. It uses
// the real biome at that exact position (not the surface biome), and returns the first match.

import fs from 'node:fs'
import path from 'node:path'
import { safeName } from './config.js'
import { normalizeId } from './packs.js'
import { progressPrinter } from './pool.js'
import { describeSeed, relativeToCwd } from './session.js'
import { resolveBiomeNames } from './stats.js'
import { WorldSampler } from './world.js'

/** Minecraft's BlockPos.spiralAround(ZERO, size, EAST, SOUTH), yielding [dx, dz] steps. */
export function* spiral(size) {
  const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]] // east, south, west, north
  let x = 0
  let z = 1
  const legs = 4 * size
  let leg = -1
  let legSize = 0
  let legIndex = 0
  for (;;) {
    const [dx, dz] = directions[(leg + 4) % 4]
    x += dx
    z += dz
    if (legIndex >= legSize) {
      if (leg >= legs) return
      leg++
      legIndex = 0
      legSize = Math.floor(leg / 2) + 1
    }
    legIndex++
    yield [x, z]
  }
}

/** Minecraft's Mth.outFromOrigin: start, then alternately above and below in `step`s. */
export function outFromOrigin(origin, lower, upper, step) {
  const values = []
  if (lower > upper) return values
  let i = origin
  for (;;) {
    const j = Math.abs(origin - i)
    if (!(origin - j >= lower || origin + j <= upper)) break
    values.push(i)
    const below = i <= origin
    const k = Math.abs(origin - i)
    const roomAbove = origin + k + step <= upper
    let next = origin + k + step
    if (!below || !roomAbove) {
      const candidate = origin - k - (below ? step : 0)
      if (candidate >= lower) next = candidate
    }
    i = next
  }
  return values
}

export function locateBiomes(sampler, dim, targets, from, options = {}) {
  const radius = options.radius ?? 6400
  const horizontalStep = options.horizontalStep ?? 32
  const verticalStep = options.verticalStep ?? 64
  const heights = outFromOrigin(from[1], dim.minY + 1, dim.minY + dim.height, verticalStep)
  const size = Math.floor(radius / horizontalStep)
  const total = (2 * size + 1) ** 2
  const remaining = new Set(targets)
  const found = new Map()
  let visited = 0
  for (const [sx, sz] of spiral(size)) {
    const x = from[0] + sx * horizontalStep
    const z = from[2] + sz * horizontalStep
    for (const y of heights) {
      const biome = sampler.biomeAt(x, y, z, false)
      if (remaining.has(biome)) {
        remaining.delete(biome)
        found.set(biome, { x, y, z, distance: Math.floor(Math.hypot(x - from[0], z - from[2])) })
      }
    }
    visited++
    if (visited % 2048 === 0) options.onProgress?.(visited / total)
    if (remaining.size === 0) break
  }
  return { found, heights, radius, horizontalStep }
}

export async function runLocate(session) {
  const { config, dim, packs } = session
  const locate = config.locate
  const { seed, label } = describeSeed(config.seed)
  const from = locate.from ?? [0, 64, 0]
  if (!Array.isArray(from) || from.length !== 3) throw new Error('"locate.from" must be [x, y, z], for example [0, 64, 0].')

  // Which biomes to look for: one id, a list, a #tag, or "all".
  const wanted = locate.biomes ?? locate.biome ?? 'all'
  let targets
  if (wanted === 'all') {
    targets = dim.biomes.map((_, i) => i)
  } else {
    targets = []
    for (const name of Array.isArray(wanted) ? wanted : [wanted]) {
      if (String(name).startsWith('#')) {
        const members = packs.biomeTag(name)
        const inDimension = dim.biomes.map((id, i) => (members.has(id) ? i : -1)).filter(i => i >= 0)
        if (inDimension.length === 0) console.log(`Note: tag ${name} contains no biome of ${dim.id}.`)
        targets.push(...inDimension)
      } else {
        const { indices, unknown } = resolveBiomeNames(dim.biomes, [name])
        if (unknown.length > 0) {
          throw new Error(`Biome "${name}" does not exist in ${dim.id}.\n  Biomes in this dimension: ${dim.biomes.join(', ')}`)
        }
        targets.push(...indices)
      }
    }
    targets = [...new Set(targets)]
  }

  console.log(`Seed: ${label}`)
  console.log(`Searching from X ${from[0]}, Y ${from[1]}, Z ${from[2]} for ${targets.length} biome${targets.length === 1 ? '' : 's'} (same method as /locate biome)`)
  const sampler = new WorldSampler(dim, seed)
  const progress = progressPrinter('Searching')
  const result = locateBiomes(sampler, dim, targets, from, {
    radius: locate.radius, horizontalStep: locate.horizontalStep, verticalStep: locate.verticalStep,
    onProgress: f => progress.update(f),
  })
  progress.done(`heights checked: Y ${result.heights.join(', ')}`)

  const rows = targets.map(i => ({ biome: dim.biomes[i], ...(result.found.get(i) ?? { notFound: true }) }))
  rows.sort((a, b) => (a.notFound ? 1e9 : a.distance) - (b.notFound ? 1e9 : b.distance) || a.biome.localeCompare(b.biome))
  const idWidth = Math.max(...rows.map(r => r.biome.length), 5)
  console.log('')
  console.log(`  ${'biome'.padEnd(idWidth)}  ${'x'.padStart(7)} ${'y'.padStart(5)} ${'z'.padStart(7)}  blocks away`)
  for (const row of rows) {
    if (row.notFound) console.log(`  ${row.biome.padEnd(idWidth)}  not found within ${result.radius} blocks`)
    else console.log(`  ${row.biome.padEnd(idWidth)}  ${String(row.x).padStart(7)} ${String(row.y).padStart(5)} ${String(row.z).padStart(7)}  ${row.distance}`)
  }

  const dimensionArg = normalizeId(dim.id)
  console.log('')
  console.log('To compare with your server, run this in-game or in the server console (replace the biome id):')
  console.log(`  /execute in ${dimensionArg} positioned ${from[0]} ${from[1]} ${from[2]} run locate biome <biome id>`)
  console.log('The game should answer with exactly the same X, Y, Z and "blocks away" as the table above.')

  const file = path.join(config.outputFolder, `locate_${safeName(dim.id)}_seed_${seed}.json`)
  fs.writeFileSync(file, JSON.stringify({
    tool: 'Seed Tester', dimension: dim.id, seed: seed.toString(), from,
    radius: result.radius, horizontalStep: result.horizontalStep, heightsChecked: result.heights,
    command: `/execute in ${dimensionArg} positioned ${from[0]} ${from[1]} ${from[2]} run locate biome <biome id>`,
    results: rows,
  }, null, 2))
  console.log(`Saved: ${relativeToCwd(file)}`)
  return rows
}
