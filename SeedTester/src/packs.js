// Reads datapacks (folders, .zip or .jar files) and resolves resources the way Minecraft does:
// packs are applied in order, a later pack replaces an earlier file with the same id, and tags are
// merged additively unless a pack says "replace": true.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const VANILLA_DIR = path.join(ROOT_DIR, 'data', 'vanilla')
export const PRESET_DIR = path.join(ROOT_DIR, 'data', 'presets')

// Resource folders the tool cares about, longest first so "tags/worldgen/biome" wins over nothing
// shorter and "dimension_type" is never mistaken for "dimension".
const TYPES = [
  'worldgen/multi_noise_biome_source_parameter_list',
  'worldgen/density_function',
  'worldgen/noise_settings',
  'worldgen/structure_set',
  'worldgen/structure',
  'worldgen/biome',
  'worldgen/noise',
  'tags/worldgen/biome',
  'dimension_type',
  'dimension',
]

function classify(relPath) {
  // relPath looks like "data/<namespace>/<type>/<path>.json"
  const m = /^data\/([^/]+)\/(.+)\.json$/i.exec(relPath)
  if (!m) return null
  const [, namespace, rest] = m
  for (const type of TYPES) {
    if (rest.startsWith(type + '/')) {
      return { type, id: `${namespace}:${rest.slice(type.length + 1)}` }
    }
  }
  return null
}

export function normalizeId(id) {
  return id.includes(':') ? id : `minecraft:${id}`
}

export class PackSet {
  constructor() {
    this.packNames = []
    this.resources = new Map() // type -> Map(id -> [{pack, file, read}])
    this.jsonCache = new Map()
    this.tagCache = new Map()
  }

  /**
   * extra: in-memory packs ({ name, files: { "data/ns/type/path.json": text } }) applied right
   * after vanilla and before the real packs. Used for the dimensions stored in a world's level.dat.
   */
  static load(packPaths, { vanilla = true, extra = [] } = {}) {
    const set = new PackSet()
    if (vanilla) set.addFolder(VANILLA_DIR, 'vanilla 1.20.1')
    for (const pack of extra) set.addVirtual(pack)
    for (const p of packPaths) set.add(p)
    return set
  }

  addVirtual({ name, files }) {
    this.packNames.push(name)
    for (const [relPath, text] of Object.entries(files)) {
      this.addEntry(name, relPath, `${name}!${relPath}`, () => text)
    }
  }

  add(packPath) {
    if (!fs.existsSync(packPath)) {
      throw new Error(`Datapack not found: ${packPath}\n  Check the "datapacks" list in your config file.`)
    }
    const name = path.basename(packPath)
    if (fs.statSync(packPath).isDirectory()) this.addFolder(packPath, name)
    else this.addZip(packPath, name)
  }

  addEntry(pack, relPath, file, read) {
    const info = classify(relPath)
    if (!info) return false
    let byId = this.resources.get(info.type)
    if (!byId) this.resources.set(info.type, (byId = new Map()))
    let versions = byId.get(info.id)
    if (!versions) byId.set(info.id, (versions = []))
    versions.push({ pack, file, read })
    return true
  }

