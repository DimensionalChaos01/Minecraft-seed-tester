// World seeds, parsed the way Minecraft parses the "level-seed" setting.

import crypto from 'node:crypto'

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/** Java's String.hashCode(). */
export function javaHashCode(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  }
  return h
}

export function randomSeed() {
  return crypto.randomBytes(8).readBigInt64LE()
}

/**
 * Number or numeric text -> that number. Any other text -> its Java hashCode, like Minecraft.
 * Empty text or "random" -> a random seed.
 */
export function parseSeed(value) {
  if (typeof value === 'bigint') return BigInt.asIntN(64, value)
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`Seed ${value} is not a whole number.`)
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Seed ${value} is too large to be written as a plain number. Put it in quotes: "seed": "${value}"`)
    }
    return BigInt(value)
  }
  if (typeof value !== 'string') throw new Error(`Cannot use ${JSON.stringify(value)} as a seed.`)
  const text = value.trim()
  if (text === '' || text.toLowerCase() === 'random') return randomSeed()
  if (/^[+-]?\d+$/.test(text)) {
    const n = BigInt(text)
    if (n >= INT64_MIN && n <= INT64_MAX) return n
  }
  return BigInt(javaHashCode(text))
}
