// Exact port of Minecraft 1.20.1's Climate.RTree (the multi-noise biome lookup).
//
// deepslate ships a similar tree, but it keeps the 1.18.0 layout (10 children per node, float
// maths). 1.20.1 uses 6 children per node and works on values quantised to 1/10000, and both
// details decide which biome wins on an exact border. The self-test checks this port against
// cubiomes.

const DIMS = 7 // temperature, humidity, continentalness, erosion, depth, weirdness, offset
const CHILDREN_PER_NODE = 6

/** Minecraft's Climate.quantizeCoord: (long)(float * 10000.0F). */
export function quantize(value) {
  return Math.trunc(Math.fround(Math.fround(value) * 10000))
}

function span(param) {
  if (typeof param === 'number') return [param, param]
  if (Array.isArray(param)) return [param[0], param[1]]
  if (param && typeof param === 'object') return [param.min, param.max]
  return [0, 0]
}

function unionSpace(nodes) {
  const min = new Array(DIMS).fill(Infinity)
  const max = new Array(DIMS).fill(-Infinity)
  for (const node of nodes) {
    for (let i = 0; i < DIMS; i++) {
      if (node.min[i] < min[i]) min[i] = node.min[i]
      if (node.max[i] > max[i]) max[i] = node.max[i]
    }
  }
  return { min, max }
}

function subTree(children) {
  return { ...unionSpace(children), children, value: -1 }
}

// Java long division truncates toward zero.
const center = (node, i) => Math.trunc((node.min[i] + node.max[i]) / 2)

function sortNodes(nodes, primary, abs) {
  const key = abs ? (n, i) => Math.abs(center(n, i)) : center
  nodes.sort((a, b) => {
    for (let k = 0; k < DIMS; k++) {
      const i = (primary + k) % DIMS
      const d = key(a, i) - key(b, i)
      if (d !== 0) return d
    }
    return 0
  })
}

function bucketize(nodes) {
  const result = []
  let bucket = []
  const size = Math.trunc(Math.pow(CHILDREN_PER_NODE, Math.floor(Math.log(nodes.length - 0.01) / Math.log(CHILDREN_PER_NODE))))
  for (const node of nodes) {
    bucket.push(node)
    if (bucket.length >= size) {
      result.push(subTree(bucket))
      bucket = []
    }
  }
  if (bucket.length > 0) result.push(subTree(bucket))
  return result
}

function cost(node) {
  let sum = 0
  for (let i = 0; i < DIMS; i++) sum += Math.abs(node.max[i] - node.min[i])
  return sum
}

function build(nodes) {
  if (nodes.length === 1) return nodes[0]
  if (nodes.length <= CHILDREN_PER_NODE) {
    const key = node => {
      let sum = 0
      for (let i = 0; i < DIMS; i++) sum += Math.abs(center(node, i))
      return sum
    }
    nodes.sort((a, b) => key(a) - key(b))
    return subTree(nodes)
  }
  let bestCost = Infinity
  let bestDim = -1
  let best = null
  for (let dim = 0; dim < DIMS; dim++) {
    sortNodes(nodes, dim, false)
    const buckets = bucketize(nodes)
    let total = 0
    for (const bucket of buckets) total += cost(bucket)
    if (bestCost > total) {
      bestCost = total
      bestDim = dim
      best = buckets
    }
  }
  sortNodes(best, bestDim, true)
  return subTree(best.map(bucket => build(bucket.children.slice())))
}

function distance(node, target) {
  let sum = 0
  const min = node.min
  const max = node.max
  for (let i = 0; i < DIMS; i++) {
    const v = target[i]
    const over = v - max[i]
    const d = over > 0 ? over : (min[i] - v > 0 ? min[i] - v : 0)
    sum += d * d
  }
  return sum
}

export class ClimateTree {
  /** entries: [{ parameters, value }] in declaration order; value is any number. */
  constructor(entries) {
    if (entries.length === 0) throw new Error('A multi_noise biome source needs at least one biome.')
    const leaves = entries.map(({ parameters, value }) => {
      const p = parameters ?? {}
      const spans = [p.temperature, p.humidity, p.continentalness, p.erosion, p.depth, p.weirdness].map(span)
      const offset = quantize(typeof p.offset === 'number' ? p.offset : 0)
      return {
        min: [...spans.map(s => quantize(s[0])), offset],
        max: [...spans.map(s => quantize(s[1])), offset],
        children: null,
        value,
      }
    })
    this.root = build(leaves)
    this.target = new Float64Array(DIMS)
    this.bestDistance = Infinity
    this.bestLeaf = null
  }

  search(node) {
    const target = this.target
    for (const child of node.children) {
      const d = distance(child, target)
      if (this.bestDistance > d) {
        if (child.children === null) {
          this.bestDistance = d
          this.bestLeaf = child
        } else {
          this.search(child)
        }
      }
    }
  }

  /** Takes already-quantised climate values, returns the value of the closest entry. */
  find(temperature, humidity, continentalness, erosion, depth, weirdness) {
    const t = this.target
    t[0] = temperature
    t[1] = humidity
    t[2] = continentalness
    t[3] = erosion
    t[4] = depth
    t[5] = weirdness
    t[6] = 0
    if (this.root.children === null) return this.root.value
    this.bestDistance = Infinity
    this.bestLeaf = null
    this.search(this.root)
    return this.bestLeaf.value
  }
}
