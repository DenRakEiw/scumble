"""TIFF fixtures for the reader and writer of renderer/editor/inpaint_tiff.js (docs/PLAN_0_1_29.md 3d).

    python tools/tiff_fixtures.py <outdir> [--no-check] [--no-large]

Writes one .tif per case into <outdir>, for every accepted case the RGBA8 pixels the reader must give as a raw
`<name>.rgba` (width * height * 4 bytes, straight alpha, rows top to bottom), and `manifest.json`:

    [{ "name", "file", "accept": true|false, "width", "height", "expect": "<name>.rgba" | null,
       "error": "<regex the refusal message must match>" | null, "error_flags": "i" | "",
       "header": true|false   (refused from the header alone: the reader may deliver no rows first),
       "notes": ["<substring a note must contain>", ...],
       "info": { the fields `readTiff` / `tiffInfo` must report for it: bits, samples, photometric, compression,
                 predictor, planar, tiled, bigtiff, alpha, pages (where unambiguous) } }, ...]

The files are written by tifffile and Pillow (libtiff) wherever they can write the case; where neither can (LZW with a
16-bit predictor, 1 / 2 / 4 bits, 1- and 4-bit palettes, the old deflate code, zstd, a huge RowsPerStrip) a small
writer here builds the file from the same tags, or patches a tag of a file tifffile wrote. Every file is decoded once
by tifffile and / or Pillow afterwards (`--no-check` skips it) and compared with the samples it was written from, and a
table is printed.

The expected pixels are computed from the source samples in numpy, never by decoding the TIFF, with these rules:
- 16 bit to 8: floor(v / 257 + 0.5), in integers (v * 2 + 257) // 514 (257 is odd, so no value is exactly halfway).
- grey to RGB: the grey value copied to R, G and B; alpha 255 when the file has none.
- MinIsWhite (photometric 0): inverted after scaling to 8 bits (255 - v).
- 1, 2 and 4 bits: v * 255 // (2 ** bits - 1), exact (255 is divisible by 1, 3 and 15).
- palette: the ColorMap's 16-bit entries by their high byte (v >> 8, what libtiff does: exact for the v * 256 of Pillow
  and the v * 257 of Photoshop), or as they are when every entry is below 256 (an 8-bit map, libtiff's heuristic).
- ExtraSamples 2 (unassociated alpha): kept as it is. ExtraSamples 1 (associated, premultiplied): the colour
  un-premultiplied as a == 0 ? 0 : min(255, (c * 255 + a // 2) // a), integer division. ExtraSamples 0 (an unspecified
  extra channel): left out, alpha 255 when there is no other alpha, and a note containing "extra channel".
"""
import argparse
import io
import json
import os
import struct
import sys
import zlib

import numpy as np
import tifffile
from PIL import Image

W, H = 67, 45            # neither 8-row strips nor 16 / 32 / 48 px tiles divide it evenly

# ---- sources ------------------------------------------------------------------------------------------------


