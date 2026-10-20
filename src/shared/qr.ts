// A small QR code encoder (ISO/IEC 18004): byte mode, versions 1-10, error correction L or M, with
// the standard mask choice. Enough for a link of up to ~210 bytes, which is what the phone Inbox shows.
// Checked module by module against an independent encoder in test/unit/qr.test.ts.

export type Ecc = 'L' | 'M'

// [ecc codewords per block, blocks in group 1, data codewords per block in group 1, blocks in group 2, data per block in group 2]
const BLOCKS: Record<Ecc, [number, number, number, number, number][]> = {
  L: [
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69]
  ],
  M: [
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44]
  ]
}
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]
const ECC_BITS: Record<Ecc, number> = { L: 0b01, M: 0b00 }

// Every index in this file is inside its array by construction — the sizes come from the version,
// and the version is checked once on the way in. These three say that out loud instead of each
// read handling a case that cannot happen: if an index ever does go out of range the encoder
// stops and says which one, rather than letting undefined become NaN and a code that scans as
// nothing. The test checks every version, level and mask module for module, so a wrong index here
// is a failing assertion rather than a silently wrong code.

/** An element of one of the encoder's own numeric arrays. */
const at = (a: ArrayLike<number>, i: number): number => {
  const v = a[i]
  if (v === undefined) throw new Error(`qr: index ${i} is outside 0..${a.length - 1}`)
  return v
}

/** A module of a matrix, by (x, y) — so the two cannot be swapped silently as m[y][x] allows. */
const cell = (m: boolean[][], x: number, y: number): boolean => {
  const row = m[y]
  if (!row) throw new Error(`qr: row ${y} is outside 0..${m.length - 1}`)
  const v = row[x]
  if (v === undefined) throw new Error(`qr: column ${x} is outside 0..${row.length - 1}`)
  return v
}

const put = (m: boolean[][], x: number, y: number, on: boolean): void => {
  const row = m[y]
  if (!row) throw new Error(`qr: row ${y} is outside 0..${m.length - 1}`)
  if (x < 0 || x >= row.length) throw new Error(`qr: column ${x} is outside 0..${row.length - 1}`)
  row[x] = on
}

/** The block layout for a version and error level: [ecc per block, b1, d1, b2, d2]. */
function blocksFor(version: number, ecc: Ecc): [number, number, number, number, number] {
  const spec = BLOCKS[ecc][version - 1]
  if (!spec) throw new Error(`qr: version ${version} is outside 1-10`)
  return spec
}

/** Where a version's alignment patterns are centred. */
function alignFor(version: number): number[] {
  const pos = ALIGN[version - 1]
  if (!pos) throw new Error(`qr: version ${version} is outside 1-10`)
  return pos
}

// ---------------------------------------------------------------- Reed-Solomon over GF(256), x^8+x^4+x^3+x^2+1

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x
  LOG[x] = i
  x <<= 1
  if (x & 0x100) x ^= 0x11d
}
for (let i = 255; i < 512; i++) EXP[i] = at(EXP, i - 255)
const mul = (a: number, b: number) => (a && b ? at(EXP, at(LOG, a) + at(LOG, b)) : 0)

function rsGenerator(degree: number): number[] {
  let g = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0)
    for (let j = 0; j < g.length; j++) {
      next[j] = at(next, j) ^ at(g, j)
      next[j + 1] = at(next, j + 1) ^ mul(at(g, j), at(EXP, i))
    }
    g = next
  }
  return g
}

function rsRemainder(data: number[], degree: number): number[] {
  const gen = rsGenerator(degree)
  const rem = new Array(degree).fill(0)
  for (const d of data) {
    const factor = d ^ rem.shift()!
    rem.push(0)
    for (let i = 0; i < degree; i++) rem[i] = at(rem, i) ^ mul(at(gen, i + 1), factor)
  }
  return rem
}

// ---------------------------------------------------------------- data codewords

function capacity(version: number, ecc: Ecc) {
  const [, b1, d1, b2, d2] = blocksFor(version, ecc)
  return b1 * d1 + b2 * d2
}

function dataCodewords(bytes: Uint8Array, version: number, ecc: Ecc): number[] {
  const bits: number[] = []
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1)
  }
  put(0b0100, 4) // byte mode
  put(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  const total = capacity(version, ecc) * 8
  put(0, Math.min(4, total - bits.length)) // terminator
  while (bits.length % 8) bits.push(0)
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  for (let pad = 0; out.length < total / 8; pad++) out.push(pad % 2 ? 0x11 : 0xec)
  return out
}

/** Split into blocks, add error correction to each, interleave. */
function codewords(data: number[], version: number, ecc: Ecc): number[] {
  const [ec, b1, d1, b2, d2] = blocksFor(version, ecc)
  const blocks: number[][] = []
  let start = 0
  for (let i = 0; i < b1 + b2; i++) {
    const n = i < b1 ? d1 : d2
    blocks.push(data.slice(start, start + n))
    start += n
  }
  const ecs = blocks.map((b) => rsRemainder(b, ec))
  const out: number[] = []
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.length) out.push(at(b, i))
  for (let i = 0; i < ec; i++) for (const e of ecs) out.push(at(e, i))
  return out
}

// ---------------------------------------------------------------- matrix

type Grid = { size: number; dark: boolean[][]; fixed: boolean[][] }

