// Turns loaded datapacks into something that can be sampled: registers noises and density functions
// with deepslate, resolves a dimension, and samples biomes / surface heights for a seed.

import {
  DensityFunction, Identifier, NoiseGeneratorSettings, NoiseParameters, RandomState, WorldgenRegistries,
} from 'deepslate'
import './deepslate-fixes.js'
import { PackSet, normalizeId, readPreset } from './packs.js'
import { ClimateTree, quantize } from './tree.js'

const stripNs = id => normalizeId(id).replace(/^minecraft:/, '')

/** Registers every noise and density function. Vanilla first, then each pack; later packs win. */
export function registerWorldgen(packs) {
  WorldgenRegistries.NOISE.clear()
  WorldgenRegistries.DENSITY_FUNCTION.clear()
  for (const id of packs.ids('worldgen/noise')) {
    WorldgenRegistries.NOISE.register(Identifier.parse(id), NoiseParameters.fromJson(packs.json('worldgen/noise', id)))
  }
  for (const id of packs.ids('worldgen/density_function')) {
    WorldgenRegistries.DENSITY_FUNCTION.register(
      Identifier.parse(id),
      () => DensityFunction.fromJson(packs.json('worldgen/density_function', id)),
    )
  }
}

function resolveMultiNoiseEntries(packs, source, dimensionId) {
  if (Array.isArray(source.biomes)) return source.biomes
  if (typeof source.preset === 'string') {
    // "preset" points at a parameter list, and vanilla's parameter lists only contain another
    // preset name, so the actual numbers come from the lists bundled with this tool.
    const listJson = packs.json('worldgen/multi_noise_biome_source_parameter_list', source.preset)
    const presetName = stripNs(listJson?.preset ?? source.preset)
    const entries = readPreset(presetName)
    if (!entries) {
      throw new Error(`Dimension ${dimensionId} uses biome preset "${source.preset}", which this tool has no data for (known: overworld, nether).`)
    }
    return entries
  }
  throw new Error(`Dimension ${dimensionId}: the multi_noise biome source has neither "biomes" nor "preset".`)
}

const END_BIOMES = ['minecraft:the_end', 'minecraft:end_highlands', 'minecraft:end_midlands', 'minecraft:small_end_islands', 'minecraft:end_barrens']

export function listDimensions(packs) {
  return packs.ids('dimension').sort()
}

export function loadDimension(packs, dimensionId) {
  dimensionId = normalizeId(dimensionId)
  const json = packs.json('dimension', dimensionId)
  if (!json) {
    throw new Error(`Dimension "${dimensionId}" was not found in the loaded datapacks.\n  Available dimensions: ${listDimensions(packs).join(', ') || '(none)'}`)
  }

  const typeJson = typeof json.type === 'string' ? packs.json('dimension_type', json.type) : json.type
  const generator = json.generator ?? {}
  const generatorType = stripNs(generator.type ?? 'noise')

  const dim = {
    id: dimensionId,
    pack: packs.source('dimension', dimensionId),
    generatorType,
    settingsId: null,
    settings: null,
    seaLevel: 63,
    minY: typeJson?.min_y ?? -64,
    height: typeJson?.height ?? 384,
    biomes: [],
    source: null,
  }

  let biomeSource
  if (generatorType === 'noise') {
    let settingsJson = generator.settings
    if (typeof settingsJson === 'string') {
      dim.settingsId = normalizeId(settingsJson)
      settingsJson = packs.json('worldgen/noise_settings', settingsJson)
      if (!settingsJson) throw new Error(`Dimension ${dimensionId} uses noise settings "${dim.settingsId}", which no loaded pack provides.`)
    }
    dim.settings = NoiseGeneratorSettings.fromJson(settingsJson)
    dim.seaLevel = settingsJson.sea_level ?? 63
    dim.noiseMinY = settingsJson.noise?.min_y ?? dim.minY
    dim.noiseHeight = settingsJson.noise?.height ?? dim.height
    biomeSource = generator.biome_source ?? {}
  } else if (generatorType === 'flat') {
    biomeSource = { type: 'fixed', biome: generator.settings?.biome ?? 'minecraft:plains' }
  } else if (generatorType === 'debug') {
    biomeSource = { type: 'fixed', biome: 'minecraft:plains' }
  } else {
    throw new Error(`Dimension ${dimensionId} uses generator type "${generatorType}", which is not supported.`)
  }

  const sourceType = stripNs(biomeSource.type ?? 'multi_noise')
  if (sourceType === 'multi_noise') {
    const entries = resolveMultiNoiseEntries(packs, biomeSource, dimensionId)
    dim.biomes = [...new Set(entries.map(e => normalizeId(e.biome)))].sort()
    const index = new Map(dim.biomes.map((b, i) => [b, i]))
    dim.source = {
      kind: 'multi_noise',
      entryCount: entries.length,
      tree: new ClimateTree(entries.map(e => ({ parameters: e.parameters, value: index.get(normalizeId(e.biome)) }))),
    }
  } else if (sourceType === 'fixed') {
    dim.biomes = [normalizeId(biomeSource.biome ?? 'minecraft:plains')]
    dim.source = { kind: 'fixed' }
  } else if (sourceType === 'checkerboard') {
    const list = [...packs.biomeSet(biomeSource.biomes ?? [])]
    if (list.length === 0) throw new Error(`Dimension ${dimensionId}: the checkerboard biome source lists no biomes.`)
    dim.biomes = [...new Set(list)].sort()
    const index = new Map(dim.biomes.map((b, i) => [b, i]))
    dim.source = { kind: 'checkerboard', order: list.map(b => index.get(b)), shift: (biomeSource.scale ?? 2) + 2 }
  } else if (sourceType === 'the_end') {
    if (!dim.settings) throw new Error(`Dimension ${dimensionId}: the_end biome source needs a noise generator.`)
    dim.biomes = [...END_BIOMES].sort()
    dim.source = { kind: 'the_end', index: Object.fromEntries(dim.biomes.map((b, i) => [stripNs(b), i])) }
  } else {
    throw new Error(`Dimension ${dimensionId} uses biome source "${sourceType}", which is not supported.`)
  }
  dim.needsNoise = dim.source.kind === 'multi_noise' || dim.source.kind === 'the_end'
  return dim
}