def source(h, w, channels, seed, bits=8):
    """Gradients plus noise, a flat block (runs for PackBits and LZW) and the extremes; (h, w, channels)."""
    maxv = (1 << bits) - 1
    rng = np.random.default_rng(seed)
    y = np.linspace(0.0, 1.0, h)[:, None]
    x = np.linspace(0.0, 1.0, w)[None, :]
    planes = []
    for c in range(channels):
        planes.append(((0.25 + 0.25 * c) * x + (0.8 - 0.2 * c) * y + 0.13 * c + 0.05 * seed) % 1.0)
    a = np.stack(planes, -1) * maxv + rng.normal(0.0, maxv * 0.05, (h, w, channels))
    a = np.clip(np.rint(a), 0, maxv)
    if h >= 8 and w >= 8:
        a[h // 4: h // 4 + max(2, h // 6), w // 3: w // 3 + max(2, w // 5)] = maxv // 2
        a[-1, : w // 2] = 0
        a[-1, w // 2:] = maxv
    dtype = np.uint16 if bits == 16 else np.uint8
    a = a.astype(dtype)
    if bits == 16 and h >= 3:
        # row 1: the rounding edges of the /257 rule (257k + 128 rounds down, 257k + 129 up; a high byte gets both wrong)
        k = np.arange(w * channels) % 255
        edge = np.where(np.arange(w * channels) % 2 == 0, 257 * k + 128, 257 * k + 129)
        a[1] = edge.reshape(w, channels).astype(np.uint16)
        a[2, :, :] = 65535
        a[2, ::3, :] = 0
    return a


def alpha_plane(h, w, seed, bits=8):
    """A soft alpha: 0 on the left, full on the right, a noisy ramp between."""
    maxv = (1 << bits) - 1
    rng = np.random.default_rng(seed + 1000)
    x = np.linspace(-0.3, 1.3, w)[None, :] + np.linspace(0.0, 0.2, h)[:, None]
    a = np.clip(x, 0.0, 1.0) * maxv + rng.normal(0.0, maxv * 0.03, (h, w))
    return np.clip(np.rint(a), 0, maxv).astype(np.uint16 if bits == 16 else np.uint8)


# ---- the rules ----------------------------------------------------------------------------------------------


def to8(v):
    """16 bit to 8: floor(v / 257 + 0.5) = (2v + 257) // 514, exact in integers."""
    return ((v.astype(np.int64) * 2 + 257) // 514).astype(np.uint8)


def scale_bits(v, bits):
    """1, 2, 4 bits to 8: v * 255 // (2^bits - 1), exact."""
    return (v.astype(np.int64) * 255 // ((1 << bits) - 1)).astype(np.uint8)


def rgba(rgb8, a8=None):
    h, w = rgb8.shape[:2]
    out = np.empty((h, w, 4), np.uint8)
    out[..., :3] = rgb8
    out[..., 3] = 255 if a8 is None else a8
    return out


def grey_rgba(g8, a8=None):
    return rgba(np.repeat(g8[..., None], 3, axis=2), a8)


def unpremultiply(c, a):
    """a == 0 ? 0 : min(255, (c * 255 + a // 2) // a), integer division, per colour channel."""
    c = c.astype(np.int64)
    a = a.astype(np.int64)[..., None]
    safe = np.where(a == 0, 1, a)
    v = np.minimum(255, (c * 255 + safe // 2) // safe)
    return np.where(a == 0, 0, v).astype(np.uint8)


# ---- a small classic TIFF writer and parser (for what tifffile and Pillow cannot write) ----------------------

TYPE_FMT = {1: "B", 2: "B", 3: "H", 4: "I", 5: "I", 6: "b", 7: "B", 8: "h", 9: "i", 10: "i", 11: "f", 12: "d", 16: "Q", 17: "q", 18: "Q"}
TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8}


def pack_values(bo, typ, values):
    if typ == 2:
        s = values if isinstance(values, (bytes, bytearray)) else str(values).encode("latin-1")
        return bytes(s) + (b"" if s.endswith(b"\0") else b"\0")
    if typ == 7:
        return bytes(values)
    if typ in (5, 10):
        flat = [v for pair in values for v in pair]
        return struct.pack(bo + TYPE_FMT[typ] * len(flat), *flat)
    return struct.pack(bo + TYPE_FMT[typ] * len(values), *values)


def value_count(typ, values, payload):
    if typ in (2, 7):
        return len(payload)
    return len(values)


def build_tiff(pages, bo="<"):
    """Classic TIFF from `pages`: [{ "tags": {tag: (type, values)}, "data": [bytes per strip or tile],
    "offsets_tag": 273 | 324, "counts_tag": 279 | 325 }]. The data of a page comes before its IFD."""
    out = bytearray((b"II*\x00" if bo == "<" else b"MM\x00*") + b"\0\0\0\0")
    link = 4
    for page in pages:
        offsets = []
        for seg in page["data"]:
            if len(out) % 2:
                out += b"\0"
            offsets.append(len(out))
            out += seg
        tags = dict(page["tags"])
        tags[page.get("offsets_tag", 273)] = (4, offsets)
        tags[page.get("counts_tag", 279)] = (4, [len(s) for s in page["data"]])
        if len(out) % 2:
            out += b"\0"
        ifd_at = len(out)
        struct.pack_into(bo + "I", out, link, ifd_at)
        entries = sorted(tags.items())
        extra_at = ifd_at + 2 + 12 * len(entries) + 4
        ifd = bytearray(struct.pack(bo + "H", len(entries)))
        extra = bytearray()
        for tag, (typ, vals) in entries:
            payload = pack_values(bo, typ, vals)
            ifd += struct.pack(bo + "HHI", tag, typ, value_count(typ, vals, payload))
            if len(payload) <= 4:
                ifd += payload.ljust(4, b"\0")
            else:
                if (extra_at + len(extra)) % 2:
                    extra += b"\0"
                ifd += struct.pack(bo + "I", extra_at + len(extra))
                extra += payload
        link = ifd_at + len(ifd)
        ifd += b"\0\0\0\0"
        out += ifd + extra
    return bytes(out)


def parse_tiff(data):
    """(byte order, bigtiff, [ {tag: (type, values)} per IFD ]) of a TIFF; values as a tuple (bytes for ASCII / UNDEFINED)."""
    bo = "<" if data[:2] == b"II" else ">"
    magic = struct.unpack_from(bo + "H", data, 2)[0]
    big = magic == 43
    off = struct.unpack_from(bo + ("Q" if big else "I"), data, 8 if big else 4)[0]
    ifds, seen = [], set()
    while off and off not in seen and off < len(data):
        seen.add(off)
        n = struct.unpack_from(bo + ("Q" if big else "H"), data, off)[0]
        p = off + (8 if big else 2)
        tags = {}
        for _ in range(n):
            if big:
                tag, typ, count = struct.unpack_from(bo + "HHQ", data, p)
                field, room = p + 12, 8
                p += 20
            else:
                tag, typ, count = struct.unpack_from(bo + "HHI", data, p)
                field, room = p + 8, 4
                p += 12
            size = TYPE_SIZE.get(typ, 1) * count
            at = field if size <= room else struct.unpack_from(bo + ("Q" if big else "I"), data, field)[0]
            raw = data[at: at + size]
            if typ in (2, 7):
                vals = bytes(raw)
            elif typ in (5, 10):
                flat = struct.unpack(bo + TYPE_FMT[typ] * (2 * count), raw)
                vals = tuple(zip(flat[0::2], flat[1::2]))
            else:
                vals = struct.unpack(bo + TYPE_FMT[typ] * count, raw)
            tags[tag] = (typ, vals)
        ifds.append(tags)
        off = struct.unpack_from(bo + ("Q" if big else "I"), data, p)[0]
    return bo, big, ifds


def tag_entry_at(data, tag, ifd_index=0):
    """The file offset of `tag`'s 12-byte entry in a classic TIFF."""
    bo = "<" if data[:2] == b"II" else ">"
    off = struct.unpack_from(bo + "I", data, 4)[0]
    for _ in range(ifd_index):
        n = struct.unpack_from(bo + "H", data, off)[0]
        off = struct.unpack_from(bo + "I", data, off + 2 + 12 * n)[0]
    n = struct.unpack_from(bo + "H", data, off)[0]
    for i in range(n):
        p = off + 2 + 12 * i
        if struct.unpack_from(bo + "H", data, p)[0] == tag:
            return bo, p
    raise KeyError(tag)


def patch_tag(data, tag, typ, value):
    """A single-value tag of the first IFD set in place (the value fits the entry's four bytes)."""
    b = bytearray(data)
    bo, p = tag_entry_at(b, tag)
    struct.pack_into(bo + "HI", b, p + 2, typ, 1)
    b[p + 8: p + 12] = struct.pack(bo + ("H" if typ == 3 else "I"), value).ljust(4, b"\0")
    return bytes(b)


def recompress(data, encode):
    """A classic, stripped or tiled, compression-8 TIFF from tifffile with every segment inflated and re-encoded by
    `encode` (bytes -> bytes); returns the rebuilt file with its other tags unchanged (Compression set by the caller)."""
    bo, big, ifds = parse_tiff(data)
    assert not big
    pages = []
    for tags in ifds:
        tiled = 324 in tags
        ot, ct = (324, 325) if tiled else (273, 279)
        segs = [data[o: o + c] for o, c in zip(tags[ot][1], tags[ct][1])]
        segs = [encode(zlib.decompress(s)) for s in segs]
        rest = {t: v for t, v in tags.items() if t not in (ot, ct)}
        pages.append({"tags": rest, "data": segs, "offsets_tag": ot, "counts_tag": ct})
    return build_tiff(pages, bo)


def with_tags(data, changes):
    """The file rebuilt with tags of its first IFD replaced ({tag: (type, values)}); segments copied as they are."""
    bo, big, ifds = parse_tiff(data)
    assert not big
    pages = []
    for i, tags in enumerate(ifds):
        tiled = 324 in tags
        ot, ct = (324, 325) if tiled else (273, 279)
        segs = [data[o: o + c] for o, c in zip(tags[ot][1], tags[ct][1])]
        rest = {t: v for t, v in tags.items() if t not in (ot, ct)}
        if i == 0:
            rest.update(changes)
        pages.append({"tags": rest, "data": segs, "offsets_tag": ot, "counts_tag": ct})
    return build_tiff(pages, bo)


# ---- encoders ---------------------------------------------------------------------------------------------------


def lzw_encode(data):
    """TIFF LZW (new style): MSB-first codes, Clear 256, EOI 257, 9 to 12 bits with the early change of libtiff (a code
    is written wider once the next free entry passes 2^bits - 1), a Clear when the next free entry reaches 4094."""
    out = bytearray()
    acc = 0
    nacc = 0

    def put(code, width):
        nonlocal acc, nacc
        acc = (acc << width) | code
        nacc += width
        while nacc >= 8:
            nacc -= 8
            out.append((acc >> nacc) & 0xFF)
        acc &= (1 << nacc) - 1

    width = 9
    nxt = 258
    table = {}
    put(256, width)
    if not data:
        put(257, width)
    else:
        w = data[0]
        for b in data[1:]:
            key = (w << 8) | b
            c = table.get(key)
            if c is not None:
                w = c
                continue
            put(w, width)
            table[key] = nxt
            nxt += 1
            if nxt == 4094:
                put(256, width)
                table.clear()
                nxt = 258
                width = 9
            elif nxt > (1 << width) - 1:
                width += 1
            w = b
        put(w, width)
        nxt += 1
        if nxt == 4094:
            put(256, width)
            width = 9
        elif nxt > (1 << width) - 1:
            width += 1
        put(257, width)
    if nacc:
        out.append((acc << (8 - nacc)) & 0xFF)
    return bytes(out)


def packbits_encode(row):
    """PackBits of one row (runs of 2..128 as -n+1, literals of 1..128)."""
    out = bytearray()
    i, n = 0, len(row)
    while i < n:
        j = i
        while j + 1 < n and row[j + 1] == row[i] and j - i < 127:
            j += 1
        if j > i:
            out += bytes([(257 - (j - i + 1)) & 0xFF, row[i]])
            i = j + 1
            continue
        k = i
        while k < n and k - i < 128 and not (k + 1 < n and row[k + 1] == row[k]):
            k += 1
        if k == i:
            k = i + 1
        out.append(k - i - 1)
        out += bytes(row[i:k])
        i = k
    return bytes(out)


def pack_rows(v, bits):
    """(h, w) samples below 2^bits packed MSB first, every row padded to a whole byte (FillOrder 1)."""
    h, w = v.shape
    per = 8 // bits
    rowbytes = (w * bits + 7) // 8
    padded = np.zeros((h, rowbytes * per), np.uint16)
    padded[:, :w] = v
    g = padded.reshape(h, rowbytes, per)
    out = np.zeros((h, rowbytes), np.uint16)
    for i in range(per):
        out = (out << bits) | g[:, :, i]
    return out.astype(np.uint8)


def low_bits_tiff(v, bits, photometric, rps=8, compression=1, colormap=None, bo="<"):
    """A grey or palette file of 1, 2 or 4 (or 8) bits a sample, stripped, from its samples `v` (h, w)."""
    h, w = v.shape
    packed = pack_rows(v, bits) if bits < 8 else v.astype(np.uint8)
    strips = []
    for y in range(0, h, rps):
        rows = packed[y: y + rps]
        if compression == 1:
            strips.append(rows.tobytes())
        elif compression == 8:
            strips.append(zlib.compress(rows.tobytes(), 6))
        elif compression == 5:
            strips.append(lzw_encode(rows.tobytes()))
        elif compression == 32773:
            strips.append(b"".join(packbits_encode(r.tobytes()) for r in rows))
        else:
            raise ValueError(compression)
    tags = {254: (4, [0]), 256: (4, [w]), 257: (4, [h]), 258: (3, [bits]), 259: (3, [compression]), 262: (3, [photometric]),
            277: (3, [1]), 278: (4, [rps]), 282: (5, [(72, 1)]), 283: (5, [(72, 1)]), 296: (3, [2]), 305: (2, "tiff_fixtures.py")}
    if colormap is not None:
        tags[320] = (3, [int(x) for x in colormap.reshape(-1)])
    return build_tiff([{"tags": tags, "data": strips}], bo)


# ---- the fixtures -----------------------------------------------------------------------------------------------

FIXTURES = []


def fixture(fn):
    FIXTURES.append(fn)
    return fn


def info(bits, samples, photometric, compression, predictor=1, planar=1, tiled=False, bigtiff=False, alpha="none", pages=1):
    d = {"bits": bits, "samples": samples, "photometric": photometric, "compression": compression, "predictor": predictor,
         "planar": planar, "tiled": tiled, "bigtiff": bigtiff, "alpha": alpha}
    if pages is not None:
        d["pages"] = pages
    return d


def accept(name, data, expect, stored, notes=(), inf=None, check=None):
    """`stored`: the samples as written (what tifffile / Pillow must decode to); `check`: how to decode them."""
    return {"name": name, "data": data, "accept": True, "expect": expect, "stored": stored, "notes": list(notes), "info": inf, "check": check or {}}


def refuse(name, data, error, flags="", header=True, check=None):
    return {"name": name, "data": data, "accept": False, "error": error, "flags": flags, "header": header, "check": check or {}}


def tw(arr, **kw):
    """tifffile.imwrite into bytes."""
    bio = io.BytesIO()
    tifffile.imwrite(bio, arr, **kw)
    return bio.getvalue()


def pil(img, **kw):
    bio = io.BytesIO()
    img.save(bio, format="TIFF", **kw)
    return bio.getvalue()


@fixture
def rgb8_none():
    s = source(H, W, 3, 1)
    return accept("rgb8_none", tw(s, photometric="rgb", rowsperstrip=8), rgba(s), s, inf=info(8, 3, 2, 1), check={"pillow": True})


@fixture
def rgb8_lzw():
    s = source(H, W, 3, 2)
    return accept("rgb8_lzw", pil(Image.fromarray(s, "RGB"), compression="tiff_lzw", strip_size=W * 3 * 8), rgba(s), s, inf=info(8, 3, 2, 5), check={"no_tifffile": True, "pillow": True})


@fixture
def rgb8_deflate():
    s = source(H, W, 3, 3)
    return accept("rgb8_deflate", tw(s, photometric="rgb", compression="zlib", rowsperstrip=8), rgba(s), s, inf=info(8, 3, 2, 8))


@fixture
def rgb8_deflate_old():
    # the old deflate code 32946 over the same zlib strips (tifffile writes 8 only)
    s = source(H, W, 3, 4)
    d = patch_tag(tw(s, photometric="rgb", compression="zlib", rowsperstrip=8), 259, 3, 32946)
    return accept("rgb8_deflate_old", d, rgba(s), s, inf=info(8, 3, 2, 32946), check={"pillow": True})


@fixture
def rgb8_packbits():
    s = source(H, W, 3, 5)
    return accept("rgb8_packbits", pil(Image.fromarray(s, "RGB"), compression="packbits", strip_size=W * 3 * 8), rgba(s), s, inf=info(8, 3, 2, 32773), check={"pillow": True})


@fixture
def rgb8_lzw_pred():
    # libtiff (through Pillow) with Predictor 2
    s = source(H, W, 3, 6)
    d = pil(Image.fromarray(s, "RGB"), compression="tiff_lzw", tiffinfo={317: 2}, strip_size=W * 3 * 8)
    return accept("rgb8_lzw_pred", d, rgba(s), s, inf=info(8, 3, 2, 5, predictor=2), check={"no_tifffile": True, "pillow": True})


@fixture
def rgb16_lzw_pred():
    # tifffile's 16-bit predictor strips, inflated and LZW-encoded here (no LZW encoder in tifffile without imagecodecs)
    s = source(H, W, 3, 7, bits=16)
    base = tw(s, photometric="rgb", compression="zlib", predictor=True, rowsperstrip=8, metadata=None)
    d = patch_tag(recompress(base, lzw_encode), 259, 3, 5)
    return accept("rgb16_lzw_pred", d, rgba(to8(s)), s, inf=info(16, 3, 2, 5, predictor=2), check={"no_tifffile": True, "pillow_high_byte": True})


@fixture
def rgb8_deflate_pred():
    s = source(H, W, 3, 8)
    return accept("rgb8_deflate_pred", tw(s, photometric="rgb", compression="zlib", predictor=True, rowsperstrip=8), rgba(s), s, inf=info(8, 3, 2, 8, predictor=2), check={"pillow": True})


@fixture
def rgb16_deflate_pred():
    s = source(H, W, 3, 9, bits=16)
    return accept("rgb16_deflate_pred", tw(s, photometric="rgb", compression="zlib", predictor=True, rowsperstrip=8), rgba(to8(s)), s, inf=info(16, 3, 2, 8, predictor=2))


@fixture
def rgb16_le():
    s = source(H, W, 3, 10, bits=16)
    return accept("rgb16_le", tw(s, photometric="rgb", rowsperstrip=8, byteorder="<"), rgba(to8(s)), s, inf=info(16, 3, 2, 1))


@fixture
def rgb16_be():
    s = source(H, W, 3, 11, bits=16)
    return accept("rgb16_be", tw(s, photometric="rgb", rowsperstrip=8, byteorder=">"), rgba(to8(s)), s, inf=info(16, 3, 2, 1))


@fixture
def rgba8():
    s = source(H, W, 3, 12)
    a = alpha_plane(H, W, 12)
    st = np.dstack([s, a])
    return accept("rgba8", pil(Image.fromarray(st, "RGBA")), rgba(s, a), st, inf=info(8, 4, 2, 1, alpha="straight"), check={"pillow": True})


@fixture
def rgba16():
    s = source(H, W, 3, 13, bits=16)
    a = alpha_plane(H, W, 13, bits=16)
    st = np.dstack([s, a])
    d = tw(st, photometric="rgb", extrasamples=("unassalpha",), compression="zlib", predictor=True, rowsperstrip=8)
    return accept("rgba16", d, rgba(to8(s), to8(a)), st, inf=info(16, 4, 2, 8, predictor=2, alpha="straight"))


@fixture
def rgba8_assoc():
    s = source(H, W, 3, 14)
    a = alpha_plane(H, W, 14)
    pm = ((s.astype(np.int64) * a[..., None].astype(np.int64) + 127) // 255).astype(np.uint8)   # stored premultiplied
    # a few invalid pixels (colour above alpha) so the min(255, ...) is exercised, and colour under alpha 0
    pm[5, 3:9] = [200, 150, 100]
    a = a.copy()
    a[5, 3:9] = 100
    a[6, 0:4] = 0
    pm[6, 0:4] = [0, 0, 0]
    st = np.dstack([pm, a])
    d = tw(st, photometric="rgb", extrasamples=("assocalpha",), rowsperstrip=8)
    return accept("rgba8_assoc", d, rgba(unpremultiply(pm, a), a), st, inf=info(8, 4, 2, 1, alpha="premultiplied"))


@fixture
def grey8():
    g = source(H, W, 1, 15)[..., 0]
    return accept("grey8", tw(g, photometric="minisblack", rowsperstrip=8), grey_rgba(g), g, inf=info(8, 1, 1, 1), check={"pillow": True})


@fixture
def grey16():
    g = source(H, W, 1, 16, bits=16)[..., 0]
    return accept("grey16", tw(g, photometric="minisblack", compression="zlib", rowsperstrip=8), grey_rgba(to8(g)), g, inf=info(16, 1, 1, 8))


@fixture
def grey8_alpha():
    g = source(H, W, 1, 17)[..., 0]
    a = alpha_plane(H, W, 17)
    st = np.dstack([g, a])
    return accept("grey8_alpha", pil(Image.fromarray(st, "LA")), grey_rgba(g, a), st, inf=info(8, 2, 1, 1, alpha="straight"), check={"pillow": True})


@fixture
def grey8_miniswhite():
    g = source(H, W, 1, 18)[..., 0]
    return accept("grey8_miniswhite", tw(g, photometric="miniswhite", rowsperstrip=8), grey_rgba((255 - g.astype(np.int64)).astype(np.uint8)), g, inf=info(8, 1, 0, 1))


@fixture
def bilevel_minisblack():
    # libtiff through Pillow: mode "1" is written as 1 bit, MinIsBlack
    g = (source(H, W, 1, 19)[..., 0] > 127).astype(np.uint8)
    d = pil(Image.fromarray(g.astype(bool)))
    return accept("bilevel_minisblack", d, grey_rgba(scale_bits(g, 1)), g, inf=info(1, 1, 1, 1), check={"bool": True, "pillow": True})


@fixture
def bilevel_miniswhite():
    g = (source(H, W, 1, 20)[..., 0] > 127).astype(np.uint8)
    d = low_bits_tiff(g, 1, 0, compression=32773)
    return accept("bilevel_miniswhite", d, grey_rgba((255 - scale_bits(g, 1).astype(np.int64)).astype(np.uint8)), g, inf=info(1, 1, 0, 32773), check={"bool": True, "pillow": True, "inverted": True})


@fixture
def grey2():
    g = (source(H, W, 1, 21)[..., 0] >> 6).astype(np.uint8)
    return accept("grey2", low_bits_tiff(g, 2, 1), grey_rgba(scale_bits(g, 2)), g, inf=info(2, 1, 1, 1), check={"no_tifffile": True, "pillow_scaled": 2})


@fixture
def grey4():
    g = (source(H, W, 1, 22)[..., 0] >> 4).astype(np.uint8)
    return accept("grey4", low_bits_tiff(g, 4, 1, compression=8), grey_rgba(scale_bits(g, 4)), g, inf=info(4, 1, 1, 8), check={"no_tifffile": True, "pillow_scaled": 4})


def palette_case(name, bits, seed, compression=1):
    n = 1 << bits
    rng = np.random.default_rng(seed)
    cmap = rng.integers(0, 65536, (3, n), dtype=np.uint16)
    cmap[:, 0] = [0, 65535, 257 * 3 + 128]          # extremes and a rounding edge
    if n > 2:
        cmap[:, 1] = [257 * 200 + 129, 128, 129]
    idx = (source(H, W, 1, seed)[..., 0].astype(np.int64) * n // 256).astype(np.uint8)
    cm8 = cmap.astype(np.uint16) if int(cmap.max()) < 256 else (cmap >> 8)
    rgb = np.stack([cm8[c].astype(np.uint8)[idx] for c in range(3)], -1)
    if bits == 8:
        d = tw(idx, photometric="palette", colormap=cmap, rowsperstrip=8, compression="zlib" if compression == 8 else None)
    else:
        d = low_bits_tiff(idx, bits, 3, compression=compression, colormap=cmap)
    # tifffile cannot unpack 4 bits without imagecodecs; Pillow gives the indices (mode P)
    return accept(name, d, rgba(rgb), idx, inf=info(bits, 1, 3, compression), check={"no_tifffile": True, "pillow": True} if bits == 4 else {"pillow": bits == 8})


@fixture
def palette1():
    return palette_case("palette1", 1, 23)


@fixture
def palette4():
    return palette_case("palette4", 4, 24, compression=8)


@fixture
def palette8():
    return palette_case("palette8", 8, 25, compression=8)


@fixture
def tiled16():
    s = source(H, W, 3, 26)
    d = tw(s, photometric="rgb", compression="zlib", predictor=True, tile=(16, 16))
    return accept("tiled16", d, rgba(s), s, inf=info(8, 3, 2, 8, predictor=2, tiled=True), check={"pillow": True})


@fixture
def tiled32x48():
    # tiles 32 wide and 48 tall on 67 x 45: the tiles pass the right and the bottom edge
    s = source(H, W, 3, 27)
    a = alpha_plane(H, W, 27)
    st = np.dstack([s, a])
    d = tw(st, photometric="rgb", extrasamples=("unassalpha",), tile=(48, 32))
    return accept("tiled32x48", d, rgba(s, a), st, inf=info(8, 4, 2, 1, tiled=True, alpha="straight"))


@fixture
def planar_strips():
    s = source(H, W, 3, 28, bits=16)
    d = tw(np.moveaxis(s, -1, 0), photometric="rgb", planarconfig="separate", compression="zlib", rowsperstrip=8)
    return accept("planar_strips", d, rgba(to8(s)), np.moveaxis(s, -1, 0), inf=info(16, 3, 2, 8, planar=2))


@fixture
def planar_tiled():
    s = source(H, W, 3, 29)
    d = tw(np.moveaxis(s, -1, 0), photometric="rgb", planarconfig="separate", compression="zlib", predictor=True, tile=(16, 16))
    return accept("planar_tiled", d, rgba(s), np.moveaxis(s, -1, 0), inf=info(8, 3, 2, 8, predictor=2, planar=2, tiled=True))


@fixture
def multipage():
    s = source(H, W, 3, 30)
    s2 = source(20, 30, 3, 31)
    bio = io.BytesIO()
    with tifffile.TiffWriter(bio) as t:
        t.write(s, photometric="rgb", compression="zlib", rowsperstrip=8)
        t.write(s2, photometric="rgb", compression="zlib")
    return accept("multipage", bio.getvalue(), rgba(s), s, notes=["page"], inf=info(8, 3, 2, 8, pages=2))


@fixture
def thumb_first():
    # the first IFD is a reduced-resolution thumbnail (NewSubfileType 1), the full image follows
    s = source(H, W, 3, 32)
    thumb = source(12, 17, 3, 33)
    bio = io.BytesIO()
    with tifffile.TiffWriter(bio) as t:
        t.write(thumb, photometric="rgb", subfiletype=1)
        t.write(s, photometric="rgb", compression="zlib", rowsperstrip=8)
    return accept("thumb_first", bio.getvalue(), rgba(s), s, inf=info(8, 3, 2, 8, pages=None), check={"page": 1})


@fixture
def orientation6():
    s = source(H, W, 3, 34)
    d = tw(s, photometric="rgb", rowsperstrip=8, extratags=[(274, "H", 1, 6, True)])
    return accept("orientation6", d, rgba(s), s, notes=["orientation"], inf=info(8, 3, 2, 1))


@fixture
def icc():
    from PIL import ImageCms
    prof = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    s = source(H, W, 3, 35)
    d = tw(s, photometric="rgb", rowsperstrip=8, iccprofile=prof)
    return accept("icc", d, rgba(s), s, notes=["profile"], inf=info(8, 3, 2, 1))


@fixture
def bigtiff():
    s = source(H, W, 3, 36)
    d = tw(s, photometric="rgb", compression="zlib", rowsperstrip=8, bigtiff=True)
    return accept("bigtiff", d, rgba(s), s, inf=info(8, 3, 2, 8, bigtiff=True))


@fixture
def rps_infinite():
    # RowsPerStrip 2^32 - 1 (the "one strip" writers use), a single strip
    s = source(H, W, 3, 37)
    d = patch_tag(tw(s, photometric="rgb", compression="zlib", rowsperstrip=H), 278, 4, 0xFFFFFFFF)
    return accept("rps_infinite", d, rgba(s), s, inf=info(8, 3, 2, 8))


@fixture
def rps_1000():
    s = source(H, W, 3, 38)
    d = patch_tag(tw(s, photometric="rgb", rowsperstrip=H), 278, 3, 1000)
    return accept("rps_1000", d, rgba(s), s, inf=info(8, 3, 2, 1))


@fixture
def rps_one():
    s = source(H, W, 3, 39)
    return accept("rps_one", tw(s, photometric="rgb", compression="zlib", rowsperstrip=1), rgba(s), s, inf=info(8, 3, 2, 8))


@fixture
def extra_unspecified():
    s = source(H, W, 3, 40)
    x = alpha_plane(H, W, 40)
    st = np.dstack([s, x])
    d = tw(st, photometric="rgb", extrasamples=("unspecified",), rowsperstrip=8)
    return accept("extra_unspecified", d, rgba(s), st, notes=["extra channel"], inf=info(8, 4, 2, 1, alpha="none"))


@fixture
def large_single_strip():
    w, h = 3000, 2000
    s = source(h, w, 3, 41)
    d = tw(s, photometric="rgb", compression="zlib", rowsperstrip=h)
    return accept("large_single_strip", d, rgba(s), s, inf=info(8, 3, 2, 8))


@fixture
def many_strips():
    w, h = 1201, 999
    s = source(h, w, 3, 42)
    d = tw(s, photometric="rgb", compression="zlib", predictor=True, rowsperstrip=3)
    return accept("many_strips", d, rgba(s), s, inf=info(8, 3, 2, 8, predictor=2))


# -- refusals --


@fixture
def cmyk():
    s = source(H, W, 4, 50)
    return refuse("cmyk", pil(Image.fromarray(s, "CMYK")), "CMYK", check={"photometric": 5})


@fixture
def jpeg():
    s = source(H, W, 3, 51)
    return refuse("jpeg", pil(Image.fromarray(s, "RGB"), compression="jpeg"), "JPEG", check={"compression": 7})


@fixture
def float32():
    s = source(H, W, 3, 52).astype(np.float32) / 255.0
    return refuse("float32", tw(s, photometric="rgb"), "float|32 bits", "i", check={"sampleformat": 3})


@fixture
def int16():
    g = (source(H, W, 1, 53, bits=16)[..., 0].astype(np.int32) - 32768).astype(np.int16)
    return refuse("int16", tw(g, photometric="minisblack"), "signed", "i", check={"sampleformat": 2})


@fixture
def uint32():
    g = source(H, W, 1, 54, bits=16)[..., 0].astype(np.uint32) * 65537
    return refuse("uint32", tw(g, photometric="minisblack"), "32 bits", check={"bits": 32})


@fixture
def zstd():
    # tifffile needs a zstd module for it; the Compression tag of a deflate file set to 50000 (ZSTD) says the same
    s = source(H, W, 3, 55)
    d = patch_tag(tw(s, photometric="rgb", compression="zlib", rowsperstrip=8), 259, 3, 50000)
    return refuse("zstd", d, "compression", "i", check={"compression": 50000})


@fixture
def truncated():
    # a good file cut in half: the IFD (tifffile writes it first) is whole, the later strips are missing
    s = source(150, 200, 3, 56)
    d = tw(s, photometric="rgb", compression="zlib", rowsperstrip=8)
    return refuse("truncated", d[: len(d) // 2], "ends early|truncated", "i", header=False, check={"cut_from": len(d)})


@fixture
def not_tiff():
    s = source(H, W, 3, 57)
    bio = io.BytesIO()
    Image.fromarray(s, "RGB").save(bio, format="PNG")
    return refuse("not_tiff", bio.getvalue(), "not a TIFF", "i", check={"png": True})


# ---- the check --------------------------------------------------------------------------------------------------


def summary_of(data):
    """A few tags of the first image IFD, read by the parser here (independent of tifffile)."""
    if data[:4] not in (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+"):
        return "not a TIFF"
    try:
        bo, big, ifds = parse_tiff(data)
    except Exception as err:  # noqa: BLE001
        return "unparsed: %s" % err
    t = ifds[0]
    g = lambda k, d=None: (t[k][1][0] if k in t else d)  # noqa: E731
    segs = len(t.get(324, t.get(273, (0, ())))[1])
    return "%s%s bits=%s spp=%s ph=%s comp=%s pred=%s pl=%s %s=%d ifds=%d" % (
        "II" if bo == "<" else "MM", " big" if big else "", "/".join(str(v) for v in t.get(258, (0, (1,)))[1]), g(277, 1), g(262),
        g(259, 1), g(317, 1), g(284, 1), "tiles" if 324 in t else "strips", segs, len(ifds))


def check_fixture(fx, path):
    """Decode the file with tifffile and / or Pillow and compare with the samples it was written from."""
    ck = fx["check"]
    res = []
    if fx["accept"]:
        stored = fx["stored"]
        if not ck.get("no_tifffile"):
            with tifffile.TiffFile(path) as t:
                arr = t.pages[ck.get("page", 0)].asarray()
            if ck.get("bool"):
                arr = arr.astype(np.uint8)
            if arr.shape != stored.shape or not np.array_equal(arr, stored):
                raise AssertionError("tifffile decodes %s %s, not the written %s" % (arr.shape, arr.dtype, stored.shape))
            res.append("tifffile")
        if ck.get("pillow"):
            im = Image.open(path)
            im.load()
            arr = np.asarray(im)
            if ck.get("bool"):
                arr = arr.astype(np.uint8)
                if ck.get("inverted"):
                    arr = 1 - arr     # Pillow gives the photometric value (white = 1); the samples stored are inverted
            if arr.shape != stored.shape or not np.array_equal(arr, stored):
                raise AssertionError("Pillow decodes %s %s (%s), not the written %s" % (arr.shape, arr.dtype, im.mode, stored.shape))
            res.append("Pillow")
        if ck.get("pillow_scaled"):
            # Pillow reads 2 and 4 bit grey scaled to 8 (L;2, L;4), tifffile needs imagecodecs for them
            im = Image.open(path)
            im.load()
            arr = np.asarray(im)
            if im.mode != "L" or not np.array_equal(arr, scale_bits(stored, ck["pillow_scaled"])):
                raise AssertionError("Pillow decodes %s %s, not the written samples scaled" % (im.mode, arr.shape))
            res.append("Pillow (scaled)")
        if ck.get("pillow_high_byte"):
            im = Image.open(path)
            im.load()
            arr = np.asarray(im)
            if not np.array_equal(arr, (stored >> 8).astype(np.uint8)):
                raise AssertionError("Pillow's high bytes of the 16-bit LZW file are not the written samples'")
            res.append("Pillow (high bytes)")
    else:
        if ck.get("png"):
            assert fx["data"][:8] == b"\x89PNG\r\n\x1a\n"
            res.append("PNG signature")
        elif "cut_from" in ck:
            bo, big, ifds = parse_tiff(fx["data"])
            t = ifds[0]
            ends = [o + c for o, c in zip(t[273][1], t[279][1])]
            assert max(ends) > len(fx["data"]) and min(t[273][1]) < len(fx["data"]), "the cut does not fall inside the strips"
            res.append("IFD whole, %d of %d strips past the end" % (sum(e > len(fx["data"]) for e in ends), len(ends)))
        else:
            with tifffile.TiffFile(path) as t:
                p = t.pages[0]
                if "photometric" in ck:
                    assert int(p.photometric) == ck["photometric"], p.photometric
                if "compression" in ck:
                    assert int(p.compression) == ck["compression"], p.compression
                if "sampleformat" in ck:
                    assert int(p.sampleformat) == ck["sampleformat"], p.sampleformat
                if "bits" in ck:
                    assert p.bitspersample == ck["bits"], p.bitspersample
            res.append("tifffile tags")
    return ", ".join(res)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("outdir")
    ap.add_argument("--no-check", action="store_true", help="skip decoding every file with tifffile / Pillow")
    ap.add_argument("--no-large", action="store_true", help="leave out large_single_strip and many_strips")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)
    manifest = []
    rows = []
    ok = True
    for fn in FIXTURES:
        if args.no_large and fn.__name__ in ("large_single_strip", "many_strips"):
            continue
        fx = fn()
        name = fx["name"]
        path = os.path.join(args.outdir, name + ".tif")
        with open(path, "wb") as f:
            f.write(fx["data"])
        entry = {"name": name, "file": name + ".tif", "accept": fx["accept"], "width": None, "height": None, "expect": None,
                 "error": None, "error_flags": "", "header": False, "notes": [], "info": None}
        if fx["accept"]:
            exp = fx["expect"]
            assert exp.dtype == np.uint8 and exp.ndim == 3 and exp.shape[2] == 4, (name, exp.shape)
            entry["height"], entry["width"] = int(exp.shape[0]), int(exp.shape[1])
            entry["expect"] = name + ".rgba"
            entry["notes"] = fx["notes"]
            entry["info"] = fx["info"]
            with open(os.path.join(args.outdir, name + ".rgba"), "wb") as f:
                f.write(np.ascontiguousarray(exp).tobytes())
        else:
            entry["error"] = fx["error"]
            entry["error_flags"] = fx["flags"]
            entry["header"] = fx["header"]
        manifest.append(entry)
        verdict = "skipped"
        if not args.no_check:
            try:
                verdict = "ok (" + check_fixture(fx, path) + ")"
            except Exception as err:  # noqa: BLE001
                ok = False
                verdict = "BAD: %s" % err
        rows.append((name, "accept" if fx["accept"] else "refuse", len(fx["data"]), summary_of(fx["data"]), verdict))
    with open(os.path.join(args.outdir, "manifest.json"), "w", encoding="utf-8", newline=chr(10)) as f:
        json.dump(manifest, f, indent=1)
    wn = max(len(r[0]) for r in rows)
    ws = max(len(r[3]) for r in rows)
    for r in rows:
        print("%-*s  %-6s %9d  %-*s  %s" % (wn, r[0], r[1], r[2], ws, r[3], r[4]))
    print("%d fixtures (%d accepted, %d refused) in %s" % (len(manifest), sum(e["accept"] for e in manifest), sum(not e["accept"] for e in manifest), args.outdir))
    if not ok:
        print("FIXTURE CHECK FAILED")
        return 1
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
