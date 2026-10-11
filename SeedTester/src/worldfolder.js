// Reads a Minecraft world folder: the seed, the enabled datapacks in their load order, and the
// dimensions stored in level.dat.

import fs from 'node:fs'
import path from 'node:path'
import { NbtFile } from 'deepslate'

/** Accepts the world folder itself, or a folder directly inside it (datapacks, region, ...). */
function findWorldRoot(folder) {
  for (const candidate of [folder, path.dirname(folder)]) {
    if (fs.existsSync(path.join(candidate, 'level.dat'))) return candidate
  }
  const hint = fs.existsSync(folder) && fs.readdirSync(folder, { withFileTypes: true }).some(e => e.isDirectory() && fs.existsSync(path.join(folder, e.name, 'level.dat')))
    ? ' It contains world folders: open one of them instead.'
    : ''
  throw new Error(`"${folder}" is not a Minecraft world: it has no level.dat file.${hint}`)
}

export function readWorldFolder(folder) {
  const root = findWorldRoot(path.resolve(folder))
  let data
  try {
    data = NbtFile.read(new Uint8Array(fs.readFileSync(path.join(root, 'level.dat')))).root.getCompound('Data')
  } catch (e) {
    throw new Error(`Could not read level.dat in "${root}": ${e.message}`)
  }

  const version = data.hasCompound('Version') ? data.getCompound('Version').getString('Name') : 'unknown'
  const settings = data.getCompound('WorldGenSettings')
  // Longs must be read as text: a JS number cannot hold a 64-bit seed exactly.
  const seedTag = settings.get('seed') ?? data.get('RandomSeed')
  if (!seedTag) {
    throw new Error(`The world "${path.basename(root)}" (Minecraft ${version}) does not store its seed in level.dat the way 1.20.1 does. Only worlds saved by Minecraft 1.16 to 1.21 can be opened.`)
  }
  const seed = seedTag.toString().replace(/[lL]$/, '')

  // Datapacks, in the order the world applies them.
  const packs = []
  const skipped = []
  const enabled = data.hasCompound('DataPacks') ? data.getCompound('DataPacks').get('Enabled')?.toSimplifiedJson() ?? [] : []
  for (const entry of enabled) {
    if (entry === 'vanilla') continue
    if (typeof entry === 'string' && entry.startsWith('file/')) {
      const file = path.join(root, 'datapacks', entry.slice(5))
      if (fs.existsSync(file)) packs.push(file)
      else skipped.push({ pack: entry, reason: 'listed in level.dat but missing from the datapacks folder' })
    } else {
      skipped.push({ pack: String(entry), reason: 'comes from a mod or the game itself, not from the datapacks folder' })
    }
  }

  // Dimensions saved in level.dat. A datapack that defines the same dimension wins, as in the game.
  const files = {}
  const dimensions = settings.hasCompound('dimensions') ? settings.getCompound('dimensions').toSimplifiedJson() : {}
  for (const [id, json] of Object.entries(dimensions)) {
    const [namespace, name] = id.includes(':') ? id.split(':') : ['minecraft', id]
    files[`data/${namespace}/dimension/${name}.json`] = JSON.stringify(json)
  }

  return {
    folder: root,
    name: data.hasString('LevelName') ? data.getString('LevelName') : path.basename(root),
    version,
    seed,
    packs,
    skipped,
    levelPack: { name: 'level.dat', files },
  }
}
