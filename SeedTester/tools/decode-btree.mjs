// Decodes cubiomes' tables/btree20.h into the full vanilla 1.20 overworld biome parameter list
// (what "preset": "minecraft:overworld" expands to), and optionally cross-checks it against an
// expanded vanilla dimension file (mcmeta's data/minecraft/dimension/overworld.json).
//
// Usage:
//   node tools/decode-btree.mjs <btree20.h> <names.json> <out.json> [vanilla overworld.json]
//
// names.json maps cubiomes biome ids to names ({"1":"plains",...}); the "names" object inside
// data/selftest/cubiomes_reference.json (produced by tools/cubiomes_ref.c via biome2str) works.

import fs from 'node:fs'

const [headerPath, namesPath, outPath, vanillaPath] = process.argv.slice(2)
if (!headerPath || !namesPath || !outPath) {
  console.error('usage: node tools/decode-btree.mjs <btree20.h> <names.json> <out.json> [vanilla overworld.json]')
  process.exit(1)
}

const header = fs.readFileSync(headerPath, 'utf8')
const namesJson = JSON.parse(fs.readFileSync(namesPath, 'utf8'))
const names = namesJson.names ?? namesJson

const order = Number(header.match(/btree20_order\s*=\s*(\d+)/)[1])
const steps = header.match(/btree20_steps\[\]\s*=\s*\{([^}]*)\}/)[1].split(',').map(s => Number(s.trim()))
const paramBlock = header.slice(header.indexOf('btree20_param'), header.indexOf('btree20_nodes'))
const params = [...paramBlock.matchAll(/\{\s*(-?\d+)\s*,\s*(-?\d+)\s*\}/g)].map(m => [Number(m[1]), Number(m[2])])
const nodeBlock = header.slice(header.indexOf('btree20_nodes'))
// 16 hex digits only: the explanatory comment in the header also mentions "0xFF".
const nodes = [...nodeBlock.matchAll(/0x([0-9A-Fa-f]{16})\b/g)].map(m => BigInt('0x' + m[1]))
const len = nodes.length

const leaves = []
const seen = new Set()
function walk(idx, depth) {
  if (steps[depth] === 0) {
    if (nodes[idx] >> 56n !== 0xFFn) throw new Error(`Node ${idx} at leaf depth is not marked as a leaf`)
    if (!seen.has(idx)) {
      seen.add(idx)
      leaves.push(idx)
    }
    return
  }
  let step
  do {
    step = steps[depth]
    depth++
  } while (idx + step >= len)
  let inner = Number(nodes[idx] >> 48n)
  for (let i = 0; i < order; i++) {
    walk(inner, depth)
    inner += step
    if (inner >= len) break
  }
}
walk(0, 0)

const KEYS = ['temperature', 'humidity', 'continentalness', 'erosion', 'depth', 'weirdness']
const entries = leaves.map(idx => {
  const node = nodes[idx]
  const id = Number((node >> 48n) & 0xFFn)
  const name = names[id]
  if (!name) throw new Error(`No biome name for cubiomes id ${id}`)
  const parameters = {}
  KEYS.forEach((key, i) => {
    const [min, max] = params[Number((node >> BigInt(8 * i)) & 0xFFn)]
    parameters[key] = min === max ? min / 10000 : [min / 10000, max / 10000]
  })
  parameters.offset = 0
  return { biome: `minecraft:${name}`, parameters }
})

console.log(`btree20: order ${order}, steps [${steps.join(', ')}], ${params.length} parameter ranges, ${len} nodes`)
console.log(`decoded ${entries.length} leaf entries, ${new Set(entries.map(e => e.biome)).size} distinct biomes`)

// Vanilla quantises every parameter the same way: (long)(float * 10000.0F).
const quant = v => Math.trunc(Math.fround(Math.fround(v) * 10000))
const span = p => (Array.isArray(p) ? p : typeof p === 'object' ? [p.min, p.max] : [p, p])
const keyOf = e => e.biome + '|' + KEYS.map(k => span(e.parameters[k]).map(quant).join('..')).join('|')

let output = entries
if (vanillaPath) {
  const vanilla = JSON.parse(fs.readFileSync(vanillaPath, 'utf8')).generator.biome_source.biomes
  const count = list => {
    const m = new Map()
    for (const e of list) m.set(keyOf(e), (m.get(keyOf(e)) ?? 0) + 1)
    return m
  }
  const a = count(entries)
  const b = count(vanilla)
  let onlyDecoded = 0
  let onlyVanilla = 0
  for (const [k, n] of a) onlyDecoded += Math.max(0, n - (b.get(k) ?? 0))
  for (const [k, n] of b) onlyVanilla += Math.max(0, n - (a.get(k) ?? 0))
  console.log(`vanilla file: ${vanilla.length} entries`)
  console.log(`cross-check: ${onlyDecoded} entries only in the decoded tree, ${onlyVanilla} only in the vanilla file`)
  if (onlyDecoded === 0 && onlyVanilla === 0) {
    // Identical content. Keep Minecraft's own declaration order: the game builds its search tree
    // from the list in this order, and the order decides ties on exact biome borders.
    console.log('identical -> writing the list in vanilla declaration order')
    output = vanilla.map(e => ({ biome: e.biome, parameters: e.parameters }))
  } else {
    console.log('MISMATCH -> writing the decoded list (tree order)')
    process.exitCode = 2
  }
}

fs.writeFileSync(outPath, JSON.stringify({ preset: 'minecraft:overworld', biomes: output }))
console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(2)} MB)`)
