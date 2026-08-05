#!/usr/bin/env python3
"""Render the Open Graph card for https://curia.sh into docs/og.png.

The box that runs this has no image library and no browser, so everything here
is Python's standard library: a TrueType reader, a scanline rasterizer and a
PNG writer. Re-run it whenever the card's words change.

    python3 bin/og-card.py

The card is 1200x630, the size every link preview crops to.
"""

import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SANS_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
MONO = "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf"

# The page's own palette (docs/index.html).
BG = (0x0E, 0x10, 0x13)
PANEL = (0x14, 0x17, 0x1C)
LINE = (0x26, 0x2B, 0x33)
TEXT = (0xE6, 0xE8, 0xEC)
DIM = (0x96, 0x9B, 0xA5)
ACCENT = (0x7D, 0xD3, 0xA0)

W, H = 1200, 630
SS = 4  # vertical supersampling; horizontal coverage is exact


# --------------------------------------------------------------- TrueType ---

class Font:
    def __init__(self, path):
        with open(path, "rb") as fh:
            self.data = fh.read()
        self.tables = {}
        num_tables = struct.unpack(">H", self.data[4:6])[0]
        for i in range(num_tables):
            off = 12 + 16 * i
            tag = self.data[off:off + 4].decode("latin-1")
            start, length = struct.unpack(">II", self.data[off + 8:off + 16])
            self.tables[tag] = (start, length)

        head = self.tables["head"][0]
        self.units_per_em = struct.unpack(">H", self.data[head + 18:head + 20])[0]
        self.index_to_loc = struct.unpack(">h", self.data[head + 50:head + 52])[0]

        maxp = self.tables["maxp"][0]
        self.num_glyphs = struct.unpack(">H", self.data[maxp + 4:maxp + 6])[0]

        hhea = self.tables["hhea"][0]
        self.num_h_metrics = struct.unpack(">H", self.data[hhea + 34:hhea + 36])[0]

        self._read_loca()
        self._read_cmap()
        self._outlines = {}

    def _read_loca(self):
        start, length = self.tables["loca"]
        n = self.num_glyphs + 1
        if self.index_to_loc == 0:
            raw = struct.unpack(">%dH" % n, self.data[start:start + 2 * n])
            self.loca = [v * 2 for v in raw]
        else:
            self.loca = list(struct.unpack(">%dI" % n, self.data[start:start + 4 * n]))

    def _read_cmap(self):
        start = self.tables["cmap"][0]
        count = struct.unpack(">H", self.data[start + 2:start + 4])[0]
        chosen = None
        for i in range(count):
            off = start + 4 + 8 * i
            pid, eid, sub = struct.unpack(">HHI", self.data[off:off + 8])
            fmt = struct.unpack(">H", self.data[start + sub:start + sub + 2])[0]
            if fmt == 4 and (pid, eid) in ((3, 1), (0, 3), (0, 4), (0, 6)):
                chosen = start + sub
                break
        if chosen is None:
            raise SystemExit("no usable cmap subtable")
        seg_x2 = struct.unpack(">H", self.data[chosen + 6:chosen + 8])[0]
        seg = seg_x2 // 2
        base = chosen + 14
        ends = struct.unpack(">%dH" % seg, self.data[base:base + seg_x2])
        base += seg_x2 + 2
        starts = struct.unpack(">%dH" % seg, self.data[base:base + seg_x2])
        base += seg_x2
        deltas = struct.unpack(">%dh" % seg, self.data[base:base + seg_x2])
        range_base = base + seg_x2
        offsets = struct.unpack(">%dH" % seg, self.data[range_base:range_base + seg_x2])
        self._cmap = (ends, starts, deltas, offsets, range_base)

    def glyph_id(self, ch):
        code = ord(ch)
        ends, starts, deltas, offsets, range_base = self._cmap
        for i, end in enumerate(ends):
            if code <= end:
                if code < starts[i]:
                    return 0
                if offsets[i] == 0:
                    return (code + deltas[i]) & 0xFFFF
                addr = range_base + 2 * i + offsets[i] + 2 * (code - starts[i])
                gid = struct.unpack(">H", self.data[addr:addr + 2])[0]
                return (gid + deltas[i]) & 0xFFFF if gid else 0
        return 0

    def advance(self, gid):
        start = self.tables["hmtx"][0]
        if gid >= self.num_h_metrics:
            gid = self.num_h_metrics - 1
        return struct.unpack(">H", self.data[start + 4 * gid:start + 4 * gid + 2])[0]

    def outline(self, gid, depth=0):
        """Contours of one glyph, in font units, as lists of (x, y) points."""
        if gid in self._outlines:
            return self._outlines[gid]
        contours = self._outline_uncached(gid, depth)
        self._outlines[gid] = contours
        return contours

    def _outline_uncached(self, gid, depth):
        if gid + 1 >= len(self.loca):
            return []
        glyf = self.tables["glyf"][0]
        start, end = self.loca[gid], self.loca[gid + 1]
        if end <= start:
            return []
        d = self.data
        off = glyf + start
        n_contours = struct.unpack(">h", d[off:off + 2])[0]
        off += 10
        if n_contours < 0:
            return self._composite(off, depth)

        end_pts = struct.unpack(">%dH" % n_contours, d[off:off + 2 * n_contours])
        off += 2 * n_contours
        n_points = end_pts[-1] + 1 if n_contours else 0
        instr = struct.unpack(">H", d[off:off + 2])[0]
        off += 2 + instr

        flags = []
        while len(flags) < n_points:
            f = d[off]
            off += 1
            flags.append(f)
            if f & 8:
                repeat = d[off]
                off += 1
                flags.extend([f] * repeat)
        flags = flags[:n_points]

        xs, x = [], 0
        for f in flags:
            if f & 2:
                dx = d[off]
                off += 1
                x += dx if f & 16 else -dx
            elif not f & 16:
                x += struct.unpack(">h", d[off:off + 2])[0]
                off += 2
            xs.append(x)
        ys, y = [], 0
        for f in flags:
            if f & 4:
                dy = d[off]
                off += 1
                y += dy if f & 32 else -dy
            elif not f & 32:
                y += struct.unpack(">h", d[off:off + 2])[0]
                off += 2
            ys.append(y)

        contours, first = [], 0
        for last in end_pts:
            pts = [(xs[i], ys[i], bool(flags[i] & 1)) for i in range(first, last + 1)]
            first = last + 1
            if pts:
                contours.append(_flatten(pts))
        return contours

    def _composite(self, off, depth):
        if depth > 4:
            return []
        d, out = self.data, []
        while True:
            flags, sub_gid = struct.unpack(">HH", d[off:off + 4])
            off += 4
            if flags & 1:
                a1, a2 = struct.unpack(">hh", d[off:off + 4])
                off += 4
            else:
                a1, a2 = struct.unpack(">bb", d[off:off + 2])
                off += 2
            sx = sy = 1.0
            s01 = s10 = 0.0
            if flags & 8:
                sx = sy = _f2dot14(d, off)
                off += 2
            elif flags & 0x40:
                sx, sy = _f2dot14(d, off), _f2dot14(d, off + 2)
                off += 4
            elif flags & 0x80:
                sx, s01 = _f2dot14(d, off), _f2dot14(d, off + 2)
                s10, sy = _f2dot14(d, off + 4), _f2dot14(d, off + 6)
                off += 8
            dx, dy = (a1, a2) if flags & 2 else (0, 0)
            for c in self.outline(sub_gid, depth + 1):
                out.append([(x * sx + y * s10 + dx, x * s01 + y * sy + dy) for x, y in c])
            if not flags & 0x20:
                break
        return out


