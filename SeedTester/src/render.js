// Composes the final picture: biome map, optional relief shading, gridlines with coordinates,
// the red ring at 0,0, structure markers and the legend.

import { Canvas, GLYPH_H, textWidth } from './image.js'
import { STRUCTURE_COLORS, shortName } from './palette.js'

const BLACK = [0, 0, 0]
const DARK = [40, 40, 40]
const GREY = [110, 110, 110]
const RED = [230, 0, 0]
const WHITE = [255, 255, 255]
const PAPER = [246, 246, 243]

/** A round number near `raw`: 1, 2 or 5 times a power of ten. */
function niceStep(raw) {
  const power = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))))
  const fraction = raw / power
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power
}

/** Biome names for the legend: drop the namespace when it adds nothing. */
export function displayNames(ids) {
  const namespaces = new Set(ids.map(id => id.split(':')[0]))
  return ids.map(id => (namespaces.size === 1 || id.startsWith('minecraft:') ? id.slice(id.indexOf(':') + 1) : id))
}

/** Stretches a coarse height grid to the map's resolution (bilinear). */
export function upsampleHeights(coarse, cw, ch, width, height) {
  if (cw === width && ch === height) return Float32Array.from(coarse)
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const fy = Math.min(ch - 1, Math.max(0, ((y + 0.5) * ch) / height - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(ch - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < width; x++) {
      const fx = Math.min(cw - 1, Math.max(0, ((x + 0.5) * cw) / width - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(cw - 1, x0 + 1)
      const tx = fx - x0
      const top = coarse[y0 * cw + x0] * (1 - tx) + coarse[y0 * cw + x1] * tx
      const bottom = coarse[y1 * cw + x0] * (1 - tx) + coarse[y1 * cw + x1] * tx
      out[y * width + x] = top * (1 - ty) + bottom * ty
    }
  }
  return out
}

/** Marker i of the legend: 12 colours as diamonds, then the same colours again as squares. */
function drawMarker(canvas, cx, cy, r, index) {
  const color = STRUCTURE_COLORS[index % STRUCTURE_COLORS.length]
  const square = Math.floor(index / STRUCTURE_COLORS.length) % 2 === 1
  if (square) r -= 1
  for (let dy = -r - 1; dy <= r + 1; dy++) {
    for (let dx = -r - 1; dx <= r + 1; dx++) {
      const d = square ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.abs(dx) + Math.abs(dy)
      if (d <= r) canvas.setPixel(cx + dx, cy + dy, color)
      else if (d === r + 1) canvas.setPixel(cx + dx, cy + dy, BLACK)
    }
  }
}

/**
 * map: { grid, width, height, view: {x0, z0, blocksPerPixel}, biomes, colors }
 * extras: { title, subtitle, footer, stats, heights (Float32Array at map resolution), seaLevel,
 *           structures: [{structure, x, z}], grid: true|false|spacing, legend, zoom, ring }
 */
export function renderMap(map, extras = {}) {
  const { grid, width, height, view, biomes, colors } = map
  const bpp = view.blocksPerPixel
  const zoom = extras.zoom ?? (Math.max(width, height) < 420 ? Math.ceil(560 / Math.max(width, height)) : 1)
  const mapW = width * zoom
  const mapH = height * zoom
  const scale = mapH >= 440 ? 2 : 1
  const lineH = GLYPH_H * scale + 5
  const showGrid = extras.grid !== false
  const showLegend = extras.legend !== false

  // ---- gridlines -------------------------------------------------------------------------
  const spanX = width * bpp
  const spanZ = height * bpp
  const longestLabel = Math.max(
    String(Math.round(view.x0)).length, String(Math.round(view.x0 + spanX)).length,
    String(Math.round(view.z0)).length, String(Math.round(view.z0 + spanZ)).length,
  )
  const labelW = textWidth('0'.repeat(longestLabel), scale)
  let spacing = typeof extras.grid === 'number' && extras.grid > 0 ? extras.grid : 0
  if (!spacing) {
    const lines = Math.max(2, Math.min(10, Math.floor(mapW / (labelW * 1.7))))
    spacing = niceStep(spanX / lines)
  }

  // ---- legend content --------------------------------------------------------------------
  const names = displayNames(biomes)
  const rows = []
  const stats = extras.stats
  if (showLegend && stats) {
    rows.push({ header: 'SUMMARY' })
    rows.push({ text: `Ocean ${stats.oceanPercent.toFixed(1)}%   Land ${stats.landPercent.toFixed(1)}%` })
    rows.push({ text: `Landmasses: ${stats.landmassCount}` })
    if (stats.landmasses.length > 0) {
      const largest = stats.landmasses[0]
      rows.push({ text: `Largest: ${largest.areaKm2.toFixed(largest.areaKm2 < 10 ? 2 : 1)} km²${largest.touchesMapEdge ? ' (cut off)' : ''}` })
    }
    if (stats.originBiome) {
      rows.push({ text: `At ${stats.origin[0]},${stats.origin[1]}: ${names[biomes.indexOf(stats.originBiome)]}` })
    }
    if (stats.nearestLand && stats.originIsLand === false) {
      rows.push({ text: `Nearest land: ${stats.nearestLand.distance} blocks` })
      rows.push({ text: `  at ${stats.nearestLand.x},${stats.nearestLand.z}` })
    }
    if (extras.heightSummary) {
      rows.push({ gap: true })
      rows.push({ header: 'RELIEF' })
      rows.push({ text: `Height ${extras.heightSummary.min}..${extras.heightSummary.max}, sea level ${extras.seaLevel}` })
      rows.push({ text: `Dark line = sea level` })
    }
    const structures = extras.structures ?? []
    if (extras.structureIds?.length) {
      rows.push({ gap: true })
      rows.push({ header: 'STRUCTURES  (candidates)' })
      extras.structureIds.forEach((id, i) => {
        const count = structures.filter(s => s.structure === id).length
        // Two packs can both define e.g. pillager_outpost; show the namespace when names clash.
        const clash = extras.structureIds.some(other => other !== id && shortName(other) === shortName(id))
        rows.push({ marker: i, text: `${clash ? id : shortName(id)}  x${count}` })
      })
    }
    rows.push({ gap: true })
    rows.push({ header: 'BIOMES  (% of map)' })
    for (const area of stats.biomeAreas) {
      const pct = area.percent < 0.05 ? '<0.1' : area.percent >= 9.95 ? area.percent.toFixed(0) : area.percent.toFixed(1)
      rows.push({ swatch: colors[area.index], text: `${names[area.index]}  ${pct}%` })
    }
  }

  // ---- layout ----------------------------------------------------------------------------
  const left = showGrid ? labelW + 12 : 10
  const titleH = (extras.title ? GLYPH_H * 2 + 6 : 0) + (extras.subtitle ? GLYPH_H + 5 : 0)
  const top = 8 + titleH + (showGrid ? GLYPH_H * scale + 6 : 2)
  const footerH = extras.footer ? GLYPH_H + 8 : 0
  const bottom = 10 + footerH + (showGrid ? GLYPH_H * scale + 4 : 0)

  const swatch = GLYPH_H * scale
  const rowsPerColumn = Math.max(4, Math.floor(mapH / lineH))
  const columns = [[]]
  rows.forEach((row, i) => {
    let column = columns[columns.length - 1]
    // Start a new column when this one is full, and never leave a heading alone at the bottom.
    const headingAtBottom = row.header && column.length >= rowsPerColumn - 1 && i < rows.length - 1
    if (column.length >= rowsPerColumn || headingAtBottom) columns.push((column = []))
    if (row.gap && column.length === 0) return
    column.push(row)
  })
  if (columns[0].length === 0) columns.length = 0
  const columnWidths = columns.map(col => Math.max(...col.map(r => (r.header ? textWidth(r.header, scale) : textWidth(r.text ?? '', scale) + (r.swatch || r.marker !== undefined ? swatch + 6 : 0)))) + 18)
  const legendW = columns.length > 0 ? columnWidths.reduce((a, b) => a + b, 0) + 6 : 0

  const minWidth = Math.max(extras.title ? textWidth(extras.title, 2) : 0, extras.subtitle ? textWidth(extras.subtitle, 1) : 0, extras.footer ? textWidth(extras.footer, 1) : 0) + 20
  const tallestColumn = Math.max(0, ...columns.map(c => c.length))
  const canvas = new Canvas(Math.max(left + mapW + 14 + legendW, minWidth), top + Math.max(mapH, tallestColumn * lineH) + bottom, PAPER)

  if (extras.title) canvas.text(10, 8, extras.title, BLACK, 2)
  if (extras.subtitle) canvas.text(10, 8 + (extras.title ? GLYPH_H * 2 + 6 : 0), extras.subtitle, GREY, 1)

  // ---- map pixels ------------------------------------------------------------------------
  const heights = extras.heights
  const sea = extras.seaLevel ?? 63
  let maxHeight = sea + 1
  if (heights) for (let i = 0; i < heights.length; i++) if (heights[i] > maxHeight) maxHeight = heights[i]
  const slopeScale = 8 * Math.sqrt(bpp)
  const data = canvas.data
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const i = py * width + px
      let [r, g, b] = colors[grid[i]]
      if (heights) {
        const h = heights[i]
        const west = heights[px > 0 ? i - 1 : i]
        const east = heights[px < width - 1 ? i + 1 : i]
        const north = heights[py > 0 ? i - width : i]
        const south = heights[py < height - 1 ? i + width : i]
        // Light from the north-west.
        const slope = Math.max(-1, Math.min(1, ((west - east) + (north - south)) / slopeScale))
        let brightness = 1 - 0.38 * slope
        const wet = h < sea - 1
        if (wet) brightness *= 1 - 0.45 * Math.min(1, (sea - h) / 48)
        else brightness *= 0.9 + 0.28 * Math.min(1, (h - sea) / Math.max(1, maxHeight - sea))
        r *= brightness
        g *= brightness
        b *= brightness
        // Sea-level contour.
        const wetEast = px < width - 1 ? heights[i + 1] < sea - 1 : wet
        const wetSouth = py < height - 1 ? heights[i + width] < sea - 1 : wet
        if (wet !== wetEast || wet !== wetSouth) {
          r = r * 0.3 + 10 * 0.7
          g = g * 0.3 + 20 * 0.7
          b = b * 0.3 + 60 * 0.7
        }
      }
      for (let zy = 0; zy < zoom; zy++) {
        let o = ((top + py * zoom + zy) * canvas.width + left + px * zoom) * 4
        for (let zx = 0; zx < zoom; zx++) {
          data[o] = r
          data[o + 1] = g
          data[o + 2] = b
          o += 4
        }
      }
    }
  }

  const toPixelX = x => left + ((x - view.x0) / bpp) * zoom
  const toPixelY = z => top + ((z - view.z0) / bpp) * zoom

  // ---- gridlines and labels --------------------------------------------------------------
  if (showGrid) {
    for (let k = Math.ceil(view.x0 / spacing); k * spacing <= view.x0 + spanX; k++) {
      const value = k * spacing
      const x = Math.round(toPixelX(value))
      if (x < left || x >= left + mapW) continue
      for (let y = top; y < top + mapH; y++) canvas.contrastPixel(x, y, value === 0 ? 0.6 : 0.3)
      const label = String(value)
      const lx = Math.max(left, Math.min(left + mapW - textWidth(label, scale), x - Math.floor(textWidth(label, scale) / 2)))
      canvas.text(lx, top - GLYPH_H * scale - 4, label, DARK, scale)
    }
    for (let k = Math.ceil(view.z0 / spacing); k * spacing <= view.z0 + spanZ; k++) {
      const value = k * spacing
      const y = Math.round(toPixelY(value))
      if (y < top || y >= top + mapH) continue
      for (let x = left; x < left + mapW; x++) canvas.contrastPixel(x, y, value === 0 ? 0.6 : 0.3)
      const label = String(value)
      const ly = Math.max(top, Math.min(top + mapH - GLYPH_H * scale, y - Math.floor((GLYPH_H * scale) / 2)))
      canvas.text(left - 6 - textWidth(label, scale), ly, label, DARK, scale)
    }
    canvas.text(left + mapW + 3, top - GLYPH_H * scale - 4, 'X', GREY, scale)
    canvas.text(left - 6 - textWidth('Z', scale), top + mapH + 2, 'Z', GREY, scale)
  }
  canvas.strokeRect(left - 1, top - 1, mapW + 2, mapH + 2, DARK)

  // ---- structure markers -----------------------------------------------------------------
  if (extras.structures && extras.structureIds) {
    const r = scale === 2 ? 4 : 3
    for (const s of extras.structures) {
      const x = Math.round(toPixelX(s.x))
      const y = Math.round(toPixelY(s.z))
      if (x < left + r || y < top + r || x >= left + mapW - r || y >= top + mapH - r) continue
      drawMarker(canvas, x, y, r, extras.structureIds.indexOf(s.structure))
    }
  }

  // ---- red ring at 0,0 -------------------------------------------------------------------
  if (extras.ring !== false) {
    const x = toPixelX(0)
    const y = toPixelY(0)
    const r = scale === 2 ? 9 : 6
    if (x >= left && y >= top && x < left + mapW && y < top + mapH) {
      canvas.ring(x, y, r - 1.5, r + 2.5, WHITE)
      canvas.ring(x, y, r, r + 1.2, RED)
    }
  }

  // ---- legend ----------------------------------------------------------------------------
  let columnX = left + mapW + 16
  columns.forEach((column, c) => {
    let y = top
    for (const row of column) {
      if (row.header) {
        canvas.text(columnX, y, row.header, GREY, scale)
      } else if (!row.gap) {
        let x = columnX
        if (row.swatch) {
          canvas.fillRect(x, y, swatch, swatch, row.swatch)
          canvas.strokeRect(x, y, swatch, swatch, DARK)
          x += swatch + 6
        } else if (row.marker !== undefined) {
          drawMarker(canvas, x + Math.floor(swatch / 2), y + Math.floor(swatch / 2), scale === 2 ? 4 : 2, row.marker)
          x += swatch + 6
        }
        canvas.text(x, y, row.text, BLACK, scale)
      }
      y += lineH
    }
    columnX += columnWidths[c]
  })

  if (extras.footer) canvas.text(10, canvas.height - GLYPH_H - 6, extras.footer, GREY, 1)
  return canvas
}