/** Loads packs + dimension in one go (used by the main thread and by every worker). */
export function openWorld({ datapacks, dimension, vanilla = true, extra = [] }) {
  const packs = PackSet.load(datapacks, { vanilla, extra })
  registerWorldgen(packs)
  const dim = loadDimension(packs, dimension)
  return { packs, dim }
}

function collectInterpolated(root) {
  const found = []
  const seen = new Set()
  const stack = [root]
  while (stack.length > 0) {
    const obj = stack.pop()
    if (obj === null || typeof obj !== 'object' || seen.has(obj)) continue
    seen.add(obj)
    if (ArrayBuffer.isView(obj)) continue
    if (obj instanceof DensityFunction.Interpolated) found.push(obj)
    for (const key of Object.keys(obj)) {
      const value = obj[key]
      if (value !== null && typeof value === 'object') stack.push(value)
    }
  }
  return found
}

/** Samples one dimension for one seed. */
export class WorldSampler {
  constructor(dim, seed) {
    this.dim = dim
    this.seed = BigInt.asIntN(64, BigInt(seed))
    this.ctx = { x: 0, y: 0, z: 0 }
    this.random = null
    this.interpolated = null
    if (dim.settings) {
      this.random = new RandomState(dim.settings, this.seed)
      this.router = this.random.router
    }
  }

  /**
   * Biome index (into dim.biomes) at a block position.
   * surface=true forces depth to 0, which picks the surface biome and keeps cave biomes off the map.
   * surface=false uses the real depth at y, which is what the game does at that exact position.
   */
  biomeAt(x, y, z, surface) {
    const source = this.dim.source
    switch (source.kind) {
      case 'multi_noise': {
        // Biomes are stored per 4x4x4 cell; the game samples the climate at the cell's corner.
        const ctx = this.ctx
        ctx.x = (x >> 2) << 2
        ctx.y = (y >> 2) << 2
        ctx.z = (z >> 2) << 2
        const r = this.router
        return source.tree.find(
          quantize(r.temperature.compute(ctx)),
          quantize(r.vegetation.compute(ctx)),
          quantize(r.continents.compute(ctx)),
          quantize(r.erosion.compute(ctx)),
          surface ? 0 : quantize(r.depth.compute(ctx)),
          quantize(r.ridges.compute(ctx)),
        )
      }
      case 'fixed':
        return 0
      case 'checkerboard': {
        const n = source.order.length
        const i = ((x >> 2) >> source.shift) + ((z >> 2) >> source.shift)
        return source.order[((i % n) + n) % n]
      }
      case 'the_end': {
        const sectionX = x >> 4
        const sectionZ = z >> 4
        if (sectionX * sectionX + sectionZ * sectionZ <= 4096) return source.index.the_end
        const ctx = this.ctx
        ctx.x = (sectionX * 2 + 1) * 8
        ctx.y = (y >> 2) << 2
        ctx.z = (sectionZ * 2 + 1) * 8
        const erosion = this.router.erosion.compute(ctx)
        if (erosion > 0.25) return source.index.end_highlands
        if (erosion >= -0.0625) return source.index.end_midlands
        if (erosion >= -0.21875) return source.index.end_barrens
        return source.index.small_end_islands
      }
    }
    return 0
  }

  /** Raw climate values at a block position (for debugging and the accuracy report). */
  climateAt(x, y, z) {
    const ctx = { x: (x >> 2) << 2, y: (y >> 2) << 2, z: (z >> 2) << 2 }
    const r = this.router
    return {
      temperature: r.temperature.compute(ctx),
      humidity: r.vegetation.compute(ctx),
      continentalness: r.continents.compute(ctx),
      erosion: r.erosion.compute(ctx),
      depth: r.depth.compute(ctx),
      weirdness: r.ridges.compute(ctx),
    }
  }

  /**
   * Y of the highest solid block in a column, found by scanning final_density from the top down
   * (4-block steps, then refined to 1 block). Ignores features, structures and the surface rule,
   * so expect it to be a block or two off. A column that caves cut through completely has no
   * solid noise block at all; in the game only bedrock closes it, so it is reported as minY.
   */
  surfaceHeightAt(x, z) {
    const dim = this.dim
    if (!this.router) return dim.seaLevel
    if (this.interpolated === null) this.interpolated = collectInterpolated(this.router.finalDensity)
    const density = this.router.finalDensity
    const ctx = this.ctx
    ctx.x = x
    ctx.z = z
    const minY = dim.noiseMinY
    const top = minY + dim.noiseHeight - 1
    let result = minY
    for (let y = top; y >= minY; y -= 4) {
      ctx.y = y
      if (density.compute(ctx) > 0) {
        result = y
        for (let fine = Math.min(top, y + 3); fine > y; fine--) {
          ctx.y = fine
          if (density.compute(ctx) > 0) {
            result = fine
            break
          }
        }
        break
      }
    }
    // deepslate caches every interpolation corner forever; keep that from eating all the memory.
    for (const fn of this.interpolated) {
      if (fn.values.size > 4096) fn.values.clear()
    }
    return result
  }
}