def _f2dot14(d, off):
    return struct.unpack(">h", d[off:off + 2])[0] / 16384.0


def _flatten(pts, steps=10):
    """One TrueType contour of quadratic splines, as a polygon."""
    # Rotate so the contour starts on-curve. If nothing is on-curve, start at
    # the midpoint between the last and first points.
    on = [i for i, p in enumerate(pts) if p[2]]
    if on:
        k = on[0]
        pts = pts[k:] + pts[:k]
        start = (pts[0][0], pts[0][1])
        rest = pts[1:]
    else:
        start = ((pts[0][0] + pts[-1][0]) / 2.0, (pts[0][1] + pts[-1][1]) / 2.0)
        rest = pts

    out = [start]
    cur = start
    i = 0
    while i < len(rest):
        x, y, is_on = rest[i]
        if is_on:
            out.append((x, y))
            cur = (x, y)
            i += 1
            continue
        # Off-curve control point. The end is the next on-curve point, or the
        # implied midpoint between two consecutive off-curve points.
        if i + 1 < len(rest):
            nx, ny, n_on = rest[i + 1]
            if n_on:
                end, step = (nx, ny), 2
            else:
                end, step = ((x + nx) / 2.0, (y + ny) / 2.0), 1
        else:
            end, step = start, 1
        for s in range(1, steps + 1):
            t = s / float(steps)
            u = 1.0 - t
            out.append((u * u * cur[0] + 2 * u * t * x + t * t * end[0],
                        u * u * cur[1] + 2 * u * t * y + t * t * end[1]))
        cur = end
        i += step
    return out


# ------------------------------------------------------------- rasterizer ---

