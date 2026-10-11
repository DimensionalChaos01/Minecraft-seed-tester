# Seed Tester

Preview a Minecraft **1.20.1** world before you generate it. Seed Tester reads your datapacks,
picks a dimension, and for any seed it can:

- show an **interactive map** in your browser that you drag and zoom, like MineAtlas,
- **render** a biome map (PNG) with coordinates, a legend and statistics,
- **search** many seeds and rank them by rules you choose,
- **locate** biomes the same way `/locate biome` does, so you can check it against your server.

It works with custom dimensions of any height (for example `min_y 0`, `height 256`) and needs no
internet once installed.

## Install

1. Install **Node.js LTS** from <https://nodejs.org> (keep the default options).
2. That's all. The first time you double-click `seedtester.bat` it downloads two small libraries.

## Run

| Do this | What happens |
| --- | --- |
| Double-click `seedtester-map.bat` | Opens the interactive map in your browser. |
| Double-click `seedtester.bat` | Runs `config.json` from this folder and opens the result. |
| Drag a `.json` file onto `seedtester.bat` | Runs that config instead (try the ones in `examples`). |
| Double-click `selftest.bat` | Checks the engine against known-good data. Do this once. |

Results go to the `output` folder: a `.png` map and a `.json` file with the numbers.

## Interactive map

Double-click `seedtester-map.bat`. A black window appears and your browser opens the map. Keep
the black window open while you use it; close it to stop.

| To | Do this |
| --- | --- |
| Move | Drag the map, or use the arrow keys. |
| Zoom | Scroll the mouse wheel, double-click, pinch, or use the `+` / `−` buttons. |
| Open a world | Press **Load world…**, and in the folder window select the world folder (the one that contains `level.dat`). See below. |
| Change seed | Type a number or text in **Seed** and press **Load**. **Random** picks one. |
| Load datapacks | Press **Add datapack…** (or drop a `.zip` on the map), tick the packs you want, use ▲ ▼ to set the load order, choose a **Dimension**, press **Load selected dimension**. |
| Switch dimension | Choose it under **Dimension** and press **Load selected dimension**. |
| Read coordinates | Move the mouse: X, Z, biome and chunk are shown at the bottom. |
| Mark a spot | Click the map to drop a pin. **Copy /tp** copies a teleport command. |
| Jump somewhere | Type X and Z under **Go to**, or pick a biome and press **Find** (same search as `/locate biome`, from the middle of the map). |
| See structures | Open the **Structures** panel on the right and tick **Show structures on the map**. Untick types you don't want, hover a marker for its name, or click one in the nearest list to jump to it. The » button folds the panel away. |
| Highlight a biome | Click it in **Biomes in view**. |
| Save a picture | Press the ⤓ button. |

**Load world…** reads a world folder and sets everything up from it:

- the **seed**, from `level.dat`;
- the **datapacks** the world has enabled, from the world's own `datapacks` folder, in the
  world's load order;
- the **dimensions**, from those packs and from `level.dat` (so a customised overworld is shown
  as the world really has it).