function functionPatterns(version: number): Grid {
  const size = version * 4 + 17
  const dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (x: number, y: number, on: boolean) => {
    put(dark, x, y, on)
    put(fixed, x, y, true)
  }
  // finders with their separators
  const finders: [number, number][] = [
    [3, 3],
    [size - 4, 3],
    [3, size - 4]
  ]
  for (const [fx, fy] of finders) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = fx + dx
        const y = fy + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        set(x, y, d !== 2 && d !== 4)
      }
  }
  // timing
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  // alignment
  const pos = alignFor(version)
  for (const ay of pos)
    for (const ax of pos) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  // reserve format areas (filled per mask) and the dark module
  for (let i = 0; i < 9; i++) {
    if (!cell(fixed, i, 8)) set(i, 8, false)
    if (!cell(fixed, 8, i)) set(8, i, false)
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8, false)
    set(8, size - 1 - i, false)
  }
  set(8, size - 8, true)
  // version information (7+)
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(a, b, on)
      set(b, a, on)
    }
  }
  return { size, dark, fixed }
}

function placeData(g: Grid, words: number[]) {
  let bit = 0
  const total = words.length * 8
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < g.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? g.size - 1 - vert : vert
        if (cell(g.fixed, x, y)) continue
        if (bit < total) put(g.dark, x, y, ((at(words, bit >>> 3) >>> (7 - (bit & 7))) & 1) === 1)
        bit++
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
]

function applyMask(g: Grid, mask: number): boolean[][] {
  const flip = MASKS[mask]
  if (!flip) throw new Error(`qr: mask ${mask} is outside 0-7`)
  const out = g.dark.map((row) => row.slice())
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!cell(g.fixed, x, y) && flip(x, y)) put(out, x, y, !cell(out, x, y))
  return out
}

function drawFormat(m: boolean[][], ecc: Ecc, mask: number) {
  const size = m.length
  const data = (ECC_BITS[ecc] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412
  const bit = (i: number) => ((bits >>> i) & 1) === 1
  for (let i = 0; i <= 5; i++) put(m, 8, i, bit(i))
  put(m, 8, 7, bit(6))
  put(m, 8, 8, bit(7))
  put(m, 7, 8, bit(8))
  for (let i = 9; i < 15; i++) put(m, 14 - i, 8, bit(i))
  for (let i = 0; i < 8; i++) put(m, size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) put(m, 8, size - 15 + i, bit(i))
  put(m, 8, size - 8, true)
}

function penalty(m: boolean[][]): number {
  const size = m.length
  let score = 0
  // runs of 5+ in rows and columns, and finder-like patterns
  for (const horizontal of [true, false]) {
    for (let a = 0; a < size; a++) {
      let run = 1
      const mod = (b: number) => (horizontal ? cell(m, b, a) : cell(m, a, b))
      for (let b = 1; b < size; b++) {
        if (mod(b) === mod(b - 1)) run++
        else {
          if (run >= 5) score += run - 2
          run = 1
        }
      }
      if (run >= 5) score += run - 2
      for (let b = 0; b + 10 < size; b++) {
        const seq = Array.from({ length: 11 }, (_, k) => mod(b + k))
        const p1 = [true, false, true, true, true, false, true, false, false, false, false]
        const p2 = [false, false, false, false, true, false, true, true, true, false, true]
        if (seq.every((v, k) => v === p1[k]) || seq.every((v, k) => v === p2[k])) score += 40
      }
    }
  }
  // 2x2 blocks
  for (let y = 0; y + 1 < size; y++)
    for (let x = 0; x + 1 < size; x++) {
      const c = cell(m, x, y)
      if (c === cell(m, x + 1, y) && c === cell(m, x, y + 1) && c === cell(m, x + 1, y + 1)) score += 3
    }
  // dark balance
  let darkCount = 0
  for (const row of m) for (const v of row) if (v) darkCount++
  const total = size * size
  score += Math.floor(Math.abs(darkCount * 20 - total * 10) / total) * 10
  return score
}

/**
 * Encode text as a QR code. Returns the module matrix (true = dark), without the quiet zone.
 * `version`/`mask` force a choice (tests); by default the smallest version and best mask are used.
 */
export function qrEncode(text: string, opts: { ecc?: Ecc; version?: number; mask?: number } = {}): boolean[][] {
  const ecc = opts.ecc ?? 'M'
  const bytes = new TextEncoder().encode(text)
  let version = opts.version ?? 0
  if (!version) {
    for (let v = 1; v <= 10; v++) {
      if (bytes.length + (v < 10 ? 2 : 3) <= capacity(v, ecc)) {
        version = v
        break
      }
    }
  }
  if (!version || version > 10 || bytes.length + (version < 10 ? 2 : 3) > capacity(version, ecc)) throw new Error(`text too long for a QR code here (${bytes.length} bytes)`)
  const grid = functionPatterns(version)
  placeData(grid, codewords(dataCodewords(bytes, version, ecc), version, ecc))
  let best: boolean[][] | null = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    if (opts.mask !== undefined && mask !== opts.mask) continue
    const m = applyMask(grid, mask)
    drawFormat(m, ecc, mask)
    const s = penalty(m)
    if (s < bestScore) {
      best = m
      bestScore = s
    }
  }
  // only reachable through a forced mask outside 0-7, which the tests do not pass and the app
  // cannot: either way a null matrix must not leave here typed as a matrix
  if (!best) throw new Error(`qr: mask ${String(opts.mask)} is outside 0-7`)
  return best
}

/** An SVG of the code with a 4-module quiet zone, scaled to `size` pixels. */
export function qrSvg(text: string, size = 220, opts: { ecc?: Ecc } = {}): string {
  const m = qrEncode(text, opts)
  const n = m.length + 8
  let path = ''
  m.forEach((row, y) => row.forEach((on, x) => on && (path += `M${x + 4} ${y + 4}h1v1h-1z`)))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}
