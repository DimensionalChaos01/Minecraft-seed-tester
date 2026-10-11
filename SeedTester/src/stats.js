// Map statistics: ocean/land share, separate landmasses, biome areas.

import { shortName } from './palette.js'

/** Which biome indices count as water. Default: any biome with "ocean" in its id. */
export function waterMask(biomes, keywords = ['ocean']) {
  return biomes.map(id => keywords.some(k => id.toLowerCase().includes(String(k).toLowerCase())))
}

/** Matches a config biome name against a biome id: full id, or just the last part. */
export function biomeMatches(id, name) {
  name = String(name).toLowerCase()
  if (name.includes(':')) return id === name
  return id === `minecraft:${name}` || shortName(id) === name
}

/** Indices of the dimension biomes that a list of config names refers to. */
export function resolveBiomeNames(biomes, names) {
  const indices = new Set()
  const unknown = []
  for (const name of names) {
    let found = false
    biomes.forEach((id, i) => {
      if (biomeMatches(id, name)) {
        indices.add(i)
        found = true
      }
    })
    if (!found) unknown.push(name)
  }
  return { indices, unknown }
}

/**
 * grid: biome index per pixel (row-major, width x height).
 * view: { x0, z0, blocksPerPixel } - block coordinates of the top-left corner of the map.
 * origin: [x, z] point that "nearest land" and landmass distances are measured from.
 */
export function analyze(grid, width, height, view, biomes, isWater, origin = [0, 0]) {
  const bpp = view.blocksPerPixel
  const total = width * height
  const pixelKm2 = (bpp * bpp) / 1e6
  const counts = new Uint32Array(biomes.length)
  for (let i = 0; i < total; i++) counts[grid[i]]++

  let waterPixels = 0
  counts.forEach((n, i) => {
    if (isWater[i]) waterPixels += n
  })

  // Pixel centre -> block coordinates.
  const blockX = px => view.x0 + (px + 0.5) * bpp
  const blockZ = py => view.z0 + (py + 0.5) * bpp
  const originPx = (origin[0] - view.x0) / bpp - 0.5
  const originPy = (origin[1] - view.z0) / bpp - 0.5

  // Connected land areas (pixels touching along an edge).
  const labels = new Int32Array(total).fill(-1)
  const masses = []
  const stack = new Int32Array(total)
  let nearest = null
  for (let start = 0; start < total; start++) {
    if (labels[start] !== -1 || isWater[grid[start]]) continue
    const id = masses.length
    let top = 0
    stack[top++] = start
    labels[start] = id
    let pixels = 0
    let minX = width
    let maxX = -1
    let minY = height
    let maxY = -1
    let sumX = 0
    let sumY = 0
    let closest = Infinity
    let closestPx = 0
    let closestPy = 0
    let touchesEdge = false
    while (top > 0) {
      const p = stack[--top]
      const px = p % width
      const py = (p - px) / width
      pixels++
      sumX += px
      sumY += py
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
      if (px === 0 || py === 0 || px === width - 1 || py === height - 1) touchesEdge = true
      const d = (px - originPx) * (px - originPx) + (py - originPy) * (py - originPy)
      if (d < closest) {
        closest = d
        closestPx = px
        closestPy = py
      }
      if (px > 0 && labels[p - 1] === -1 && !isWater[grid[p - 1]]) { labels[p - 1] = id; stack[top++] = p - 1 }
      if (px < width - 1 && labels[p + 1] === -1 && !isWater[grid[p + 1]]) { labels[p + 1] = id; stack[top++] = p + 1 }
      if (py > 0 && labels[p - width] === -1 && !isWater[grid[p - width]]) { labels[p - width] = id; stack[top++] = p - width }
      if (py < height - 1 && labels[p + width] === -1 && !isWater[grid[p + width]]) { labels[p + width] = id; stack[top++] = p + width }
    }
    // Distance from the origin to the nearest edge of this landmass (0 if the origin is on it).
    const dxBlocks = Math.max(0, Math.abs(closestPx - originPx) - 0.5) * bpp
    const dzBlocks = Math.max(0, Math.abs(closestPy - originPy) - 0.5) * bpp
    const mass = {
      id,
      pixels,
      areaKm2: pixels * pixelKm2,
      boundingBox: {
        minX: Math.round(view.x0 + minX * bpp),
        maxX: Math.round(view.x0 + (maxX + 1) * bpp),
        minZ: Math.round(view.z0 + minY * bpp),
        maxZ: Math.round(view.z0 + (maxY + 1) * bpp),
      },
      center: [Math.round(blockX(sumX / pixels)), Math.round(blockZ(sumY / pixels))],
      distanceFromOrigin: Math.round(Math.hypot(dxBlocks, dzBlocks)),
      nearestPoint: [Math.round(blockX(closestPx)), Math.round(blockZ(closestPy))],
      touchesMapEdge: touchesEdge,
    }
    masses.push(mass)
    if (nearest === null || mass.distanceFromOrigin < nearest.distanceFromOrigin) nearest = mass
  }

  const biomeAreas = []
  counts.forEach((n, i) => {
    if (n > 0) biomeAreas.push({ biome: biomes[i], index: i, pixels: n, percent: (n / total) * 100, areaKm2: n * pixelKm2 })
  })
  biomeAreas.sort((a, b) => b.pixels - a.pixels)

  const originInside = originPx >= -0.5 && originPy >= -0.5 && originPx < width - 0.5 && originPy < height - 0.5
  let originBiome = null
  if (originInside) {
    const px = Math.min(width - 1, Math.max(0, Math.round(originPx)))
    const py = Math.min(height - 1, Math.max(0, Math.round(originPy)))
    originBiome = grid[py * width + px]
  }

  return {
    width,
    height,
    blocksPerPixel: bpp,
    mapAreaKm2: total * pixelKm2,
    oceanPercent: (waterPixels / total) * 100,
    landPercent: ((total - waterPixels) / total) * 100,
    landmassCount: masses.length,
    landmasses: [...masses].sort((a, b) => b.pixels - a.pixels),
    nearestLand: nearest && {
      x: nearest.nearestPoint[0],
      z: nearest.nearestPoint[1],
      distance: nearest.distanceFromOrigin,
      landmassAreaKm2: nearest.areaKm2,
    },
    origin,
    originBiome: originBiome === null ? null : biomes[originBiome],
    originIsLand: originBiome === null ? null : !isWater[originBiome],
    biomeAreas,
    labels,
  }
}

