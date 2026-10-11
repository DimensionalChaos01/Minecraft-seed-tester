// Mode "search": scan many seeds at a coarse scale, score them against rules, keep the best.

import fs from 'node:fs'
import path from 'node:path'
import { safeName, viewFor } from './config.js'
import { progressPrinter } from './pool.js'
import { displayNames, renderMap } from './render.js'
import { relativeToCwd } from './session.js'
import { parseSeed, randomSeed } from './seed.js'
import { analyze, biomesWithin, resolveBiomeNames, statsToJson } from './stats.js'

function seedList(spec) {
  if (Array.isArray(spec)) return spec.map(parseSeed)
  if (spec && typeof spec === 'object') {
    if (Array.isArray(spec.list)) return spec.list.map(parseSeed)
    if (spec.random !== undefined) return Array.from({ length: Math.max(1, Math.floor(spec.random)) }, randomSeed)
    if (spec.from !== undefined) {
      const from = parseSeed(spec.from)
      const count = spec.count ?? (spec.to !== undefined ? Number(parseSeed(spec.to) - from) + 1 : 100)
      if (!(count > 0)) throw new Error('"search.seeds": "count" must be at least 1 (or "to" must not be below "from").')
      return Array.from({ length: Math.floor(count) }, (_, i) => from + BigInt(i))
    }
  }
  throw new Error('"search.seeds" must be {"from": 0, "count": 500}, {"from": 0, "to": 499}, {"random": 500} or a list of seeds.')
}

const RULE_TYPES = ['land_at', 'biome_at', 'continent', 'ocean_percent', 'biomes_within']

/** Checks the rules once and resolves biome names, so mistakes are reported before the scan. */
function compileRules(rules, dim, notes) {
  if (!Array.isArray(rules) || rules.length === 0) {
    notes.push('No rules given, so seeds are ranked by "land at 0,0" only.')
    rules = [{ type: 'land_at' }]
  }
  return rules.map((rule, i) => {
    const type = String(rule.type ?? '').toLowerCase()
    if (!RULE_TYPES.includes(type)) {
      throw new Error(`Search rule ${i + 1}: unknown type "${rule.type}". Valid types: ${RULE_TYPES.join(', ')}.`)
    }
    const compiled = {
      type,
      weight: rule.weight ?? 1,
      required: rule.required === true,
      point: [rule.x ?? 0, rule.z ?? 0],
      radius: rule.withinBlocks ?? rule.radius ?? 2000,
      minAreaKm2: rule.minAreaKm2 ?? 10,
      min: rule.min ?? 0,
      max: rule.max ?? 100,
    }
    if (type === 'biome_at' || type === 'biomes_within') {
      const names = rule.biomes ?? (rule.biome ? [rule.biome] : [])
      if (names.length === 0) throw new Error(`Search rule ${i + 1} (${type}) needs a "biomes" list.`)
      // Each listed name becomes its own group: "plains" may match both delta:plains and minecraft:plains.
      compiled.groups = names.map(name => {
        const { indices, unknown } = resolveBiomeNames(dim.biomes, [name])
        if (unknown.length > 0) notes.push(`Search rule ${i + 1}: no biome named "${name}" exists in ${dim.id}; that part can never be satisfied.`)
        return { name, indices }
      })
    }
    compiled.label = describeRule(compiled)
    return compiled
  })
}

function describeRule(rule) {
  const at = `${rule.point[0]},${rule.point[1]}`
  switch (rule.type) {
    case 'land_at': return `land at ${at}`
    case 'biome_at': return `${rule.groups.map(g => g.name).join(' or ')} at ${at}`
    case 'continent': return `landmass of ${rule.minAreaKm2}+ km² within ${rule.radius} blocks of ${at}`
    case 'ocean_percent': return `ocean between ${rule.min}% and ${rule.max}%`
    case 'biomes_within': return `${rule.groups.map(g => g.name).join(', ')} within ${rule.radius} blocks of ${at}`
  }
  return rule.type
}

