// Reads config.json and fills in defaults. The parser is forgiving: // comments, trailing commas
// and long seed numbers (which plain JSON would silently round) are all accepted.

import fs from 'node:fs'
import path from 'node:path'

/** Strips comments and trailing commas, and quotes integers too long for a JS number. */
export function cleanJson(text) {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
    } else if (c === ',') {
      let j = i + 1
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') i++ // trailing comma
      else { out += c; i++ }
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + 1
      while (j < n && /[0-9.eE+-]/.test(text[j])) j++
      const token = text.slice(i, j)
      out += /^-?\d{16,}$/.test(token) ? `"${token}"` : token
      i = j
    } else {
      out += c
      i++
    }
  }
  return out
}

export function parseLooseJson(text, file = 'config') {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  try {
    return JSON.parse(cleanJson(text))
  } catch (e) {
    let hint = ''
    if (/\\[^"\\/bfnrtu]/.test(text) || /Bad escaped character|Bad escape/i.test(e.message)) {
      hint = '\n  Hint: in file paths use forward slashes (C:/Users/...) or double backslashes (C:\\\\Users\\\\...).'
    }
    throw new Error(`Could not read ${file}: ${e.message}${hint}`)
  }
}

const KNOWN_KEYS = new Set([
  'mode', 'datapacks', 'dimension', 'seed', 'centerX', 'centerZ', 'center', 'size', 'blocksPerPixel',
  'biomeLayer', 'y', 'grid', 'legend', 'waterBiomes', 'colors', 'threads', 'outputFolder', 'outputName',
  'relief', 'structures', 'search', 'locate', 'includeVanilla',
])

function asPair(value, name) {
  if (typeof value === 'number') return [value, value]
  if (Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number')) return value
  throw new Error(`"${name}" must be a number or a pair like [16000, 8000].`)
}

export function loadConfig(file) {
  if (!fs.existsSync(file)) throw new Error(`Config file not found: ${file}`)
  const raw = parseLooseJson(fs.readFileSync(file, 'utf8'), path.basename(file))
  return normalizeConfig(raw, path.dirname(path.resolve(file)))
}

export function normalizeConfig(raw, baseDir) {
  const warnings = []
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key) && !key.startsWith('_')) warnings.push(`Unknown setting "${key}" was ignored (check the spelling).`)
  }

  const mode = String(raw.mode ?? 'render').toLowerCase()
  if (!['render', 'search', 'locate', 'selftest'].includes(mode)) {
    throw new Error(`"mode" must be "render", "search", "locate" or "selftest" (got "${raw.mode}").`)
  }

  const datapacks = (raw.datapacks ?? []).map(p => path.resolve(baseDir, String(p)))
  const center = raw.center ? asPair(raw.center, 'center') : [raw.centerX ?? 0, raw.centerZ ?? 0]
  const size = asPair(raw.size ?? 8000, 'size')
  const blocksPerPixel = raw.blocksPerPixel ?? 8
  if (!(blocksPerPixel > 0)) throw new Error('"blocksPerPixel" must be greater than 0.')
  if (size[0] <= 0 || size[1] <= 0) throw new Error('"size" must be greater than 0.')

  const layer = String(raw.biomeLayer ?? 'surface').toLowerCase()
  if (!['surface', 'exact'].includes(layer)) throw new Error('"biomeLayer" must be "surface" or "exact".')

  let relief = { enabled: raw.relief === true, detail: 1 }
  if (raw.relief && typeof raw.relief === 'object') {
    relief = { enabled: raw.relief.enabled !== false, detail: Math.max(1, Math.round(raw.relief.detail ?? 1)) }
  }

  const config = {
    mode,
    datapacks,
    includeVanilla: raw.includeVanilla !== false,
    dimension: raw.dimension ?? 'minecraft:overworld',
    seed: raw.seed ?? 0,
    center,
    size,
    blocksPerPixel,
    surface: layer === 'surface',
    y: raw.y,
    grid: raw.grid ?? true,
    legend: raw.legend ?? true,
    waterBiomes: raw.waterBiomes ?? ['ocean'],
    colors: raw.colors ?? {},
    threads: raw.threads ?? 0,
    outputFolder: path.resolve(baseDir, raw.outputFolder ?? 'output'),
    outputName: raw.outputName,
    relief,
    structures: raw.structures ?? false,
    search: raw.search ?? {},
    locate: raw.locate ?? {},
    warnings,
  }
  return config
}

/** Pixel grid for a block area centred on `center`. */
export function viewFor(center, size, blocksPerPixel) {
  const width = Math.max(1, Math.round(size[0] / blocksPerPixel))
  const height = Math.max(1, Math.round(size[1] / blocksPerPixel))
  return {
    width,
    height,
    view: {
      x0: center[0] - (width * blocksPerPixel) / 2,
      z0: center[1] - (height * blocksPerPixel) / 2,
      blocksPerPixel,
    },
  }
}

export function safeName(text) {
  return String(text).replace(/[^a-zA-Z0-9._-]+/g, '_')
}
