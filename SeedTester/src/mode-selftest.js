// Mode "selftest": proves the engine against known-good data before you trust a map.
//
// The main check renders vanilla minecraft:overworld and compares it, point by point, with
// cubiomes (https://github.com/Cubitect/cubiomes), an independent C implementation of Minecraft's
// biome generation. The cubiomes results are stored in data/selftest/cubiomes_reference.json
// (produced by tools/cubiomes_ref.c), so the test needs no compiler and no internet.

import fs from 'node:fs'
import path from 'node:path'
import { normalizeConfig, viewFor } from './config.js'
import { runRender } from './mode-render.js'
import { outFromOrigin, spiral } from './mode-locate.js'
import { PackSet, ROOT_DIR, readPreset } from './packs.js'
import { javaHashCode, parseSeed } from './seed.js'
import { openSession } from './session.js'
import { quantize } from './tree.js'
import { WorldSampler } from './world.js'

export async function runSelfTest(baseConfig = {}) {
  const results = []
  const check = (name, ok, detail = '') => {
    results.push(ok)
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`)
  }

  console.log('Seed Tester self-test')
  console.log('')
  console.log('1. Seeds')
  check('text seeds use Java String.hashCode', javaHashCode('hello') === 99162322 && javaHashCode('abc') === 96354 && javaHashCode('') === 0)
  check('negative 64-bit seeds survive', parseSeed('-4172144997902289642') === -4172144997902289642n && parseSeed(-42) === -42n)
  check('numeric text is a number, other text is hashed', parseSeed('123') === 123n && parseSeed('hello') === 99162322n)

  console.log('')
  console.log('2. /locate search pattern')
  const firstSteps = [...spiral(1)].map(p => p.join(','))
  check('spiral order matches BlockPos.spiralAround', firstSteps.join(' ') === '0,0 1,0 1,1 0,1 -1,1 -1,0 -1,-1 0,-1 1,-1', firstSteps.join(' '))
  check('spiral covers the whole square', [...spiral(200)].length === 401 * 401)
  check('height order matches Mth.outFromOrigin', outFromOrigin(64, 1, 256, 64).join(',') === '64,128,192,256' && outFromOrigin(70, -63, 320, 64).join(',') === '70,134,6,198,-58,262')

  console.log('')
  console.log('3. Vanilla overworld biome list ("preset": "minecraft:overworld")')
  const packs = PackSet.load([])
  const preset = readPreset('overworld')
  const explicit = packs.json('dimension', 'minecraft:overworld').generator.biome_source.biomes
  const keyOf = e => e.biome + '|' + ['temperature', 'humidity', 'continentalness', 'erosion', 'depth', 'weirdness']
    .map(k => [e.parameters[k]].flat().map(quantize).join('..')).join('|')
  const sameList = preset.length === explicit.length && preset.every((e, i) => keyOf(e) === keyOf(explicit[i]))
  check('bundled preset list equals Mojang\'s own 1.20.1 list, in the same order', sameList, `${preset.length} entries`)

  console.log('')
  console.log('4. Vanilla overworld compared with cubiomes')
  const reference = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'selftest', 'cubiomes_reference.json'), 'utf8'))
  const config = normalizeConfig({ ...baseConfig, mode: 'render', datapacks: [], dimension: 'minecraft:overworld', seed: 0, size: 8192, blocksPerPixel: 8, center: [0, 0], relief: false, structures: false, outputName: 'selftest_overworld_seed_0' }, ROOT_DIR)
  const quiet = console.log
  console.log = () => {}
  let session
  try {
    session = openSession(config)
  } finally {
    console.log = quiet
  }
  const { dim } = session
  const n = reference.gridSize
  const stride = reference.strideQuarts * 4
  const half = n >> 1
  const y = reference.quartY * 4
  let totalBad = 0
  let totalPoints = 0
  const examples = []
  for (const entry of reference.seeds) {
    const sampler = new WorldSampler(dim, BigInt(entry.seed))
    for (const [mode, surface, what] of [['surface', true, 'surface biomes'], ['y64', false, `biomes at Y ${y}`]]) {
      let bad = 0
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const x = (i - half) * stride
          const z = (j - half) * stride
          const got = dim.biomes[sampler.biomeAt(x, y, z, surface)]
          const want = 'minecraft:' + reference.names[parseInt(entry[mode].substr((j * n + i) * 2, 2), 16)]
          if (got !== want) {
            bad++
            if (examples.length < 5) examples.push(`seed ${entry.seed} at ${x},${z} (${what}): Seed Tester says ${got}, cubiomes says ${want}`)
          }
        }
      }
      totalBad += bad
      totalPoints += n * n
      check(`seed ${entry.seed}, ${what}`, bad === 0, `${bad} of ${n * n} points differ`)
    }
  }
  for (const example of examples) console.log(`         ${example}`)
  console.log(`  Compared ${totalPoints.toLocaleString('en-US')} points over ${n * stride} x ${n * stride} blocks: ${totalBad} mismatches (${((totalBad / totalPoints) * 100).toFixed(4)}%).`)

  console.log('')
  console.log('5. Rendering vanilla overworld, seed 0 (compare with any 1.20 seed map if you like)')
  let rendered = false
  try {
    const { width, height } = viewFor(config.center, config.size, config.blocksPerPixel)
    console.log = () => {}
    const out = await runRender(session)
    console.log = quiet
    rendered = fs.existsSync(out.pngFile) && fs.statSync(out.pngFile).size > 1000
    check('map rendered', rendered, `${width} x ${height} pixels -> ${path.relative(process.cwd(), out.pngFile)}`)
  } catch (e) {
    console.log = quiet
    check('map rendered', false, e.message)
  } finally {
    await session.close()
  }

  const failed = results.filter(ok => !ok).length
  console.log('')
  console.log(failed === 0
    ? `SELF-TEST PASSED (${results.length} checks). Biome generation matches cubiomes exactly.`
    : `SELF-TEST FAILED: ${failed} of ${results.length} checks failed. Maps from this install should not be trusted.`)
  return failed === 0
}
