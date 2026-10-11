#!/usr/bin/env node
// Seed Tester: biome map renderer and seed searcher for Minecraft 1.20.1 datapack dimensions.
//
//   node src/cli.js [config.json]            run the mode named in the config file
//   node src/cli.js selftest                 check the engine against cubiomes
//   node src/cli.js dimensions [config.json] list the dimensions in the configured datapacks
//   options: --mode render|search|locate|selftest   --seed <seed>   --threads <n>

import { spawn } from 'node:child_process'
import path from 'node:path'
import { loadConfig } from './config.js'
import { openSession } from './session.js'

function parseArgs(argv) {
  const args = { positional: [], options: {} }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=')
      // "--flag value", "--flag=value", or a bare "--flag"
      args.options[key] = inline ?? (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true)
    } else {
      args.positional.push(arg)
    }
  }
  return args
}

/** When started from seedtester.bat, show the result in the default viewer / Explorer. */
function openWhenDone(target) {
  if (!process.env.SEEDTESTER_OPEN || process.platform !== 'win32' || !target) return
  spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref()
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2))
  const commands = ['selftest', 'dimensions', 'render', 'search', 'locate', 'map']
  const command = commands.includes(positional[0]?.toLowerCase()) ? positional.shift().toLowerCase() : null
  const configFile = path.resolve(positional[0] ?? 'config.json')

  if (command === 'map') {
    // The interactive map. config.json only supplies the starting packs, dimension and seed.
    const fs = await import('node:fs')
    const config = fs.existsSync(configFile) ? loadConfig(configFile) : { datapacks: [], dimension: 'minecraft:overworld', seed: 0 }
    if (options.threads !== undefined) config.threads = Number(options.threads) || 0
    if (options.seed !== undefined) config.seed = options.seed
    const { startServer } = await import('./server.js')
    await startServer(config, { port: options.port, open: options['no-open'] === undefined, world: options.world })
    return
  }

  if (command === 'selftest' || options.mode === 'selftest') {
    const { runSelfTest } = await import('./mode-selftest.js')
    process.exitCode = (await runSelfTest({ threads: Number(options.threads) || 0 })) ? 0 : 1
    return
  }

  const config = loadConfig(configFile)
  if (options.seed !== undefined) config.seed = options.seed
  if (options.threads !== undefined) config.threads = Number(options.threads) || 0
  const mode = (command && command !== 'dimensions' ? command : options.mode ?? config.mode).toLowerCase()
  console.log(`Seed Tester - ${path.basename(configFile)} - mode: ${command === 'dimensions' ? 'dimensions' : mode}`)

  if (command === 'dimensions') {
    const { PackSet } = await import('./packs.js')
    const { listDimensions } = await import('./world.js')
    const packs = PackSet.load(config.datapacks, { vanilla: config.includeVanilla })
    console.log('Dimensions available:')
    for (const id of listDimensions(packs)) console.log(`  ${id}   (from ${packs.source('dimension', id)})`)
    return
  }

  if (mode === 'selftest') {
    const { runSelfTest } = await import('./mode-selftest.js')
    process.exitCode = (await runSelfTest({ threads: config.threads })) ? 0 : 1
    return
  }

  const session = openSession(config, { workers: mode !== 'locate' })
  try {
    if (mode === 'render') openWhenDone((await (await import('./mode-render.js')).runRender(session)).pngFile)
    else if (mode === 'search') openWhenDone((await (await import('./mode-search.js')).runSearch(session)).folder)
    else if (mode === 'locate') await (await import('./mode-locate.js')).runLocate(session)
    else throw new Error(`Unknown mode "${mode}". Use render, search, locate or selftest.`)
  } finally {
    await session.close()
  }
}

main().catch(error => {
  console.error('')
  console.error(`ERROR: ${error.message}`)
  if (process.env.SEEDTESTER_DEBUG) console.error(error.stack)
  process.exitCode = 1
})
