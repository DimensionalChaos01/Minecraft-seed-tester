// Shared start-up for every mode: load the packs, describe what was found, start the workers.

import fs from 'node:fs'
import path from 'node:path'
import { appliedFixes } from './deepslate-fixes.js'
import { biomeColor } from './palette.js'
import { Pool, defaultThreadCount } from './pool.js'
import { parseSeed } from './seed.js'
import { waterMask } from './stats.js'
import { openWorld } from './world.js'

export function openSession(config, { workers = true } = {}) {
  const worldSpec = { datapacks: config.datapacks, dimension: config.dimension, vanilla: config.includeVanilla }
  const started = Date.now()
  const { packs, dim } = openWorld(worldSpec)

  console.log(`Datapacks (in load order): ${packs.packNames.join('  ->  ')}`)
  console.log(`Dimension: ${dim.id}  (from ${dim.pack})`)
  const detail = [`${dim.biomes.length} biomes`, `${dim.generatorType} generator`, `${dim.source.kind} biome source`]
  if (dim.source.kind === 'multi_noise') detail.push(`${dim.source.entryCount} parameter entries`)
  console.log(`  ${detail.join(', ')}`)
  console.log(`  world height: Y ${dim.minY} to ${dim.minY + dim.height - 1}, sea level ${dim.seaLevel}`)
  if (appliedFixes.length > 0) console.log(`  deepslate corrections applied: ${appliedFixes.join(', ')}`)
  for (const warning of config.warnings ?? []) console.log(`  Note: ${warning}`)

  const threads = Math.max(1, config.threads || defaultThreadCount())
  const pool = workers ? new Pool(worldSpec, threads) : null
  fs.mkdirSync(config.outputFolder, { recursive: true })

  return {
    config,
    packs,
    dim,
    pool,
    threads,
    loadMs: Date.now() - started,
    colors: dim.biomes.map(id => biomeColor(id, config.colors)),
    isWater: waterMask(dim.biomes, config.waterBiomes),
    // Climate noise ignores Y in vanilla-style dimensions; this only matters for "exact" layers.
    sampleY: config.y ?? dim.seaLevel + 1,
    async close() {
      await pool?.close()
    },
  }
}

/** Parses a seed and says so when text was turned into a number. */
export function describeSeed(value) {
  const seed = parseSeed(value)
  const text = String(value).trim()
  const note = typeof value === 'string' && text !== seed.toString() ? `  (from text "${text}")` : ''
  return { seed, label: `${seed}${note}` }
}

export function relativeToCwd(file) {
  const rel = path.relative(process.cwd(), file)
  return rel.startsWith('..') ? file : rel
}
