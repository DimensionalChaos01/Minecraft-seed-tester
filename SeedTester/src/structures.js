// Structure candidates for "random_spread" structure sets.
//
// Placement (salt, spacing, separation, spread type, frequency, frequency reduction method and
// exclusion zones) follows vanilla, using deepslate's implementation. A position is then kept if
// the surface biome at the chunk centre is in the structure's biome list. The game makes further
// checks while generating (terrain height, exact start position), so these are candidates.

import { Identifier, LegacyRandom, StructurePlacement, StructureSet } from 'deepslate'
import { normalizeId } from './packs.js'
import { shortName } from './palette.js'

function wanted(filter, setId, structureIds) {
  if (filter === true || filter === undefined) return true
  const names = (Array.isArray(filter) ? filter : [filter]).map(n => String(n).toLowerCase())
  // A full id must match exactly; a bare word matches any id containing it, so "village" covers
  // village_plains, village_desert and so on.
  const matches = id => names.some(n => (n.includes(':') ? id === n : shortName(id).includes(n)))
  return matches(setId) || structureIds.some(matches)
}

export function prepareStructures(packs, dim, filter = true) {
  StructureSet.REGISTRY.clear()
  for (const id of packs.ids('worldgen/structure_set')) {
    // Registered so that exclusion zones ("not within N chunks of another set") can look them up.
    StructureSet.REGISTRY.register(Identifier.parse(id), () => StructureSet.fromJson(packs.json('worldgen/structure_set', id)))
  }

  const dimBiomes = new Map(dim.biomes.map((b, i) => [b, i]))
  const sets = []
  const skipped = []
  for (const setId of packs.ids('worldgen/structure_set').sort()) {
    const json = packs.json('worldgen/structure_set', setId)
    const placementType = normalizeId(json.placement?.type ?? '').replace(/^minecraft:/, '')
    const entries = []
    for (const entry of json.structures ?? []) {
      const structureId = normalizeId(entry.structure)
      const structure = packs.json('worldgen/structure', structureId)
      if (!structure) continue
      // Biome indices of this dimension in which the structure may generate.
      const allowed = new Set()
      for (const biome of packs.biomeSet(structure.biomes ?? [])) {
        if (dimBiomes.has(biome)) allowed.add(dimBiomes.get(biome))
      }
      entries.push({ id: structureId, weight: entry.weight ?? 1, allowed })
    }
    // A set whose structures cannot generate in any biome of this dimension never appears here.
    if (!entries.some(e => e.allowed.size > 0)) continue
    if (!wanted(filter, setId, entries.map(e => e.id))) continue
    if (placementType !== 'random_spread') {
      skipped.push({ set: setId, reason: `placement type "${placementType}" is not supported` })
      continue
    }
    const offset = json.placement.locate_offset ?? [0, 0, 0]
    sets.push({ id: setId, entries, placement: StructurePlacement.fromJson(json.placement), locateOffset: offset })
  }
  return { sets, skipped }
}

/**
 * Finds candidates inside a block rectangle.
 * biomeAt(x, z) must return the surface biome index at a block position.
 */
export function findStructures(prepared, seed, bounds, biomeAt) {
  const { minX, maxX, minZ, maxZ } = bounds
  const candidates = []
  for (const set of prepared.sets) {
    const chunks = set.placement.getPotentialStructureChunks(seed, minX >> 4, minZ >> 4, maxX >> 4, maxZ >> 4)
    for (const [chunkX, chunkZ] of chunks) {
      const x = chunkX * 16 + set.locateOffset[0]
      const z = chunkZ * 16 + set.locateOffset[2]
      if (x < minX || x >= maxX || z < minZ || z >= maxZ) continue
      if (!set.placement.isStructureChunk(seed, chunkX, chunkZ)) continue
      const biome = biomeAt(chunkX * 16 + 8, chunkZ * 16 + 8)

      // Vanilla picks among a set's structures by weight and falls through to the next one when
      // the pick cannot generate here.
      let chosen = null
      if (set.entries.length === 1) {
        if (set.entries[0].allowed.has(biome)) chosen = set.entries[0]
      } else {
        const random = LegacyRandom.fromLargeFeatureSeed(seed, chunkX, chunkZ)
        const list = [...set.entries]
        let totalWeight = list.reduce((sum, e) => sum + e.weight, 0)
        while (list.length > 0 && totalWeight > 0) {
          let pick = random.nextInt(totalWeight)
          let index = 0
          for (; index < list.length; index++) {
            pick -= list[index].weight
            if (pick < 0) break
          }
          index = Math.min(index, list.length - 1)
          const entry = list[index]
          if (entry.allowed.has(biome)) {
            chosen = entry
            break
          }
          list.splice(index, 1)
          totalWeight -= entry.weight
        }
      }
      if (chosen) candidates.push({ set: set.id, structure: chosen.id, x, z, chunkX, chunkZ, biome })
    }
  }
  return candidates
}