For a server, the world folder is usually called `world` and sits next to `server.properties`.
Nothing in the world folder is changed. While a world is open its pack list is fixed; press
**Close** to go back to choosing packs yourself. Two limits: data that comes from a **mod**
rather than from the `datapacks` folder is not loaded (those entries are listed as "not
loaded"), and the map shows what the seed generates, not blocks players have changed. Worlds
from versions other than 1.20.x open with a warning, because their terrain rules can differ.

The map starts with the datapacks, dimension and seed from `config.json`. Datapacks you add are
copied into the `datapacks` folder. The address bar keeps the seed and position, so you can
bookmark a view. The map shows surface biomes; a blurry tile is a quick preview that sharpens
after a moment. The page only works on this computer: nothing is sent to the internet.

## Add your datapacks

1. Copy the datapack (`.zip`, a folder, or a mod `.jar` that contains worldgen data) into the
   `datapacks` folder.
2. Open `config.json` in Notepad and list the packs under `"datapacks"`, **in the same order your
   server loads them**. A later pack overrides an earlier one, as in Minecraft.
3. Set `"dimension"` to the dimension id, for example `"mypack:my_dimension"`.

```json
"datapacks": [
  "datapacks/my_pack.zip",
  "datapacks/another_pack.zip"
],
"dimension": "mypack:my_dimension",
```

Vanilla 1.20.1 data is built in and always loaded first, so packs that reference vanilla noises
or use `"preset": "minecraft:overworld"` just work. Not sure of the dimension id? Run
`seedtester.bat dimensions` from a command prompt to list every dimension in your packs.

Paths can be relative to the config file or full paths. In full paths use forward slashes:
`"C:/Users/You/Downloads/pack.zip"`.

## config.json

Only `datapacks` and `dimension` are required. Everything else has a default.

### General

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `"render"` | `"render"`, `"search"`, `"locate"` or `"selftest"`. |
| `datapacks` | `[]` | Packs in load order. Empty means vanilla only. |
| `dimension` | `"minecraft:overworld"` | Dimension id. |
| `seed` | `0` | A number (negative is fine) or text. Text is converted with Java's `String.hashCode()`, exactly like Minecraft. `"random"` picks a random seed. |
| `threads` | all cores but one | How many CPU threads to use. |
| `outputFolder` | `"output"` | Where results are written. |
| `outputName` | automatic | File name for the map, without `.png`. |

### Map area (render mode)

| Setting | Default | Meaning |
| --- | --- | --- |
| `centerX`, `centerZ` | `0`, `0` | Block coordinates of the middle of the map. |
| `size` | `8000` | Width of the area in blocks. Use `[16000, 8000]` for a non-square area. |
| `blocksPerPixel` | `8` | Scale. `4` is the finest that shows new detail (biomes are 4 blocks wide); bigger numbers are faster. Image width = `size` / `blocksPerPixel`. |
| `biomeLayer` | `"surface"` | `"surface"` shows the biome you see from above. `"exact"` shows the biome at height `y`, which can be a cave biome. |
| `y` | sea level + 1 | Height used by `"exact"`. |
| `grid` | `true` | Coordinate lines. `false` hides them; a number sets the spacing in blocks. |
| `legend` | `true` | Biome legend and summary. |
| `waterBiomes` | `["ocean"]` | A biome counts as ocean if its id contains one of these words. Add `"river"` to treat rivers as water too. |
| `colors` | `{}` | Your own colours, for example `{ "mypack:glow_forest": "#33ffcc" }`. |

Biome colours: vanilla biomes have built-in colours. A custom biome whose id ends in a vanilla
name (`mypack:plains`) gets that colour. Anything else gets a colour made from its id, the same
every time.

### Relief shading (optional, slow)

```json
"relief": { "enabled": true, "detail": 2 }
```

Shades the map by terrain height and draws a dark line at sea level. `detail` is how many pixels
share one height sample: `1` is sharpest, `2` is four times faster. Heights come from the
dimension's terrain noise, so trees, structures and surface decoration are not included. As a
guide, a 750 x 750 pixel map with `detail` 2 takes about 15 seconds. Use `"relief": false` to
turn it off.

### Structure overlay (optional)

```json
"structures": ["trail_ruins", "pillager_outpost", "village"]
```

Marks where structures can generate. `true` shows every structure that can appear in the
dimension, a list shows only those (a word matches any id containing it), `false` turns it off.

These are **candidates**: placement and biome are checked exactly like the game does, but the
game also runs terrain checks that can reject a few. Only `random_spread` structure sets are
supported, so strongholds are skipped. All positions are also listed in the stats `.json`.

### Seed search

Set `"mode": "search"`. Each seed is scanned at a coarse scale and scored.

```json
"search": {
  "seeds": { "from": 0, "count": 500 },
  "size": 16000,
  "blocksPerPixel": 64,
  "top": 10,
  "rules": [
    { "type": "land_at", "x": 0, "z": 0, "weight": 10, "required": true },
    { "type": "continent", "minAreaKm2": 20, "withinBlocks": 2000, "weight": 10 },
    { "type": "ocean_percent", "min": 40, "max": 75, "weight": 5 },
    { "type": "biomes_within", "biomes": ["plains", "forest", "jungle"], "withinBlocks": 4000, "weight": 5 }
  ]
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `seeds` | `{ "from": 0, "count": 200 }` | `{ "from": 0, "count": 500 }`, `{ "from": 0, "to": 499 }`, `{ "random": 500 }`, or a list like `[12, -99, "my seed"]`. |
| `size` | `16000` | Area scanned per seed, in blocks, centred on `centerX`/`centerZ`. |
| `blocksPerPixel` | `64` | Scan scale. `128` is four times faster but misses small islands. |
| `top` | `10` | How many seeds to keep. Each gets a thumbnail. |
| `rules` | land at 0,0 | See below. |

Rules:

| `type` | Extra settings | Satisfied when |
| --- | --- | --- |
| `land_at` | `x`, `z` | That spot is not ocean. |
| `biome_at` | `x`, `z`, `biomes` | That spot is one of the listed biomes. |
| `continent` | `minAreaKm2`, `withinBlocks`, `x`, `z` | A landmass of at least that size reaches within that distance of the spot. |
| `ocean_percent` | `min`, `max` | The share of ocean in the scanned area is in that range. |
| `biomes_within` | `biomes`, `withinBlocks`, `x`, `z` | Every listed biome occurs within that distance. |

Every rule has a `weight` (default 1). A fully satisfied rule adds its weight to the score; a
partly satisfied one adds part of it (for example 2 of 3 biomes found, or a continent half the
requested size). Add `"required": true` to throw away seeds that fail a rule. `x` and `z` default
to 0. Biome names can be full ids (`"mypack:plains"`) or just the last part (`"plains"`).

If many seeds reach the top score, they are listed lowest seed first; make the rules stricter to
separate them. On a 6-core laptop the example above scans about 5 seeds per second.

The results folder contains one thumbnail per top seed and `results.json` with every seed's score.

### Locate (accuracy check)

Set `"mode": "locate"`.

```json
"locate": { "biome": "all", "from": [0, 64, 0] }
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `biome` | `"all"` | A biome id, a list of ids, a tag (`"#minecraft:is_ocean"`), or `"all"`. |
| `from` | `[0, 64, 0]` | Start position: x, y, z. |
| `radius` | `6400` | Search distance in blocks (the game uses 6400). |

It prints the nearest position of each biome, found with the same search pattern the game uses
(every 32 blocks outward, several heights 64 blocks apart, real biome at that exact position).

## Is it accurate?

Two ways to check, and you should do both once.

**1. Self-test.** Double-click `selftest.bat`. It renders vanilla `minecraft:overworld` for four
seeds and compares 131,072 points with **cubiomes**, an independent C implementation of
Minecraft's biome generator. Expected result: `0 mismatches`. The cubiomes answers are stored in
`data/selftest`, so the test needs no compiler.

**2. Your own server.** Set `"mode": "locate"` in a config that lists your packs and dimension, run it, then on your
server, for a few biomes from the printed table, run:

```
/execute in mypack:my_dimension positioned 0 64 0 run locate biome mypack:jungle
```

The game should answer with the same X, Y, Z and the same "blocks away". The `execute ... positioned`
part matters: `/locate` searches from where the command is run, and the server console is in the
overworld.

What was verified while building this (seed 0 and three others, against cubiomes):

- Biomes: 0 differences in 131,072 points, for surface biomes and for biomes at Y 64. All six
  climate values match to the last digit.
- Structure placement: identical positions for 10 vanilla structure sets on two seeds.
- The 7,593-entry vanilla overworld biome list decoded from cubiomes matches Mojang's 1.20.1 list.

Your custom dimension uses the same engine with your pack's numbers, but cubiomes cannot load
datapacks, so the server check in step 2 is the real proof for it.

## Good to know

- **Maps show biomes, not blocks.** Coastlines follow biome borders. Relief shading shows the
  actual terrain height if you need it.
- **deepslate bug fixed here.** The worldgen library this tool uses (deepslate 0.20.0) leaves out
  a `x 4` in Minecraft's `shift_a`/`shift_b` functions, which shifts biomes by up to about 12
  blocks. Seed Tester corrects it at start-up (`src/deepslate-fixes.js`) and says so in its
  output. Do not upgrade deepslate without re-running the self-test.
- **Biome borders use Minecraft 1.20.1's exact lookup** (`src/tree.js`), not deepslate's, because
  the two disagree on exact border ties.
- Supported: `noise` generators with `multi_noise` (explicit list or the `overworld`/`nether`
  presets), `fixed`, `checkerboard` and `the_end` biome sources, and `flat` worlds. Mods that
  generate terrain in code rather than in datapack files cannot be previewed.
- A landmass marked "cut off" continues beyond the edge of the map, so its real size is larger.

## Sharing and credits

Seed Tester is not an official Minecraft product and is not approved by or associated with
Mojang or Microsoft. See `THIRD-PARTY.md` for the libraries and data it builds on. The
`datapacks` and `output` folders are left out of version control on purpose (`.gitignore`), so
nobody's own pack gets published by accident.

The `.bat` launchers and the **Load world…** folder window are Windows-only. On other systems
run `npm install` once, then `node src/cli.js map` (add `--world <folder>` to open a world).

## Files

```
seedtester-map.bat             interactive map
seedtester.bat, selftest.bat   PNG / search / locate launcher, self-test
web/                           the map page
config.json                    your settings
datapacks/                     put your packs here
examples/                      ready-made configs to try
output/                        results
src/                           the program
data/vanilla/                  vanilla 1.20.1 worldgen data (from misode/mcmeta, tag 1.20.1-data)
data/presets/                  expanded vanilla biome lists for "preset"
data/selftest/                 cubiomes reference results
tools/                         how the preset and reference data were produced
```

From a command prompt you can also run `node src/cli.js config.json`, add `--seed 123` or
`--threads 4` to override the config, or use `node src/cli.js selftest`.