/** Biome indices present within `radius` blocks of the origin. */
export function biomesWithin(grid, width, height, view, origin, radius) {
  const bpp = view.blocksPerPixel
  const found = new Set()
  const r2 = radius * radius
  const px0 = Math.max(0, Math.floor((origin[0] - radius - view.x0) / bpp))
  const px1 = Math.min(width - 1, Math.ceil((origin[0] + radius - view.x0) / bpp))
  const py0 = Math.max(0, Math.floor((origin[1] - radius - view.z0) / bpp))
  const py1 = Math.min(height - 1, Math.ceil((origin[1] + radius - view.z0) / bpp))
  for (let py = py0; py <= py1; py++) {
    const dz = view.z0 + (py + 0.5) * bpp - origin[1]
    for (let px = px0; px <= px1; px++) {
      const dx = view.x0 + (px + 0.5) * bpp - origin[0]
      if (dx * dx + dz * dz <= r2) found.add(grid[py * width + px])
    }
  }
  return found
}

const round = (n, digits = 2) => Number(n.toFixed(digits))

/** The part of the stats that goes into the JSON file (no per-pixel data). */
export function statsToJson(stats, maxLandmasses = 10) {
  return {
    mapAreaKm2: round(stats.mapAreaKm2),
    oceanPercent: round(stats.oceanPercent),
    landPercent: round(stats.landPercent),
    landmassCount: stats.landmassCount,
    largestLandmasses: stats.landmasses.slice(0, maxLandmasses).map(m => ({
      areaKm2: round(m.areaKm2, 3),
      boundingBox: m.boundingBox,
      center: m.center,
      distanceFromOrigin: m.distanceFromOrigin,
      touchesMapEdge: m.touchesMapEdge,
    })),
    origin: stats.origin,
    biomeAtOrigin: stats.originBiome,
    originIsLand: stats.originIsLand,
    nearestLandToOrigin: stats.nearestLand && { ...stats.nearestLand, landmassAreaKm2: round(stats.nearestLand.landmassAreaKm2, 3) },
    biomes: stats.biomeAreas.map(b => ({ biome: b.biome, percent: round(b.percent, 3), areaKm2: round(b.areaKm2, 3) })),
  }
}