/** Returns how well one rule is met (0..1) plus a short description of what was found. */
function evaluateRule(rule, ctx) {
  const { grid, width, height, view, isWater, biomes } = ctx
  const bpp = view.blocksPerPixel
  const pixelAt = ([x, z]) => {
    const px = Math.floor((x - view.x0) / bpp)
    const py = Math.floor((z - view.z0) / bpp)
    return px < 0 || py < 0 || px >= width || py >= height ? -1 : py * width + px
  }
  switch (rule.type) {
    case 'land_at': {
      const p = pixelAt(rule.point)
      const land = p >= 0 && !isWater[grid[p]]
      return { value: land ? 1 : 0, found: p < 0 ? 'outside the scanned area' : biomes[grid[p]] }
    }
    case 'biome_at': {
      const p = pixelAt(rule.point)
      const hit = p >= 0 && rule.groups.some(g => g.indices.has(grid[p]))
      return { value: hit ? 1 : 0, found: p < 0 ? 'outside the scanned area' : biomes[grid[p]] }
    }
    case 'continent': {
      // Landmasses are measured from 0,0 by analyze(); recompute the distance for other points.
      let best = 0
      for (const mass of ctx.massesNear(rule.point, rule.radius)) best = Math.max(best, mass.areaKm2)
      return { value: Math.min(1, best / rule.minAreaKm2), found: `${best.toFixed(1)} km²` }
    }
    case 'ocean_percent': {
      const ocean = ctx.stats.oceanPercent
      const miss = ocean < rule.min ? rule.min - ocean : ocean > rule.max ? ocean - rule.max : 0
      return { value: Math.max(0, 1 - miss / 20), found: `${ocean.toFixed(1)}%` }
    }
    case 'biomes_within': {
      const present = biomesWithin(grid, width, height, view, rule.point, rule.radius)
      const hits = rule.groups.filter(g => [...g.indices].some(i => present.has(i)))
      const missing = rule.groups.filter(g => !hits.includes(g)).map(g => g.name)
      return { value: hits.length / rule.groups.length, found: missing.length === 0 ? 'all found' : `missing ${missing.join(', ')}` }
    }
  }
  return { value: 0, found: '' }
}

function scoreSeed(rules, grid, width, height, view, dim, isWater) {
  const stats = analyze(grid, width, height, view, dim.biomes, isWater, [0, 0])
  const bpp = view.blocksPerPixel
  const ctx = {
    grid, width, height, view, isWater, stats, biomes: dim.biomes,
    massesNear(point, radius) {
      // A landmass counts if any of its pixels lies within the radius.
      const ids = new Set()
      const r2 = radius * radius
      const px0 = Math.max(0, Math.floor((point[0] - radius - view.x0) / bpp))
      const px1 = Math.min(width - 1, Math.ceil((point[0] + radius - view.x0) / bpp))
      const py0 = Math.max(0, Math.floor((point[1] - radius - view.z0) / bpp))
      const py1 = Math.min(height - 1, Math.ceil((point[1] + radius - view.z0) / bpp))
      for (let py = py0; py <= py1; py++) {
        const dz = view.z0 + (py + 0.5) * bpp - point[1]
        for (let px = px0; px <= px1; px++) {
          const label = stats.labels[py * width + px]
          if (label < 0 || ids.has(label)) continue
          const dx = view.x0 + (px + 0.5) * bpp - point[0]
          if (dx * dx + dz * dz <= r2) ids.add(label)
        }
      }
      return stats.landmasses.filter(m => ids.has(m.id))
    },
  }
  let score = 0
  let passed = true
  const results = rules.map(rule => {
    const { value, found } = evaluateRule(rule, ctx)
    const met = value >= 1
    if (rule.required && !met) passed = false
    score += rule.weight * value
    return { met, value, found }
  })
  return { stats, score, passed, results }
}