  addFolder(dir, name) {
    let root = dir
    if (!fs.existsSync(path.join(root, 'data'))) {
      // Tolerate the common "unzipped into a folder inside a folder" layout.
      const inner = fs.readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'data')))
      if (inner.length !== 1) {
        throw new Error(`"${dir}" does not look like a datapack: it has no "data" folder.`)
      }
      root = path.join(root, inner[0].name)
    }
    this.packNames.push(name)
    let count = 0
    const walk = (abs, rel) => {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const childAbs = path.join(abs, entry.name)
        const childRel = `${rel}/${entry.name}`
        if (entry.isDirectory()) walk(childAbs, childRel)
        else if (this.addEntry(name, childRel, childAbs, () => fs.readFileSync(childAbs, 'utf8'))) count++
      }
    }
    walk(path.join(root, 'data'), 'data')
    return count
  }

  addZip(file, name) {
    let zip
    try {
      zip = new AdmZip(file)
    } catch (e) {
      throw new Error(`Could not open "${file}" as a zip file: ${e.message}`)
    }
    const entries = zip.getEntries().filter(e => !e.isDirectory)
    // Find where the pack starts inside the archive (normally the top level).
    let prefix = null
    for (const e of entries) {
      const m = /^(.*?)data\/[^/]+\/(?:worldgen|dimension|dimension_type|tags)\//.exec(e.entryName.replace(/\\/g, '/'))
      if (m && (prefix === null || m[1].length < prefix.length)) prefix = m[1]
    }
    if (prefix === null) {
      throw new Error(`"${file}" contains no worldgen data (no data/<namespace>/worldgen or dimension folder).`)
    }
    this.packNames.push(name)
    let count = 0
    for (const e of entries) {
      const entryName = e.entryName.replace(/\\/g, '/')
      if (!entryName.startsWith(prefix)) continue
      const rel = entryName.slice(prefix.length)
      if (this.addEntry(name, rel, `${file}!${entryName}`, () => e.getData().toString('utf8'))) count++
    }
    return count
  }

  ids(type) {
    return [...(this.resources.get(type)?.keys() ?? [])]
  }

  has(type, id) {
    return this.resources.get(type)?.has(normalizeId(id)) ?? false
  }

  /** Name of the pack that provides the winning version of a resource. */
  source(type, id) {
    const versions = this.resources.get(type)?.get(normalizeId(id))
    return versions ? versions[versions.length - 1].pack : undefined
  }

  static parse(version) {
    let text = version.read()
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new Error(`Invalid JSON in ${version.file}: ${e.message}`)
    }
  }

  /** Parsed JSON of a resource (the version from the last pack that has it), or undefined. */
  json(type, id) {
    id = normalizeId(id)
    const key = `${type}|${id}`
    if (this.jsonCache.has(key)) return this.jsonCache.get(key)
    const versions = this.resources.get(type)?.get(id)
    const value = versions ? PackSet.parse(versions[versions.length - 1]) : undefined
    this.jsonCache.set(key, value)
    return value
  }

  /** All ids in a biome tag, merged across packs. Accepts "ns:path" with or without the leading "#". */
  biomeTag(tagId, seen = new Set()) {
    tagId = normalizeId(tagId.replace(/^#/, ''))
    if (this.tagCache.has(tagId)) return this.tagCache.get(tagId)
    const result = new Set()
    if (seen.has(tagId)) return result
    seen.add(tagId)
    const versions = this.resources.get('tags/worldgen/biome')?.get(tagId) ?? []
    for (const version of versions) {
      const json = PackSet.parse(version)
      if (json.replace === true) result.clear()
      for (const value of json.values ?? []) {
        const entry = typeof value === 'string' ? value : value?.id
        if (typeof entry !== 'string') continue
        if (entry.startsWith('#')) {
          for (const id of this.biomeTag(entry, seen)) result.add(id)
        } else {
          result.add(normalizeId(entry))
        }
      }
    }
    seen.delete(tagId)
    this.tagCache.set(tagId, result)
    return result
  }

  /** Resolves a "biomes" field: "#tag", "id", or a list of either. */
  biomeSet(spec) {
    const result = new Set()
    for (const entry of Array.isArray(spec) ? spec : [spec]) {
      if (typeof entry !== 'string') continue
      if (entry.startsWith('#')) {
        for (const id of this.biomeTag(entry)) result.add(id)
      } else {
        result.add(normalizeId(entry))
      }
    }
    return result
  }
}

export function readPreset(name) {
  const file = path.join(PRESET_DIR, `${name}.json`)
  if (!fs.existsSync(file)) return undefined
  return JSON.parse(fs.readFileSync(file, 'utf8')).biomes
}
