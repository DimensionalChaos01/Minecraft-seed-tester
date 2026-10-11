// Corrections for places where deepslate differs from Minecraft 1.20.1.
// Each one probes for the problem first, so a fixed deepslate release is left alone.

import { DensityFunction } from 'deepslate'

export const appliedFixes = []

// 1. shift_a / shift_b / shift: Minecraft computes offsetNoise(x/4, y/4, z/4) * 4.0.
//    deepslate 0.20.0 leaves out the "* 4.0" (its maxValue() includes it, compute() does not),
//    which moves every climate noise by up to ~12 blocks. Found by comparing against cubiomes:
//    ~3.5% of sampled biomes were wrong without this, 0 with it.
{
  const probeNoise = { sample: () => 1, maxValue: 2 }
  const probe = new DensityFunction.ShiftA(undefined, probeNoise)
  if (probe.compute({ x: 0, y: 0, z: 0 }) === 1) {
    DensityFunction.ShiftNoise.prototype.compute = function (context) {
      return (this.offsetNoise?.sample(context.x * 0.25, context.y * 0.25, context.z * 0.25) ?? 0) * 4
    }
    appliedFixes.push('shift noise x4')
  }
}
