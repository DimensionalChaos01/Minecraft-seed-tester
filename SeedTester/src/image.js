// A tiny RGBA canvas with a built-in 5x7 pixel font and a PNG writer (no native dependencies).

import fs from 'node:fs'
import zlib from 'node:zlib'

// ---- PNG -------------------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

export function encodePng(width, height, rgba) {
  // Opaque images only need RGB, which keeps large maps small.
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    let o = y * stride + 1
    let i = y * width * 4
    for (let x = 0; x < width; x++) {
      raw[o++] = rgba[i]
      raw[o++] = rgba[i + 1]
      raw[o++] = rgba[i + 2]
      i += 4
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- Font ------------------------------------------------------------------------------------

// One glyph per line: the character, then 7 rows of 5 pixels (top to bottom).
const FONT_SOURCE = `
! ..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..
" .#.#. .#.#. .#.#. ..... ..... ..... .....
# .#.#. .#.#. ##### .#.#. ##### .#.#. .#.#.
$ ..#.. .#### #.#.. .###. ..#.# ####. ..#..
% ##..# ##.#. ...#. ..#.. .#... .#.## #..##
& .##.. #..#. #.#.. .#... #.#.# #..#. .##.#
' ..#.. ..#.. ..#.. ..... ..... ..... .....
( ...#. ..#.. .#... .#... .#... ..#.. ...#.
) .#... ..#.. ...#. ...#. ...#. ..#.. .#...
* ..... ..#.. #.#.# .###. #.#.# ..#.. .....
+ ..... ..#.. ..#.. ##### ..#.. ..#.. .....
, ..... ..... ..... ..... .##.. ..#.. .#...
- ..... ..... ..... ##### ..... ..... .....
. ..... ..... ..... ..... ..... .##.. .##..
/ ..... ....# ...#. ..#.. .#... #.... .....
0 .###. #...# #..## #.#.# ##..# #...# .###.
1 ..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.
2 .###. #...# ....# ...#. ..#.. .#... #####
3 ##### ...#. ..#.. ...#. ....# #...# .###.
4 ...#. ..##. .#.#. #..#. ##### ...#. ...#.
5 ##### #.... ####. ....# ....# #...# .###.
6 ..##. .#... #.... ####. #...# #...# .###.
7 ##### ....# ...#. ..#.. .#... .#... .#...
8 .###. #...# #...# .###. #...# #...# .###.
9 .###. #...# #...# .#### ....# ...#. .##..
: ..... .##.. .##.. ..... .##.. .##.. .....
; ..... .##.. .##.. ..... .##.. ..#.. .#...
< ...#. ..#.. .#... #.... .#... ..#.. ...#.
= ..... ..... ##### ..... ##### ..... .....
> .#... ..#.. ...#. ....# ...#. ..#.. .#...
? .###. #...# ....# ...#. ..#.. ..... ..#..
@ .###. #...# ....# .##.# #.#.# #.#.# .###.
A .###. #...# #...# #...# ##### #...# #...#
B ####. #...# #...# ####. #...# #...# ####.
C .###. #...# #.... #.... #.... #...# .###.
D ###.. #..#. #...# #...# #...# #..#. ###..
E ##### #.... #.... ####. #.... #.... #####
F ##### #.... #.... ####. #.... #.... #....
G .###. #...# #.... #.### #...# #...# .####
H #...# #...# #...# ##### #...# #...# #...#
I .###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.
J ..### ...#. ...#. ...#. ...#. #..#. .##..
K #...# #..#. #.#.. ##... #.#.. #..#. #...#
L #.... #.... #.... #.... #.... #.... #####
M #...# ##.## #.#.# #.#.# #...# #...# #...#
N #...# #...# ##..# #.#.# #..## #...# #...#
O .###. #...# #...# #...# #...# #...# .###.
P ####. #...# #...# ####. #.... #.... #....
Q .###. #...# #...# #...# #.#.# #..#. .##.#
R ####. #...# #...# ####. #.#.. #..#. #...#
S .#### #.... #.... .###. ....# ....# ####.
T ##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..
U #...# #...# #...# #...# #...# #...# .###.
V #...# #...# #...# #...# #...# .#.#. ..#..
W #...# #...# #...# #.#.# #.#.# #.#.# .#.#.
X #...# #...# .#.#. ..#.. .#.#. #...# #...#
Y #...# #...# #...# .#.#. ..#.. ..#.. ..#..
Z ##### ....# ...#. ..#.. .#... #.... #####
[ .###. .#... .#... .#... .#... .#... .###.
\\ ..... #.... .#... ..#.. ...#. ....# .....
] .###. ...#. ...#. ...#. ...#. ...#. .###.
^ ..#.. .#.#. #...# ..... ..... ..... .....
_ ..... ..... ..... ..... ..... ..... #####
\` .#... ..#.. ...#. ..... ..... ..... .....
a ..... ..... .###. ....# .#### #...# .####
b #.... #.... #.##. ##..# #...# #...# ####.
c ..... ..... .###. #.... #.... #...# .###.
d ....# ....# .##.# #..## #...# #...# .####
e ..... ..... .###. #...# ##### #.... .###.
f ..##. .#..# .#... ###.. .#... .#... .#...
g .#### #...# #...# #...# .#### ....# .###.
h #.... #.... #.##. ##..# #...# #...# #...#
i ..#.. ..... .##.. ..#.. ..#.. ..#.. .###.
j ...#. ..... ..##. ...#. ...#. #..#. .##..
k #.... #.... #..#. #.#.. ##... #.#.. #..#.
l .##.. ..#.. ..#.. ..#.. ..#.. ..#.. .###.
m ..... ..... ##.#. #.#.# #.#.# #...# #...#
n ..... ..... #.##. ##..# #...# #...# #...#
o ..... ..... .###. #...# #...# #...# .###.
p ####. #...# #...# #...# ####. #.... #....
q .#### #...# #...# #...# .#### ....# ....#
r ..... ..... #.##. ##..# #.... #.... #....
s ..... ..... .###. #.... .###. ....# ####.
t .#... .#... ###.. .#... .#... .#..# ..##.
u ..... ..... #...# #...# #...# #..## .##.#
v ..... ..... #...# #...# #...# .#.#. ..#..
w ..... ..... #...# #...# #.#.# #.#.# .#.#.
x ..... ..... #...# .#.#. ..#.. .#.#. #...#
y #...# #...# #...# #...# .#### ....# .###.
z ..... ..... ##### ...#. ..#.. .#... #####
{ ...#. ..#.. ..#.. .#... ..#.. ..#.. ...#.
| ..#.. ..#.. ..#.. ..#.. ..#.. ..#.. ..#..
} .#... ..#.. ..#.. ...#. ..#.. ..#.. .#...
~ ..... ..... .#... #.#.# ...#. ..... .....
² .##.. ...#. ..#.. .###. ..... ..... .....
`

const GLYPHS = new Map()
for (const line of FONT_SOURCE.split('\n')) {
  if (line.length < 3) continue
  const rows = line.slice(2).trim().split(/\s+/)
  GLYPHS.set(line[0], rows.map(row => [...row].map(c => c === '#')))
}

// These letters are drawn two rows lower, so their tails hang below the line.
const DESCENDERS = new Set(['g', 'p', 'q', 'y'])

export const GLYPH_W = 6 // 5 pixels + 1 spacing
export const GLYPH_H = 7

export function textWidth(text, scale = 1) {
  return String(text).length * GLYPH_W * scale
}

// ---- Canvas ----------------------------------------------------------------------------------

export class Canvas {
  constructor(width, height, background = [255, 255, 255]) {
    this.width = width
    this.height = height
    this.data = new Uint8ClampedArray(width * height * 4)
    this.fillRect(0, 0, width, height, background)
  }

  setPixel(x, y, color, alpha = 1) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const i = (y * this.width + x) * 4
    const d = this.data
    if (alpha >= 1) {
      d[i] = color[0]
      d[i + 1] = color[1]
      d[i + 2] = color[2]
    } else {
      d[i] += (color[0] - d[i]) * alpha
      d[i + 1] += (color[1] - d[i + 1]) * alpha
      d[i + 2] += (color[2] - d[i + 2]) * alpha
    }
    d[i + 3] = 255
  }

  /** Lightens dark pixels and darkens light ones, so a line stays visible on any biome colour. */
  contrastPixel(x, y, alpha) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const i = (y * this.width + x) * 4
    const d = this.data
    const luminance = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    const target = luminance < 110 ? 255 : 0
    d[i] += (target - d[i]) * alpha
    d[i + 1] += (target - d[i + 1]) * alpha
    d[i + 2] += (target - d[i + 2]) * alpha
  }

  fillRect(x, y, w, h, color, alpha = 1) {
    const x1 = Math.max(0, x)
    const y1 = Math.max(0, y)
    const x2 = Math.min(this.width, x + w)
    const y2 = Math.min(this.height, y + h)
    for (let py = y1; py < y2; py++) {
      for (let px = x1; px < x2; px++) this.setPixel(px, py, color, alpha)
    }
  }

  strokeRect(x, y, w, h, color) {
    this.fillRect(x, y, w, 1, color)
    this.fillRect(x, y + h - 1, w, 1, color)
    this.fillRect(x, y, 1, h, color)
    this.fillRect(x + w - 1, y, 1, h, color)
  }

  /** Ring centred on (cx, cy) covering radii rInner..rOuter, with soft edges. */
  ring(cx, cy, rInner, rOuter, color) {
    const r = Math.ceil(rOuter) + 1
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.hypot(dx, dy)
        const coverage = Math.min(1, dist - rInner + 0.5, rOuter - dist + 0.5)
        if (coverage > 0) this.setPixel(Math.round(cx) + dx, Math.round(cy) + dy, color, coverage)
      }
    }
  }

  text(x, y, text, color = [0, 0, 0], scale = 1) {
    let cx = x
    for (const ch of String(text)) {
      const glyph = GLYPHS.get(ch) ?? (ch === ' ' ? null : GLYPHS.get('?'))
      if (glyph) {
        const drop = DESCENDERS.has(ch) ? 2 : 0
        for (let gy = 0; gy < GLYPH_H; gy++) {
          for (let gx = 0; gx < 5; gx++) {
            if (glyph[gy][gx]) this.fillRect(cx + gx * scale, y + (gy + drop) * scale, scale, scale, color)
          }
        }
      }
      cx += GLYPH_W * scale
    }
    return cx
  }

  /** Text with a one-pixel outline, readable on top of the map. */
  outlinedText(x, y, text, color = [255, 255, 255], outline = [0, 0, 0], scale = 1) {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
      this.text(x + dx, y + dy, text, outline, scale)
    }
    this.text(x, y, text, color, scale)
  }

  save(file) {
    fs.writeFileSync(file, encodePng(this.width, this.height, this.data))
  }
}
