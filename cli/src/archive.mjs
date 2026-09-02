import { gunzipSync } from 'node:zlib'
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, resolve, sep } from 'node:path'

// A reader and an extractor for the gzipped tar archives a release is made
// of: the npm tarball of `@curia-sh/cli`, the Compose bundle archive, and the
// Node.js runtime distribution. The questions asked of an archive are "which
// files are in it", "what do they hold", and, for `curia update` (#883),
// "put it on disk as the runtime and the package". A reader for that is
// short, and it keeps the package free of dependencies and the tests free of
// a system `tar`.
//
// It reads ustar and the pax and GNU variants that `npm pack`, GNU tar, and
// the Node.js release build produce: regular files by their full path, with
// the ustar prefix field and a pax `path` header honored, directories,
// symbolic links, and file modes. It refuses bytes it cannot read as an
// archive rather than returning a partial result, and an extraction refuses
// an entry or a link target that would land outside the destination.

export class ArchiveError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArchiveError'
  }
}

const BLOCK = 512

// Returns a Map from each regular file's path to its bytes.
export function readArchive(bytes) {
  const files = new Map()
  for (const entry of entries(bytes)) {
    if (entry.type === '0') files.set(entry.name, Buffer.from(entry.data))
  }
  return files
}

// Lands the archive under `dir`, which must exist, with the first `strip`
// path segments of every entry removed, so `node-v24.19.0-linux-x64/bin/node`
// becomes `<dir>/bin/node`. Regular files keep their mode bits, directories
// are created as needed, symbolic links are recreated with their targets.
// An entry that is not a file, a directory, or a symbolic link is skipped.
export function extractArchive(bytes, dir, { strip = 0 } = {}) {
  const base = resolve(dir)
  const inside = (name) => {
    const parts = name.split('/').filter((p) => p !== '' && p !== '.')
    if (parts.length <= strip) return null
    const target = resolve(base, ...parts.slice(strip))
    if (target !== base && !target.startsWith(base + sep)) throw new ArchiveError(`the archive entry ${name} would land outside ${dir}`)
    return target
  }
  for (const entry of entries(bytes)) {
    const target = inside(entry.name)
    if (target === null) continue
    if (entry.type === '5') {
      mkdirSync(target, { recursive: true })
    } else if (entry.type === '0') {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.data, { mode: entry.mode })
      chmodSync(target, entry.mode)
    } else if (entry.type === '2') {
      const pointed = normalize(join(dirname(target), entry.linkName))
      if (pointed !== base && !pointed.startsWith(base + sep)) throw new ArchiveError(`the archive link ${entry.name} points outside ${dir}`)
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(entry.linkName, target)
    }
  }
}

// Walks the archive one entry at a time: `{ name, type, mode, data, linkName }`
// for each entry that is not a pax or GNU header, with those headers already
// applied to the entry that follows them.
function* entries(bytes) {
  let tar
  try {
    tar = gunzipSync(bytes)
  } catch (e) {
    throw new ArchiveError(`not a gzip stream: ${e.message}`)
  }
  if (tar.length < BLOCK * 2 || tar.length % BLOCK !== 0) throw new ArchiveError('not a tar archive: the length is not whole blocks')

  let at = 0
  let paxPath = null
  let paxLink = null
  let longName = null
  let longLink = null
  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK)
    if (header.every((b) => b === 0)) break

    const magic = header.toString('latin1', 257, 263)
    if (!/^ustar/.test(magic)) throw new ArchiveError(`not a tar archive: no ustar header at block ${at / BLOCK}`)
    if (!checksumHolds(header)) throw new ArchiveError(`not a tar archive: the header checksum at block ${at / BLOCK} does not hold`)

    const size = parseInt(field(header, 124, 12), 8)
    if (!Number.isInteger(size) || size < 0) throw new ArchiveError(`not a tar archive: an unreadable size at block ${at / BLOCK}`)
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const dataStart = at + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new ArchiveError('the archive is truncated')
    const data = tar.subarray(dataStart, dataEnd)

    if (type === 'x') {
      paxPath = paxField(data, 'path')
      paxLink = paxField(data, 'linkpath')
    } else if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '')
    } else if (type === 'K') {
      longLink = data.toString('utf8').replace(/\0+$/, '')
    } else {
      let name = paxPath ?? longName ?? field(header, 0, 100)
      if (!paxPath && !longName) {
        const prefix = field(header, 345, 155)
        if (prefix) name = `${prefix}/${name}`
      }
      const mode = parseInt(field(header, 100, 8).trim(), 8) & 0o777
      const linkName = paxLink ?? longLink ?? field(header, 157, 100)
      yield { name, type, mode: Number.isInteger(mode) ? mode : 0o644, data, linkName }
      paxPath = null
      paxLink = null
      longName = null
      longLink = null
    }
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }
}

function field(header, start, length) {
  return header.toString('utf8', start, start + length).replace(/\0.*$/s, '')
}

function checksumHolds(header) {
  const stored = parseInt(field(header, 148, 8).trim(), 8)
  let sum = 0
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i]
  return sum === stored
}

// A pax extended header is `<length> <key>=<value>\n` records.
function paxField(data, key) {
  const text = data.toString('utf8')
  let at = 0
  while (at < text.length) {
    const space = text.indexOf(' ', at)
    if (space < 0) break
    const length = parseInt(text.slice(at, space), 10)
    if (!Number.isInteger(length) || length <= 0) break
    const record = text.slice(space + 1, at + length - 1)
    const eq = record.indexOf('=')
    if (eq > 0 && record.slice(0, eq) === key) return record.slice(eq + 1)
    at += length
  }
  return null
}