export async function runSearch(session) {
  const { config, dim, pool } = session
  const search = config.search
  const notes = []
  const rules = compileRules(search.rules, dim, notes)
  const seeds = seedList(search.seeds ?? { from: 0, count: 200 })
  const top = Math.max(1, search.top ?? 10)
  const { width, height, view } = viewFor(config.center, [search.size ?? 16000, search.size ?? 16000].flat().slice(0, 2), search.blocksPerPixel ?? 64)
  const maxWeight = rules.reduce((sum, r) => sum + r.weight, 0)

  console.log(`Searching ${seeds.length} seed${seeds.length === 1 ? '' : 's'}: ${Math.round(width * view.blocksPerPixel)} x ${Math.round(height * view.blocksPerPixel)} blocks around ${config.center[0]}, ${config.center[1]} at ${view.blocksPerPixel} blocks per pixel (${width} x ${height} samples each), ${session.threads} threads`)
  console.log('Rules:')
  rules.forEach((r, i) => console.log(`  ${i + 1}. ${r.label}  [weight ${r.weight}${r.required ? ', required' : ''}]`))
  for (const note of notes) console.log(`  Note: ${note}`)

  await pool.ready
  const progress = progressPrinter('Scanning seeds')
  const best = [] // sorted, at most `top` entries, each keeps its grid for the thumbnail
  const all = []
  let done = 0
  let passedCount = 0
  await Promise.all(seeds.map(async seed => {
    const grid = await pool.run({
      kind: 'biomes', seed: seed.toString(), x0: view.x0, z0: view.z0, width, height,
      blocksPerPixel: view.blocksPerPixel, y: session.sampleY, surface: true,
    })
    const result = scoreSeed(rules, grid, width, height, view, dim, session.isWater)
    done++
    all.push({ seed: seed.toString(), score: Number(result.score.toFixed(4)), passed: result.passed, oceanPercent: Number(result.stats.oceanPercent.toFixed(2)) })
    if (result.passed) {
      passedCount++
      const entry = { seed, grid, ...result }
      // Ties go to the lower seed so that reruns give the same order.
      const before = (a, b) => a.score > b.score || (a.score === b.score && a.seed < b.seed)
      let i = best.findIndex(other => before(entry, other))
      if (i === -1) i = best.length
      if (i < top) {
        best.splice(i, 0, entry)
        if (best.length > top) best.pop()
      }
    }
    progress.update(done / seeds.length, best.length > 0 ? `best so far: seed ${best[0].seed} (${best[0].score.toFixed(2)})` : '')
  }))
  progress.done(`${passedCount} of ${seeds.length} seeds met every required rule`)

  // ---- output ----------------------------------------------------------------------------
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
  const folder = path.join(config.outputFolder, `search_${safeName(dim.id)}_${stamp}`)
  fs.mkdirSync(folder, { recursive: true })

  const names = displayNames(dim.biomes)
  console.log('')
  if (best.length === 0) {
    console.log('No seed met every required rule. Loosen the rules marked "required", or scan more seeds.')
  } else {
    console.log(`Top ${best.length} (best possible score: ${maxWeight}):`)
    console.log('')
    console.log(`  ${'#'.padStart(2)}  ${'seed'.padEnd(21)} ${'score'.padStart(6)}  ${'ocean'.padStart(6)}  ${'largest land'.padStart(13)}  biome at 0,0`)
  }
  const summary = []
  best.forEach((entry, i) => {
    const rank = i + 1
    const largest = entry.stats.landmasses[0]
    const origin = entry.stats.originBiome ? names[dim.biomes.indexOf(entry.stats.originBiome)] : '-'
    console.log(`  ${String(rank).padStart(2)}  ${entry.seed.toString().padEnd(21)} ${entry.score.toFixed(2).padStart(6)}  ${(entry.stats.oceanPercent.toFixed(1) + '%').padStart(6)}  ${((largest ? largest.areaKm2.toFixed(1) : '0') + ' km²').padStart(13)}  ${origin}`)
    const unmet = rules.map((r, k) => ({ r, res: entry.results[k] })).filter(x => !x.res.met)
    for (const { r, res } of unmet) console.log(`        not met: ${r.label} (found ${res.found})`)

    const file = path.join(folder, `${String(rank).padStart(2, '0')}_seed_${entry.seed}.png`)
    renderMap(
      { grid: entry.grid, width, height, view, biomes: dim.biomes, colors: session.colors },
      {
        title: `#${rank}  seed ${entry.seed}`,
        subtitle: `${dim.id}, score ${entry.score.toFixed(2)} of ${maxWeight}, ${Math.round(width * view.blocksPerPixel)} x ${Math.round(height * view.blocksPerPixel)} blocks, 1 pixel = ${view.blocksPerPixel} blocks`,
        stats: entry.stats, grid: config.grid, legend: config.legend,
      },
    ).save(file)
    summary.push({
      rank,
      seed: entry.seed.toString(),
      score: Number(entry.score.toFixed(4)),
      thumbnail: path.basename(file),
      rules: rules.map((r, k) => ({ rule: r.label, met: entry.results[k].met, found: entry.results[k].found })),
      ...statsToJson(entry.stats, 3),
    })
  })

  const resultsFile = path.join(folder, 'results.json')
  fs.writeFileSync(resultsFile, JSON.stringify({
    tool: 'Seed Tester',
    dimension: dim.id,
    datapacks: session.packs.packNames,
    center: config.center,
    sizeBlocks: [width * view.blocksPerPixel, height * view.blocksPerPixel],
    blocksPerPixel: view.blocksPerPixel,
    rules: rules.map(r => ({ rule: r.label, weight: r.weight, required: r.required })),
    bestPossibleScore: maxWeight,
    seedsScanned: seeds.length,
    seedsMeetingRequiredRules: passedCount,
    top: summary,
    allSeeds: all.sort((a, b) => b.score - a.score),
  }, null, 2))

  console.log('')
  if (best.length > 0) console.log(`Thumbnails: ${relativeToCwd(folder)}`)
  console.log(`Results:    ${relativeToCwd(resultsFile)}`)
  if (best.length > 0) console.log(`To see a seed in detail, put it in config.json as "seed" with "mode": "render".`)
  return { folder, best }
}
