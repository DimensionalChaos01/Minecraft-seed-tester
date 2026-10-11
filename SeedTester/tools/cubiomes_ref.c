// Generates the reference data used by the Seed Tester self-test.
//
// Build (from a cubiomes checkout, https://github.com/Cubitect/cubiomes):
//   zig cc -O2 -I <cubiomes> cubiomes_ref.c <cubiomes>/biomenoise.c <cubiomes>/biomes.c
//       <cubiomes>/generator.c <cubiomes>/layers.c <cubiomes>/noise.c <cubiomes>/util.c
//       <cubiomes>/finders.c <cubiomes>/quadbase.c -o cubiomes_ref.exe
// Run:
//   cubiomes_ref.exe <gridSize> <strideQuarts> <seed> [seed...] > cubiomes_reference.json
//
// For every seed it samples a gridSize x gridSize grid centred on 0,0 (spacing = strideQuarts * 4
// blocks) twice: once with depth forced to 0 (what the surface map uses) and once at y=64 with the
// real depth (what /locate biome uses).

#include "generator.h"
#include "util.h"
#include <stdio.h>
#include <stdlib.h>
#include <inttypes.h>

int main(int argc, char **argv)
{
    if (argc < 4)
    {
        fprintf(stderr, "usage: %s <gridSize> <strideQuarts> <seed> [seed...]\n", argv[0]);
        return 1;
    }
    int n = atoi(argv[1]);
    int stride = atoi(argv[2]);
    int half = n / 2;
    int quartY = 16; // y = 64

    Generator g;
    setupGenerator(&g, MC_1_20, 0);

    printf("{\n\"source\":\"cubiomes sampleBiomeNoise, MC_1_20\",\n");
    printf("\"gridSize\":%d,\n\"strideQuarts\":%d,\n\"quartY\":%d,\n", n, stride, quartY);

    printf("\"names\":{");
    int first = 1;
    for (int id = 0; id < 256; id++)
    {
        const char *s = biome2str(MC_1_20, id);
        if (!s)
            continue;
        printf("%s\"%d\":\"%s\"", first ? "" : ",", id, s);
        first = 0;
    }
    printf("},\n\"seeds\":[\n");

    long apiDiff = 0;
    for (int a = 3; a < argc; a++)
    {
        int64_t seed = strtoll(argv[a], NULL, 10);
        applySeed(&g, DIM_OVERWORLD, (uint64_t) seed);
        printf("{\"seed\":\"%" PRId64 "\",\n\"surface\":\"", seed);
        for (int j = 0; j < n; j++)
            for (int i = 0; i < n; i++)
            {
                int x = (i - half) * stride, z = (j - half) * stride;
                int id = sampleBiomeNoise(&g.bn, NULL, x, 0, z, NULL, SAMPLE_NO_DEPTH);
                printf("%02x", id & 0xff);
            }
        printf("\",\n\"y64\":\"");
        for (int j = 0; j < n; j++)
            for (int i = 0; i < n; i++)
            {
                int x = (i - half) * stride, z = (j - half) * stride;
                int id = sampleBiomeNoise(&g.bn, NULL, x, quartY, z, NULL, 0);
                if (id != getBiomeAt(&g, 4, x, quartY, z))
                    apiDiff++;
                printf("%02x", id & 0xff);
            }
        printf("\"}%s\n", a + 1 < argc ? "," : "");
    }
    printf("]\n}\n");
    fprintf(stderr, "sampleBiomeNoise vs getBiomeAt differences: %ld\n", apiDiff);
    return 0;
}
