import { gunzipSync } from 'node:zlib'

// A reader for the two archives a release verification opens: the npm
// tarball of `@curia-sh/cli` and the Compose bundle archive. Both are gzipped
// tar archives, and the questions asked of them are "which files are in it"
// and "what do they hold". A reader for that is short, and it keeps the
// package free of dependencies and the tests free of a system `tar`.
//
// It reads ustar and the pax and GNU variants that `npm pack` and GNU tar
// produce: regular files by their full path, with the ustar prefix field and a
// pax `path` header honored, and every other entry type skipped. It refuses
// bytes it cannot read as an archive rather than returning a partial map.

export class ArchiveError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArchiveError'
  }
}

const BLOCK = 512

// Returns a Map from each regular file's path to its bytes.
export function readArchive(bytes) {
  let tar
  try {
    tar = gunzipSync(bytes)
  } catch (e) {
    throw new ArchiveError(`not a gzip stream: ${e.message}`)
  }
  if (tar.length < BLOCK * 2 || tar.length % BLOCK !== 0) throw new ArchiveError('not a tar archive: the length is not whole blocks')

  const files = new Map()
  let at = 0
  let paxPath = null
  let longName = null
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
    } else if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '')
    } else {
      let name = paxPath ?? longName ?? field(header, 0, 100)
      if (!paxPath && !longName) {
        const prefix = field(header, 345, 155)
        if (prefix) name = `${prefix}/${name}`
      }
      if (type === '0') files.set(name, Buffer.from(data))
      paxPath = null
      longName = null
    }
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }
  return files
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