class Canvas:
    def __init__(self, w, h, bg):
        self.w, self.h = w, h
        self.px = bytearray(bg * (w * h))

    def rect(self, x, y, w, h, color):
        x0, y0 = max(0, int(x)), max(0, int(y))
        x1, y1 = min(self.w, int(x + w)), min(self.h, int(y + h))
        row = bytes(color) * (x1 - x0)
        for yy in range(y0, y1):
            off = (yy * self.w + x0) * 3
            self.px[off:off + len(row)] = row

    def blend(self, x0, y0, alpha, aw, ah, color):
        r, g, b = color
        for yy in range(ah):
            ty = y0 + yy
            if ty < 0 or ty >= self.h:
                continue
            arow = alpha[yy * aw:(yy + 1) * aw]
            base = ty * self.w * 3
            for xx in range(aw):
                a = arow[xx]
                if not a:
                    continue
                tx = x0 + xx
                if tx < 0 or tx >= self.w:
                    continue
                o = base + tx * 3
                if a == 255:
                    self.px[o] = r
                    self.px[o + 1] = g
                    self.px[o + 2] = b
                else:
                    ia = 255 - a
                    self.px[o] = (self.px[o] * ia + r * a) // 255
                    self.px[o + 1] = (self.px[o + 1] * ia + g * a) // 255
                    self.px[o + 2] = (self.px[o + 2] * ia + b * a) // 255

    def png(self, path):
        raw = bytearray()
        stride = self.w * 3
        for y in range(self.h):
            raw.append(0)
            raw.extend(self.px[y * stride:(y + 1) * stride])
        out = [b"\x89PNG\r\n\x1a\n"]

        def chunk(tag, payload):
            out.append(struct.pack(">I", len(payload)))
            out.append(tag + payload)
            out.append(struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

        chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0))
        chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        chunk(b"IEND", b"")
        with open(path, "wb") as fh:
            fh.write(b"".join(out))


def rasterize(polys, w, h):
    """Polygons in pixel space to an 8-bit coverage mask, nonzero winding."""
    alpha = bytearray(w * h)
    if not polys:
        return alpha
    edges = []
    for poly in polys:
        n = len(poly)
        for i in range(n):
            x0, y0 = poly[i]
            x1, y1 = poly[(i + 1) % n]
            if y0 != y1:
                edges.append((min(y0, y1), max(y0, y1), x0, y0, x1, y1))
    if not edges:
        return alpha

    # Bucket edges by pixel row so each scanline touches only what crosses it.
    buckets = [[] for _ in range(h)]
    for e in edges:
        lo = max(0, int(e[0]))
        hi = min(h - 1, int(e[1]) + 1)
        for row in range(lo, hi + 1):
            buckets[row].append(e)

    acc = [0.0] * w
    for row in range(h):
        rows_edges = buckets[row]
        if not rows_edges:
            continue
        for i in range(w):
            acc[i] = 0.0
        for s in range(SS):
            y = row + (s + 0.5) / SS
            xs = []
            for ylo, yhi, x0, y0, x1, y1 in rows_edges:
                if y < ylo or y >= yhi:
                    continue
                t = (y - y0) / (y1 - y0)
                xs.append((x0 + t * (x1 - x0), 1 if y1 > y0 else -1))
            if not xs:
                continue
            xs.sort()
            wind = 0
            span_start = 0.0
            for x, d in xs:
                if wind == 0:
                    span_start = x
                wind += d
                if wind == 0:
                    _span(acc, span_start, x, w)
        for i in range(w):
            a = acc[i] / SS
            if a > 0.0:
                alpha[row * w + i] = 255 if a >= 1.0 else int(a * 255 + 0.5)
    return alpha


def _span(acc, xa, xb, w):
    """Add exact horizontal coverage of [xa, xb) to one accumulator row."""
    if xb <= xa:
        return
    xa = max(xa, 0.0)
    xb = min(xb, float(w))
    if xb <= xa:
        return
    ia, ib = int(xa), int(xb)
    if ia == ib:
        acc[ia] += xb - xa
        return
    acc[ia] += ia + 1 - xa
    for i in range(ia + 1, min(ib, w)):
        acc[i] += 1.0
    if ib < w:
        acc[ib] += xb - ib


# ------------------------------------------------------------------- text ---

def measure(font, text, size, tracking=0.0):
    scale = size / float(font.units_per_em)
    total = 0.0
    for ch in text:
        total += font.advance(font.glyph_id(ch)) * scale + tracking
    return total


