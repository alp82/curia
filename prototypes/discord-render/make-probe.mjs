// Builds the image probe for ticket #414: one PNG that asks the operator a
// single question. Which text scale is still readable when Discord shows the
// image inline on a phone?
//
// The probe prints the same line at four pixel scales. The operator names the
// smallest scale they can read. That number tells the map whether a diagram
// survives the thread thumbnail, or whether a visual must be a link instead.
//
// No image library exists in this container, so this file writes the PNG by
// hand: a 5x7 bitmap font, an RGB raster, and zlib for the IDAT chunk.

import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 5x7 glyphs, one string of 7 rows per character. `#` is ink.
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '11110', '10001', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '11110', '10000', '10000', '10000', '11111'],
  F: ['11111', '10000', '11110', '10000', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '11111', '10001', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '11100', '10100', '10010', '10001', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10001', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '?': ['01110', '10001', '00001', '00110', '00100', '00000', '00100'],
  '#': ['01010', '11111', '01010', '01010', '11111', '01010', '00000'],
}

const GLYPH_W = 5
const GLYPH_H = 7

class Raster {
  constructor(width, height, bg) {
    this.width = width
    this.height = height
    this.data = Buffer.alloc(width * height * 3)
    for (let i = 0; i < width * height; i++) {
      this.data[i * 3] = bg[0]
      this.data[i * 3 + 1] = bg[1]
      this.data[i * 3 + 2] = bg[2]
    }
  }

  pixel(x, y, rgb) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const i = (y * this.width + x) * 3
    this.data[i] = rgb[0]
    this.data[i + 1] = rgb[1]
    this.data[i + 2] = rgb[2]
  }

  rect(x, y, w, h, rgb) {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.pixel(x + dx, y + dy, rgb)
  }

  text(str, x, y, scale, rgb) {
    let cx = x
    for (const raw of str.toUpperCase()) {
      const glyph = FONT[raw] ?? FONT['?']
      for (let gy = 0; gy < GLYPH_H; gy++) {
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (glyph[gy][gx] === '1') this.rect(cx + gx * scale, y + gy * scale, scale, scale, rgb)
        }
      }
      cx += (GLYPH_W + 1) * scale
    }
    return cx
  }
}

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, body) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([len, typed, crc])
}

function encodePng(raster) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(raster.width, 0)
  ihdr.writeUInt32BE(raster.height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const stride = raster.width * 3
  const rows = Buffer.alloc((stride + 1) * raster.height)
  for (let y = 0; y < raster.height; y++) {
    rows[y * (stride + 1)] = 0 // filter: none
    raster.data.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Discord's own dark thread background, so the probe looks like a message.
const BG = [49, 51, 56]
const INK = [219, 222, 225]
const DIM = [148, 155, 164]
const MARK = [87, 242, 135]

const WIDTH = 800
const HEIGHT = 360
const r = new Raster(WIDTH, HEIGHT, BG)

r.rect(0, 0, WIDTH, 3, MARK)
r.text('TICKET 414 - IMAGE PROBE', 24, 24, 3, MARK)
r.text('NAME THE SMALLEST SCALE YOU CAN READ ON YOUR PHONE.', 24, 60, 2, DIM)

// 21 characters at scale 4 is 504 px wide, so the longest row still clears the
// 636 px the label column leaves. A clipped row would make a bad probe.
const SAMPLE = 'TYPED PAYLOAD SCALE'
let y = 104
for (const scale of [4, 3, 2, 1]) {
  r.text(`SCALE ${scale}`, 24, y, 2, MARK)
  r.text(`${SAMPLE} ${scale}`, 140, y - 2, scale, INK)
  y += GLYPH_H * scale + 30
}

r.rect(24, HEIGHT - 60, WIDTH - 48, 1, DIM)
r.text('IMAGE IS 800 X 360. DISCORD SCALES IT TO THE THREAD WIDTH.', 24, HEIGHT - 44, 2, DIM)

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'image-probe.png')
fs.writeFileSync(out, encodePng(r))
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`)
