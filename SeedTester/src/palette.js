// Biome colours. Vanilla biomes get fixed colours; a custom biome whose id ends in a vanilla name
// (delta:plains, mypack:cold/taiga) borrows that colour; anything else gets a stable colour
// derived from its id, so it looks the same in every render.

const VANILLA = {
  // oceans and rivers
  ocean: '000070', deep_ocean: '000030', warm_ocean: '0000ac', lukewarm_ocean: '000090',
  deep_lukewarm_ocean: '000040', cold_ocean: '202070', deep_cold_ocean: '202038',
  frozen_ocean: '7070d6', deep_frozen_ocean: '404090', river: '0000ff', frozen_river: 'a0a0ff',
  // coasts
  beach: 'fade55', snowy_beach: 'faf0c0', stony_shore: 'a2a284', mushroom_fields: 'ff00ff',
  // flat and temperate
  plains: '8db360', sunflower_plains: 'b5db88', meadow: '60a445', cherry_grove: 'ff91c8',
  forest: '056621', flower_forest: '2d8e49', birch_forest: '307444', old_growth_birch_forest: '589c6c',
  dark_forest: '40511a', swamp: '07f9b2', mangrove_swamp: '2ccc8e',
  // cold
  snowy_plains: 'ffffff', ice_spikes: 'b4dcdc', taiga: '0b6659', snowy_taiga: '31554a',
  old_growth_pine_taiga: '596651', old_growth_spruce_taiga: '818e79', grove: '47726c',
  snowy_slopes: 'c4c4c4', frozen_peaks: 'b0b3ce', jagged_peaks: 'dcdcc8', stony_peaks: '7b8f74',
  windswept_hills: '606060', windswept_gravelly_hills: '888888', windswept_forest: '5b7352',
  // warm and dry
  desert: 'fa9418', savanna: 'bdb25f', savanna_plateau: 'a79d64', windswept_savanna: 'e5da87',
  jungle: '537b09', sparse_jungle: '628b17', bamboo_jungle: '768e14',
  badlands: 'd94515', eroded_badlands: 'ff6d3d', wooded_badlands: 'b09765',
  // underground
  dripstone_caves: '4e3012', lush_caves: '283c00', deep_dark: '031f29',
  // nether
  nether_wastes: '572526', soul_sand_valley: '4d3a2e', crimson_forest: '981a11',
  warped_forest: '49907b', basalt_deltas: '645f63',
  // end
  the_end: '8080ff', small_end_islands: '4b4bab', end_midlands: 'c9c959', end_highlands: 'b5b536',
  end_barrens: '7070cc', the_void: '000000',
}

export function parseColor(text) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(text).trim())
  if (!m) throw new Error(`"${text}" is not a colour. Use the form "#rrggbb".`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function hslToRgb(h, s, l) {
  const f = n => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [f(0), f(8), f(4)]
}

function hashColor(id) {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return hslToRgb(h % 360, 0.45 + ((h >>> 9) % 40) / 100, 0.4 + ((h >>> 17) % 30) / 100)
}

/** Last part of a biome id: "delta:cold/taiga" -> "taiga". */
export function shortName(id) {
  return id.slice(Math.max(id.lastIndexOf(':'), id.lastIndexOf('/')) + 1)
}

export function biomeColor(id, overrides = {}) {
  const override = overrides[id] ?? overrides[shortName(id)]
  if (override) return parseColor(override)
  const known = VANILLA[shortName(id)]
  return known ? parseColor(known) : hashColor(id)
}

/** How a colour was chosen, for the stats file. */
export function colorSource(id, overrides = {}) {
  if (overrides[id] ?? overrides[shortName(id)]) return 'config'
  return VANILLA[shortName(id)] ? 'built-in' : 'generated'
}

export const STRUCTURE_COLORS = [
  [255, 255, 255], [255, 235, 59], [255, 64, 255], [0, 229, 255], [255, 145, 0], [118, 255, 3],
  [255, 82, 82], [179, 136, 255], [255, 171, 145], [29, 233, 182], [240, 98, 146], [158, 158, 158],
]