def draw_text(canvas, font, text, size, x, baseline, color, tracking=0.0):
    """Draw a run of text and return its advance width."""
    scale = size / float(font.units_per_em)
    polys = []
    pen = 0.0
    for ch in text:
        gid = font.glyph_id(ch)
        for contour in font.outline(gid):
            polys.append([(pen + px * scale, -py * scale) for px, py in contour])
        pen += font.advance(gid) * scale + tracking

    if not polys:
        return pen
    # Rasterize into a tight box, then composite. y is already flipped, so the
    # mask's own origin sits at the baseline.
    ys = [p[1] for c in polys for p in c]
    xs = [p[0] for c in polys for p in c]
    top = int(min(ys)) - 2
    left = int(min(xs)) - 2
    aw = int(max(xs)) - left + 4
    ah = int(max(ys)) - top + 4
    shifted = [[(px - left, py - top) for px, py in c] for c in polys]
    alpha = rasterize(shifted, aw, ah)
    canvas.blend(int(x) + left, int(baseline) + top, alpha, aw, ah, color)
    return pen


def ink_box(font, text, size):
    """Bounding box of a run's ink, relative to the baseline, y down."""
    scale = size / float(font.units_per_em)
    pts = []
    pen = 0.0
    for ch in text:
        gid = font.glyph_id(ch)
        for contour in font.outline(gid):
            pts.extend((pen + px * scale, -py * scale) for px, py in contour)
        pen += font.advance(gid) * scale
    if not pts:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def self_test(font):
    """Catch a flipped or mis-scaled transform without looking at the output.

    'H' is a rectangle-ish cap: its ink must sit above the baseline (negative y
    with y pointing down) and reach about the cap height. A y-flip or a bad
    unitsPerEm shows up here rather than in the committed card.
    """
    size = 100.0
    box = ink_box(font, "H", size)
    if box is None:
        raise SystemExit("self-test: 'H' has no outline")
    _, y0, _, y1 = box
    if not (-0.85 * size < y0 < -0.60 * size):
        raise SystemExit("self-test: cap height off (top=%.1f)" % y0)
    if not (-2.0 < y1 < 2.0):
        raise SystemExit("self-test: baseline off (bottom=%.1f)" % y1)
    # A filled 'H' covers a little over half its own box. Far from that means
    # the winding rule or the span filler is wrong.
    w = int(box[2] - box[0]) + 4
    h = int(y1 - y0) + 4
    shifted = [[(px - box[0] + 2, py - y0 + 2) for px, py in c]
               for c in [[(p[0], -p[1] * size / font.units_per_em)
                          for p in [(q[0] * size / font.units_per_em, q[1]) for q in cc]]
                         for cc in font.outline(font.glyph_id("H"))]]
    cover = sum(1 for v in rasterize(shifted, w, h) if v > 127) / float(w * h)
    if not (0.35 < cover < 0.85):
        raise SystemExit("self-test: 'H' coverage %.2f is not glyph-shaped" % cover)


# ------------------------------------------------------------------- card ---

def build():
    sans = Font(SANS_BOLD)
    mono = Font(MONO)
    self_test(sans)

    c = Canvas(W, H, BG)

    pad = 84
    content = W - 2 * pad

    # A panel edge along the top, the way the page rules its sections.
    c.rect(0, 0, W, 6, ACCENT)

    # Wordmark.
    y = 132
    used = draw_text(c, mono, "curia", 30, pad, y, ACCENT, tracking=0.6)
    draw_text(c, mono, "  self-hosted agent dispatcher", 30, pad + used, y, DIM, tracking=0.6)

    # Headline, shrunk until the longest line fits the content width.
    lines = ["Many repos, one queue,", "driven from a phone."]
    size = 92.0
    while max(measure(sans, ln, size, -1.2) for ln in lines) > content and size > 40:
        size -= 2.0
    top = 268
    step = size * 1.14
    for i, ln in enumerate(lines):
        draw_text(c, sans, ln, size, pad, top + i * step, TEXT, tracking=-1.2)

    # The page's own facts lines, split above and below the rule.
    draw_text(c, mono, "GitHub issues in  ·  merged pull requests out",
              27, pad, 455, DIM, tracking=0.4)

    c.rect(pad, 520, content, 1, LINE)
    foot = "your box  ·  your subscription  ·  your keys"
    draw_text(c, mono, foot, 27, pad, 574, DIM, tracking=0.4)
    url = "curia.sh"
    draw_text(c, mono, url, 27, W - pad - measure(mono, url, 27, 0.4), 574, ACCENT, tracking=0.4)

    out = os.path.join(ROOT, "docs", "og.png")
    c.png(out)

    ink = sum(1 for i in range(0, len(c.px), 3) if c.px[i] != BG[0])
    if ink < 20000:
        raise SystemExit("card looks empty: only %d inked pixels" % ink)
    print("wrote %s (%d bytes, %d inked pixels, headline %.0fpx)"
          % (out, os.path.getsize(out), ink, size))


if __name__ == "__main__":
    sys.exit(build())
