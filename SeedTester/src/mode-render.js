// Mode "render": one seed -> biome map PNG + stats JSON.

import fs from 'node:fs'
import path from 'node:path'
import { safeName, viewFor } from './config.js'
import { colorSource } from './palette.js'
import { progressPrinter } from './pool.js'
import { renderMap, upsampleHeights } from './render.js'
import { describeSeed, relativeToCwd } from './session.js'
import { analyze, statsToJson } from './stats.js'
import { findStructures, prepareStructures } from './structures.js'
import { WorldSampler } from './world.js'

export function mapTitle(session, seed) {
  return `${session.dim.id}   seed ${seed}`
}

export function mapSubtitle(session, width, height, view) {
  const bpp = view.blocksPerPixel
  const layer = session.config.surface ? 'surface biomes' : `biomes at Y ${session.sampleY}`
  return `${Math.round(width * bpp)} x ${Math.round(height * bpp)} blocks, 1 pixel = ${bpp} block${bpp === 1 ? '' : 's'}, ${layer}, Minecraft 1.20.1`
}

export async function runRender(session) {
  const { config, dim, pool } = session
  const { seed, label } = describeSeed(config.seed)
  const { width, height, view } = viewFor(config.center, config.size, config.blocksPerPixel)
  console.log(`Seed: ${label}`)
  console.log(`Map: ${width} x ${height} pixels, centred on ${config.center[0]}, ${config.center[1]}, ${view.blocksPerPixel} blocks per pixel, ${session.threads} threads`)
  if (width * height > 64e6) throw new Error('That map would be larger than 64 million pixels. Raise "blocksPerPixel" or lower "size".')

  await pool.ready
  const seedText = seed.toString()

  // ---- biomes ----------------------------------------------------------------------------
  let progress = progressPrinter('Sampling biomes')
  const started = Date.now()
  const grid = await pool.sampleGrid('biomes', {
    seed: seedText, x0: view.x0, z0: view.z0, width, height, blocksPerPixel: view.blocksPerPixel,
    y: session.sampleY, surface: config.surface,
  }, f => progress.update(f))
  const seconds = (Date.now() - started) / 1000
  progress.done(`${Math.round((width * height) / Math.max(seconds, 0.001)).toLocaleString('en-US')} samples per second`)

  const stats = analyze(grid, width, height, view, dim.biomes, session.isWater, [0, 0])

  // ---- relief (optional, slow) -----------------------------------------------------------
  let heights = null
  let heightSummary = null
  if (config.relief.enabled) {
    if (!dim.settings) {
      console.log('Relief: skipped, this dimension has no noise terrain.')
    } else {
      const detail = config.relief.detail
      const cw = Math.ceil(width / detail)
      const ch = Math.ceil(height / detail)
      progress = progressPrinter(`Sampling terrain height (${cw} x ${ch})`)
      const coarse = await pool.sampleGrid('heights', {
        seed: seedText, x0: view.x0, z0: view.z0, width: cw, height: ch, blocksPerPixel: view.blocksPerPixel * detail,
      }, f => progress.update(f))
      progress.done()
      let min = Infinity
      let max = -Infinity
      let sum = 0
      let wet = 0
      for (const h of coarse) {
        if (h < min) min = h
        if (h > max) max = h
        sum += h
        if (h < dim.seaLevel - 1) wet++
      }
      heightSummary = { min, max, mean: Number((sum / coarse.length).toFixed(1)), belowSeaLevelPercent: Number(((wet / coarse.length) * 100).toFixed(2)) }
      heights = upsampleHeights(coarse, cw, ch, width, height)
    }
  }

  // ---- structures (optional) -------------------------------------------------------------
  let structures = null
  let structureIds = null
  let structureInfo = null
  if (config.structures) {
    const prepared = prepareStructures(session.packs, dim, config.structures)
    const sampler = new WorldSampler(dim, seed)
    const bounds = { minX: Math.floor(view.x0), maxX: Math.ceil(view.x0 + width * view.blocksPerPixel), minZ: Math.floor(view.z0), maxZ: Math.ceil(view.z0 + height * view.blocksPerPixel) }
    structures = findStructures(prepared, seed, bounds, (x, z) => sampler.biomeAt(x, session.sampleY, z, true))
    // Only structures that actually turned up get a marker colour and a legend line.
    structureIds = [...new Set(structures.map(s => s.structure))].sort()
    structureInfo = { prepared, bounds, possible: [...new Set(prepared.sets.flatMap(s => s.entries.filter(e => e.allowed.size > 0).map(e => e.id)))].sort() }
    console.log(`Structures: ${structures.length} candidates of ${structureIds.length} kinds (${prepared.sets.length} structure sets can generate in this dimension)`)
    for (const skip of prepared.skipped) console.log(`  skipped ${skip.set}: ${skip.reason}`)
  }

  // ---- output ----------------------------------------------------------------------------
  const base = config.outputName ?? `${safeName(dim.id)}_seed_${seedText}`
  const pngFile = path.join(config.outputFolder, `${base}.png`)
  const jsonFile = path.join(config.outputFolder, `${base}.json`)

  const canvas = renderMap(
    { grid, width, height, view, biomes: dim.biomes, colors: session.colors },
    {
      title: mapTitle(session, seedText),
      subtitle: mapSubtitle(session, width, height, view),
      footer: 'Seed Tester - red ring marks 0,0 - north is up',
      stats, heights, heightSummary, seaLevel: dim.seaLevel,
      structures, structureIds,
      grid: config.grid, legend: config.legend,
    },
  )
  canvas.save(pngFile)

  const json = {
    tool: 'Seed Tester',
    minecraftVersion: '1.20.1',
    dimension: dim.id,
    datapacks: session.packs.packNames,
    seed: seedText,
    seedInput: config.seed,
    center: config.center,
    sizeBlocks: [width * view.blocksPerPixel, height * view.blocksPerPixel],
    blocksPerPixel: view.blocksPerPixel,
    biomeLayer: config.surface ? 'surface' : `exact at y=${session.sampleY}`,
    seaLevel: dim.seaLevel,
    ...statsToJson(stats),
  }
  json.biomes = json.biomes.map(b => ({ ...b, colorFrom: colorSource(b.biome, config.colors) }))
  if (heightSummary) json.terrainHeight = heightSummary
  if (structures) {
    json.structureCandidates = {
      note: 'Candidates only: placement and biome were checked, terrain checks in the game can still reject some.',
      skippedSets: structureInfo.prepared.skipped,
      counts: Object.fromEntries(structureInfo.possible.map(id => [id, structures.filter(s => s.structure === id).length])),
      positions: structures
        .map(s => ({ structure: s.structure, x: s.x, z: s.z, biome: dim.biomes[s.biome], distanceFromOrigin: Math.round(Math.hypot(s.x, s.z)) }))
        .sort((a, b) => a.distanceFromOrigin - b.distanceFromOrigin),
    }
  }
  fs.writeFileSync(jsonFile, JSON.stringify(json, null, 2))

  // ---- console summary -------------------------------------------------------------------
  console.log('')
  console.log(`Ocean ${stats.oceanPercent.toFixed(1)}%, land ${stats.landPercent.toFixed(1)}%, ${stats.landmassCount} separate landmass${stats.landmassCount === 1 ? '' : 'es'}`)
  stats.landmasses.slice(0, 3).forEach((m, i) => {
    const box = m.boundingBox
    console.log(`  #${i + 1}: ${m.areaKm2.toFixed(2)} km², X ${box.minX}..${box.maxX}, Z ${box.minZ}..${box.maxZ}${m.touchesMapEdge ? ' (continues beyond the map)' : ''}`)
  })
  if (stats.originBiome) console.log(`Biome at 0,0: ${stats.originBiome}`)
  if (stats.nearestLand) {
    console.log(stats.originIsLand ? 'There is land at 0,0.' : `Nearest land to 0,0: ${stats.nearestLand.distance} blocks away, at ${stats.nearestLand.x}, ${stats.nearestLand.z}`)
  } else {
    console.log('No land anywhere on this map.')
  }
  const generated = stats.biomeAreas.filter(b => colorSource(b.biome, config.colors) === 'generated').map(b => b.biome)
  if (generated.length > 0) console.log(`Biomes with no built-in colour (auto-coloured): ${generated.join(', ')}`)
  console.log('')
  console.log(`Map:   ${relativeToCwd(pngFile)}`)
  console.log(`Stats: ${relativeToCwd(jsonFile)}`)
  return { pngFile, jsonFile, stats }
}
