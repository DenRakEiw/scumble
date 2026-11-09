//! Source-over (and four other operators) of a stack of sources onto one tile.
//!
//! Straight RGBA8 in and out, premultiplied 8-bit maths in between, integer only, so the
//! JS twin (`compositeTile` in `renderer/editor/px/kernels_js.js`) matches bit for bit:
//!
//!   mul255(x, y) = round(x·y / 255)            exact: t = x·y + 128, (t + (t >> 8)) >> 8
//!   dst is premultiplied once:  dp = mul255(d, da)
//!   per source: sa = mul255(s.a, opacity), sp = mul255(s.c, sa), inv = 255 − sa
//!     source-over      r = sp + mul255(dp, inv)      ra = sa + mul255(da, inv)
//!     destination-out  r = mul255(dp, inv)           ra = mul255(da, inv)
//!     source-atop      r = mul255(sp, da) + mul255(dp, inv)   ra = da (the same formula
//!                      gives da exactly: two rounded terms whose exact sum is an integer)
//!     destination-in   r = mul255(dp, sa)            ra = mul255(da, sa)
//!     copy             r = sp                        ra = sa
//!   a mask m is coverage: r = mul255(r, m) + mul255(dp, 255 − m), the same for ra
//!   unpremultiplied once at the end: c = a == 0 ? 0 : min(255, floor((c·255 + a/2) / a))
//!
//! Every channel, alpha included, follows the same formula when the source's alpha byte is
//! taken as 255 for "sp", which is what lets the SIMD path treat the 16 bytes of four pixels
//! alike. Canvas 2D keeps premultiplied 8-bit pixels too, so the precision is the same.
//!
//! The twenty-five blend modes (B item 7, ops 5 to 12; linear light, op 13; tier A, ops 14 to 19: exclusion,
//! linear dodge, linear burn, subtract, pin light, hard mix; tier B, ops 20 to 23: colour dodge,
//! colour burn, vivid light, divide; tier C, ops 24 to 29: hue, saturation, colour, luminosity, darker colour,
//! lighter colour) are the W3C compositing formula,
//! rounded ONCE per channel: with three rounded products the result was up to 1.45 levels from the exact value and a
//! level from the compositor's shader on 29 % of the bytes of a half-transparent layer; rounded once it is within half a
//! level (12 % from the shader, which reads its source back from a premultiplied 8-bit texture). Linear light is not in
//! the W3C list; it is the separable B = clamp(cb + 2*cs - 1, 0, 1) of Photoshop, GIMP and Krita.
//!
//!   B16(cb, cs) = 255 * B, exact integers:
//!     multiply    b*s                          screen      65025 - (255 - b)(255 - s)
//!     hard-light  s <= 127 ? 2*b*s : 65025 - (255 - b)(510 - 2s)        overlay: b and s swapped
//!     darken, lighten, difference   255 * min, max, |b - s|
//!     linear-light  255 * clamp(b + 2s - 255, 0, 255)
//!     soft-light  s <= 127 ? 255*b - ((255 - 2s)*b*(255 - b) + 127) / 255
//!                         : 255*b + ((2s - 255)*(D[b] - 257*b) + 128) / 257
//!                 D[b] = round(65535 * d(b / 255)), d as the specification has it (a table, so that no square
//!                 root is taken twice in two languages)
//!     exclusion   b*(255 - s) + s*(255 - b)
//!     linear-dodge  255 * min(b + s, 255)
//!     linear-burn   255 * (max(b + s, 255) - 255)
//!     subtract    255 * (max(b, s) - s)
//!     pin-light   s <= 127 ? 255 * min(b, 2s) : 255 * max(b, 2s - 255)
//!     hard-mix    b + s >= 255 + (s >> 7) ? 65025 : 0     (the tie b + s = 255 as Photoshop has it: white for
//!                 s <= 127, black for s >= 128, vivid light's branch; measured on its merged fixture, R4-D2)
//!     color-dodge   b == 0 ? 0 : s >= 255 ? 65025 : min(65025, (130050*b + (255-s)) / (2*(255-s)))
//!     color-burn    b >= 255 ? 65025 : s == 0 ? 0 : 65025 - min(65025, (130050*(255-b) + s) / (2*s))
//!     vivid-light   s <= 127 ? burn(b, 2s) : dodge(b, 2s - 255)
//!     divide        s == 0 ? (b == 0 ? 0 : 65025) : min(65025, (130050*b + s) / (2*s))
//!   over an opaque backdrop:  r = (dp*inv*255 + sa*B16 + 32512) / 65025
//!   else, with cb = dp unpremultiplied as at the end and ra = sa + mul255(da, inv):
//!     r = min(ra, (s.c*sa*(255 - da)*255 + dp*inv*65025 + sa*da*B16 + 8290687) / 16581375)
//!   which is the first line where da is 255. Everything fits 32 bits (255^4 + 255^3/2 < 2^32). The SIMD path takes four
//!   pixels at a time where all four backdrop pixels are opaque, in 32-bit lanes, and divides through floats with the
//!   remainder put right (the sums stay below 2^24, so the conversion is exact).

pub const SOURCE_OVER: u8 = 0;
pub const DESTINATION_OUT: u8 = 1;
pub const SOURCE_ATOP: u8 = 2;
pub const DESTINATION_IN: u8 = 3;
pub const COPY: u8 = 4;
pub const MULTIPLY: u8 = 5;
pub const SCREEN: u8 = 6;
pub const OVERLAY: u8 = 7;
pub const DARKEN: u8 = 8;
pub const LIGHTEN: u8 = 9;
pub const SOFT_LIGHT: u8 = 10;
pub const HARD_LIGHT: u8 = 11;
pub const DIFFERENCE: u8 = 12;
pub const LINEAR_LIGHT: u8 = 13;
pub const EXCLUSION: u8 = 14;
pub const LINEAR_DODGE: u8 = 15;
pub const LINEAR_BURN: u8 = 16;
pub const SUBTRACT: u8 = 17;
pub const PIN_LIGHT: u8 = 18;
pub const HARD_MIX: u8 = 19;
pub const COLOR_DODGE: u8 = 20;
pub const COLOR_BURN: u8 = 21;
pub const VIVID_LIGHT: u8 = 22;
pub const DIVIDE: u8 = 23;
pub const HUE: u8 = 24;
pub const SATURATION: u8 = 25;
pub const COLOR: u8 = 26;
pub const LUMINOSITY: u8 = 27;
pub const DARKER_COLOR: u8 = 28;
pub const LIGHTER_COLOR: u8 = 29;
pub const LAST_BLEND: u8 = LIGHTER_COLOR;

pub const UNCHANGED: u32 = 0;
pub const WRITTEN: u32 = 1;
pub const EMPTY: u32 = 2;
pub const REFUSED: u32 = 3;

#[allow(dead_code)]
const SIMD_BLENDS: [u8; 14] = [
    MULTIPLY,
    SCREEN,
    OVERLAY,
    DARKEN,
    LIGHTEN,
    HARD_LIGHT,
    DIFFERENCE,
    LINEAR_LIGHT,
    EXCLUSION,
    LINEAR_DODGE,
    LINEAR_BURN,
    SUBTRACT,
    PIN_LIGHT,
    HARD_MIX,
];

/// round(65535 · d(b / 255)) of soft-light: d = ((16b − 12)b + 4)b up to a quarter (b ≤ 63), else the square root.
static SOFT_D: [u16; 256] = [
    0, 1016, 2008, 2977, 3923, 4846, 5746, 6625, 7482, 8318, 9134, 9929, 10704, 11459, 12195, 12912,
    13611, 14291, 14954, 15600, 16228, 16840, 17436, 18016, 18580, 19129, 19664, 20184, 20690, 21183, 21663, 22129,
    22584, 23026, 23457, 23876, 24284, 24682, 25070, 25448, 25817, 26176, 26527, 26870, 27205, 27532, 27852, 28166,
    28473, 28774, 29069, 29360, 29645, 29926, 30203, 30476, 30746, 31013, 31278, 31540, 31800, 32059, 32317, 32575,
    32832, 33087, 33341, 33592, 33842, 34090, 34336, 34581, 34823, 35064, 35304, 35541, 35778, 36012, 36245, 36477,
    36707, 36936, 37163, 37389, 37613, 37837, 38059, 38279, 38499, 38717, 38934, 39149, 39364, 39577, 39789, 40000,
    40210, 40419, 40627, 40834, 41040, 41244, 41448, 41651, 41852, 42053, 42253, 42452, 42650, 42847, 43043, 43238,
    43432, 43626, 43818, 44010, 44201, 44391, 44580, 44769, 44957, 45144, 45330, 45515, 45700, 45884, 46067, 46249,
    46431, 46612, 46792, 46972, 47151, 47329, 47507, 47684, 47860, 48036, 48211, 48385, 48559, 48732, 48904, 49076,
    49248, 49418, 49588, 49758, 49927, 50095, 50263, 50430, 50597, 50763, 50929, 51094, 51258, 51422, 51586, 51749,
    51911, 52073, 52235, 52396, 52556, 52716, 52876, 53035, 53193, 53351, 53509, 53666, 53823, 53979, 54135, 54290,
    54445, 54600, 54754, 54907, 55060, 55213, 55365, 55517, 55669, 55820, 55971, 56121, 56271, 56420, 56569, 56718,
    56866, 57014, 57162, 57309, 57455, 57602, 57748, 57893, 58039, 58184, 58328, 58472, 58616, 58760, 58903, 59046,
    59188, 59330, 59472, 59613, 59755, 59895, 60036, 60176, 60316, 60455, 60594, 60733, 60872, 61010, 61148, 61285,
    61422, 61559, 61696, 61832, 61968, 62104, 62240, 62375, 62510, 62644, 62779, 62913, 63046, 63180, 63313, 63446,
    63578, 63711, 63843, 63974, 64106, 64237, 64368, 64499, 64629, 64759, 64889, 65019, 65148, 65277, 65406, 65535,
];

#[inline(always)]
fn mul255(x: u32, y: u32) -> u32 {
    let t = x * y + 128;
    (t + (t >> 8)) >> 8
}

pub struct Layer<'a> {
    pub src: &'a [u8],
    pub op: u8,
    pub alpha: u8,
    pub mask: Option<&'a [u8]>,
}

/// `begin`, one `apply` per layer, `end`: the whole stack over one tile.
pub fn begin(dst: &mut [u8]) {
    let px = dst.len() / 4;
    let dst = &mut dst[..px * 4];
    let start = simd::premultiply(dst);
    for d in dst.chunks_exact_mut(4).skip(start) {
        let a = d[3] as u32;
        if a != 255 {
            d[0] = mul255(d[0] as u32, a) as u8;
            d[1] = mul255(d[1] as u32, a) as u8;
            d[2] = mul255(d[2] as u32, a) as u8;
        }
    }
}

pub fn apply(dst: &mut [u8], layer: &Layer) {
    let px = dst.len() / 4;
    let dst = &mut dst[..px * 4];
    let src = &layer.src[..px * 4];
    let mask = layer.mask.map(|m| &m[..px]);
    if layer.op >= MULTIPLY && layer.op <= LAST_BLEND {
        let start = simd::blend(dst, src, layer.op, layer.alpha, mask);
        blend_from(dst, src, layer.op, layer.alpha as u32, mask, start);
        return;
    }
    let op = if layer.op > LAST_BLEND { SOURCE_OVER } else { layer.op };
    let start = simd::layer(dst, src, op, layer.alpha, mask);
    scalar_layer(dst, src, op, layer.alpha as u32, mask, start);
}

#[inline(always)]
fn hard_light(b: u32, s: u32) -> u32 {
    if s <= 127 {
        2 * b * s
    } else {
        65025 - (255 - b) * (510 - 2 * s)
    }
}

#[inline(always)]
fn dodge16(b: u32, s: u32) -> u32 {
    if b == 0 {
        0
    } else if s >= 255 {
        65025
    } else {
        let d = 255 - s;
        65025.min((130050 * b + d) / (2 * d))
    }
}

#[inline(always)]
fn burn16(b: u32, s: u32) -> u32 {
    if b >= 255 {
        65025
    } else if s == 0 {
        0
    } else {
        65025 - 65025.min((130050 * (255 - b) + s) / (2 * s))
    }
}

/// 255 * B(cb, cs) of the blend mode `OP`, both straight 0..255: 0..65025.
#[inline(always)]
fn blend_of<const OP: u8>(b: u32, s: u32) -> u32 {
    match OP {
        MULTIPLY => b * s,
        SCREEN => 65025 - (255 - b) * (255 - s),
        OVERLAY => hard_light(s, b),
        DARKEN => 255 * b.min(s),
        LIGHTEN => 255 * b.max(s),
        SOFT_LIGHT => {
            if s <= 127 {
                255 * b - ((255 - 2 * s) * b * (255 - b) + 127) / 255
            } else {
                255 * b + ((2 * s - 255) * (SOFT_D[b as usize] as u32 - b * 257) + 128) / 257
            }
        }
        HARD_LIGHT => hard_light(b, s),
        // b + 2s is 0..765: clamp to 255..510 first, subtract after, so nothing underflows in u32
        LINEAR_LIGHT => 255 * ((b + 2 * s).max(255).min(510) - 255),
        DIFFERENCE => 255 * (b.max(s) - b.min(s)),
        EXCLUSION => b * (255 - s) + s * (255 - b),
        LINEAR_DODGE => 255 * (b + s).min(255),
        LINEAR_BURN => 255 * ((b + s).max(255) - 255),
        SUBTRACT => 255 * (b.max(s) - s),
        PIN_LIGHT => {
            if s <= 127 {
                255 * b.min(2 * s)
            } else {
                255 * b.max(2 * s - 255)
            }
        }
        HARD_MIX => {
            if b + s >= 255 + (s >> 7) {
                65025
            } else {
                0
            }
        }
        COLOR_DODGE => dodge16(b, s),
        COLOR_BURN => burn16(b, s),
        VIVID_LIGHT => {
            if s <= 127 {
                burn16(b, 2 * s)
            } else {
                dodge16(b, 2 * s - 255)
            }
        }
        DIVIDE => {
            if s == 0 {
                if b == 0 {
                    0
                } else {
                    65025
                }
            } else {
                65025.min((130050 * b + s) / (2 * s))
            }
        }
        _ => 255 * (b.max(s) - b.min(s)),
    }
}

#[inline(always)]
fn r_div(n: i64, d: i64) -> u32 {
    ((2 * n + d) / (2 * d)) as u32
}

#[inline(always)]
fn lum100(c: [i64; 3]) -> i64 {
    30 * c[0] + 59 * c[1] + 11 * c[2]
}

#[inline(always)]
fn sat(c: [i64; 3]) -> i64 {
    c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2])
}

#[inline(always)]
fn nonsep(op: u8, b: [u32; 3], s: [u32; 3]) -> [u32; 3] {
    let b64 = [b[0] as i64, b[1] as i64, b[2] as i64];
    let s64 = [s[0] as i64, s[1] as i64, s[2] as i64];
    let mut p = [0i64; 3];
    let d: i64;
    let l: i64;

    match op {
        HUE => {
            let min_s = s64[0].min(s64[1]).min(s64[2]);
            let max_s = s64[0].max(s64[1]).max(s64[2]);
            let sat_s = max_s - min_s;
            if sat_s == 0 {
                p = [0, 0, 0];
                d = 1;
            } else {
                let sat_b = sat(b64);
                p[0] = (s64[0] - min_s) * sat_b;
                p[1] = (s64[1] - min_s) * sat_b;
                p[2] = (s64[2] - min_s) * sat_b;
                d = sat_s;
            }
            l = lum100(b64);
        }
        SATURATION => {
            let min_b = b64[0].min(b64[1]).min(b64[2]);
            let max_b = b64[0].max(b64[1]).max(b64[2]);
            let sat_b = max_b - min_b;
            if sat_b == 0 {
                p = [0, 0, 0];
                d = 1;
            } else {
                let sat_s = sat(s64);
                p[0] = (b64[0] - min_b) * sat_s;
                p[1] = (b64[1] - min_b) * sat_s;
                p[2] = (b64[2] - min_b) * sat_s;
                d = sat_b;
            }
            l = lum100(b64);
        }
        COLOR => {
            p = s64;
            d = 1;
            l = lum100(b64);
        }
        LUMINOSITY => {
            p = b64;
            d = 1;
            l = lum100(s64);
        }
        _ => return [0, 0, 0],
    }

    let lum_p = lum100(p);
    let lu = l * d;
    let u = [
        100 * p[0] + lu - lum_p,
        100 * p[1] + lu - lum_p,
        100 * p[2] + lu - lum_p,
    ];
    let un = u[0].min(u[1]).min(u[2]);
    let ux = u[0].max(u[1]).max(u[2]);

    if un < 0 {
        let denom = 100 * (lu - un);
        [
            r_div(255 * l * (u[0] - un), denom),
            r_div(255 * l * (u[1] - un), denom),
            r_div(255 * l * (u[2] - un), denom),
        ]
    } else if ux > 25500 * d {
        let denom = 100 * (ux - lu);
        let k1 = l * (ux - lu);
        let k2 = 25500 - l;
        [
            r_div(255 * (k1 + (u[0] - lu) * k2), denom),
            r_div(255 * (k1 + (u[1] - lu) * k2), denom),
            r_div(255 * (k1 + (u[2] - lu) * k2), denom),
        ]
    } else {
        let denom = 100 * d;
        [
            r_div(255 * u[0], denom),
            r_div(255 * u[1], denom),
            r_div(255 * u[2], denom),
        ]
    }
}

#[inline(always)]
fn blend3<const OP: u8>(b: [u32; 3], s: [u32; 3]) -> [u32; 3] {
    match OP {
        HUE | SATURATION | COLOR | LUMINOSITY => nonsep(OP, b, s),
        DARKER_COLOR => {
            if s[0] + s[1] + s[2] < b[0] + b[1] + b[2] {
                [255 * s[0], 255 * s[1], 255 * s[2]]
            } else {
                [255 * b[0], 255 * b[1], 255 * b[2]]
            }
        }
        LIGHTER_COLOR => {
            if s[0] + s[1] + s[2] > b[0] + b[1] + b[2] {
                [255 * s[0], 255 * s[1], 255 * s[2]]
            } else {
                [255 * b[0], 255 * b[1], 255 * b[2]]
            }
        }
        _ => [
            blend_of::<OP>(b[0], s[0]),
            blend_of::<OP>(b[1], s[1]),
            blend_of::<OP>(b[2], s[2]),
        ],
    }
}

/// The pixels from `start` on in the blend mode `op`.
fn blend_from(dst: &mut [u8], src: &[u8], op: u8, o: u32, mask: Option<&[u8]>, start: usize) {
    match op {
        MULTIPLY => scalar_blend::<MULTIPLY>(dst, src, o, mask, start),
        SCREEN => scalar_blend::<SCREEN>(dst, src, o, mask, start),
        OVERLAY => scalar_blend::<OVERLAY>(dst, src, o, mask, start),
        DARKEN => scalar_blend::<DARKEN>(dst, src, o, mask, start),
        LIGHTEN => scalar_blend::<LIGHTEN>(dst, src, o, mask, start),
        SOFT_LIGHT => scalar_blend::<SOFT_LIGHT>(dst, src, o, mask, start),
        HARD_LIGHT => scalar_blend::<HARD_LIGHT>(dst, src, o, mask, start),
        LINEAR_LIGHT => scalar_blend::<LINEAR_LIGHT>(dst, src, o, mask, start),
        DIFFERENCE => scalar_blend::<DIFFERENCE>(dst, src, o, mask, start),
        EXCLUSION => scalar_blend::<EXCLUSION>(dst, src, o, mask, start),
        LINEAR_DODGE => scalar_blend::<LINEAR_DODGE>(dst, src, o, mask, start),
        LINEAR_BURN => scalar_blend::<LINEAR_BURN>(dst, src, o, mask, start),
        SUBTRACT => scalar_blend::<SUBTRACT>(dst, src, o, mask, start),
        PIN_LIGHT => scalar_blend::<PIN_LIGHT>(dst, src, o, mask, start),
        HARD_MIX => scalar_blend::<HARD_MIX>(dst, src, o, mask, start),
        COLOR_DODGE => scalar_blend::<COLOR_DODGE>(dst, src, o, mask, start),
        COLOR_BURN => scalar_blend::<COLOR_BURN>(dst, src, o, mask, start),
        VIVID_LIGHT => scalar_blend::<VIVID_LIGHT>(dst, src, o, mask, start),
        DIVIDE => scalar_blend::<DIVIDE>(dst, src, o, mask, start),
        HUE => scalar_blend::<HUE>(dst, src, o, mask, start),
        SATURATION => scalar_blend::<SATURATION>(dst, src, o, mask, start),
        COLOR => scalar_blend::<COLOR>(dst, src, o, mask, start),
        LUMINOSITY => scalar_blend::<LUMINOSITY>(dst, src, o, mask, start),
        DARKER_COLOR => scalar_blend::<DARKER_COLOR>(dst, src, o, mask, start),
        LIGHTER_COLOR => scalar_blend::<LIGHTER_COLOR>(dst, src, o, mask, start),
        _ => scalar_blend::<DIFFERENCE>(dst, src, o, mask, start),
    }
}

#[inline(always)]
fn scalar_blend<const OP: u8>(dst: &mut [u8], src: &[u8], o: u32, mask: Option<&[u8]>, start: usize) {
    let px = dst.len() / 4;
    for i in start..px {
        let m = match mask {
            Some(m) => m[i] as u32,
            None => 255,
        };
        if m == 0 {
            continue;
        }
        let s = &src[i * 4..i * 4 + 4];
        let d = &mut dst[i * 4..i * 4 + 4];
        let mut sa = s[3] as u32;
        if o != 255 {
            sa = mul255(sa, o);
        }
        if sa == 0 {
            continue;
        }
        let inv = 255 - sa;
        let da = d[3] as u32;
        let mut r = [0u32; 4];
        let s3 = [s[0] as u32, s[1] as u32, s[2] as u32];
        if da == 255 {
            let cb = [d[0] as u32, d[1] as u32, d[2] as u32];
            let bl = blend3::<OP>(cb, s3);
            for c in 0..3 {
                r[c] = (d[c] as u32 * inv * 255 + sa * bl[c] + 32512) / 65025;
            }
            r[3] = 255;
        } else {
            let ra = sa + mul255(da, inv);
            let both = sa * da;
            let only = sa * (255 - da) * 255;
            let h = da >> 1;
            let cb = if da == 0 {
                [0, 0, 0]
            } else {
                [
                    ((d[0] as u32 * 255 + h) / da).min(255),
                    ((d[1] as u32 * 255 + h) / da).min(255),
                    ((d[2] as u32 * 255 + h) / da).min(255),
                ]
            };
            let bl = blend3::<OP>(cb, s3);
            for c in 0..3 {
                let dp = d[c] as u32;
                let x = s[c] as u32 * only + dp * inv * 65025 + both * bl[c] + 8290687;
                r[c] = (x / 16581375).min(ra);
            }
            r[3] = ra;
        }
        if m != 255 {
            let im = 255 - m;
            for c in 0..4 {
                r[c] = mul255(r[c], m) + mul255(d[c] as u32, im);
            }
        }
        d[0] = r[0] as u8;
        d[1] = r[1] as u8;
        d[2] = r[2] as u8;
        d[3] = r[3] as u8;
    }
}

pub fn end(dst: &mut [u8]) {
    let px = dst.len() / 4;
    let dst = &mut dst[..px * 4];
    let start = simd::unpremultiply(dst);
    for d in dst.chunks_exact_mut(4).skip(start) {
        let a = d[3] as u32;
        if a == 0 {
            d[0] = 0;
            d[1] = 0;
            d[2] = 0;
        } else if a != 255 {
            let h = a >> 1;
            d[0] = ((d[0] as u32 * 255 + h) / a).min(255) as u8;
            d[1] = ((d[1] as u32 * 255 + h) / a).min(255) as u8;
            d[2] = ((d[2] as u32 * 255 + h) / a).min(255) as u8;
        }
    }
}

#[inline(always)]
fn scalar_layer(dst: &mut [u8], src: &[u8], op: u8, o: u32, mask: Option<&[u8]>, start: usize) {
    let px = dst.len() / 4;
    for i in start..px {
        let m = match mask {
            Some(m) => m[i] as u32,
            None => 255,
        };
        if m == 0 {
            continue;
        }
        let s = &src[i * 4..i * 4 + 4];
        let d = &mut dst[i * 4..i * 4 + 4];
        let mut sa = s[3] as u32;
        if o != 255 {
            sa = mul255(sa, o);
        }
        let inv = 255 - sa;
        let da = d[3] as u32;
        let mut r = [0u32; 4];
        match op {
            SOURCE_OVER => {
                if sa == 0 {
                    continue;
                }
                if sa == 255 && m == 255 {
                    d.copy_from_slice(s);
                    d[3] = 255;
                    continue;
                }
                for c in 0..3 {
                    r[c] = mul255(s[c] as u32, sa) + mul255(d[c] as u32, inv);
                }
                r[3] = sa + mul255(da, inv);
            }
            DESTINATION_OUT => {
                if sa == 0 {
                    continue;
                }
                for c in 0..4 {
                    r[c] = mul255(d[c] as u32, inv);
                }
            }
            SOURCE_ATOP => {
                if sa == 0 {
                    continue;
                }
                for c in 0..3 {
                    r[c] = mul255(mul255(s[c] as u32, sa), da) + mul255(d[c] as u32, inv);
                }
                r[3] = mul255(sa, da) + mul255(da, inv);
            }
            DESTINATION_IN => {
                if sa == 255 {
                    continue;
                }
                for c in 0..4 {
                    r[c] = mul255(d[c] as u32, sa);
                }
            }
            _ => {
                debug_assert_eq!(op, COPY);
                for c in 0..3 {
                    r[c] = mul255(s[c] as u32, sa);
                }
                r[3] = sa;
            }
        }
        if m != 255 {
            let im = 255 - m;
            for c in 0..4 {
                r[c] = mul255(r[c], m) + mul255(d[c] as u32, im);
            }
        }
        d[0] = r[0] as u8;
        d[1] = r[1] as u8;
        d[2] = r[2] as u8;
        d[3] = r[3] as u8;
    }
}

/// Composites `src` (`px * 4` straight RGBA8 bytes) over `dst` (`px * 4` straight RGBA8 bytes, in place; `has_dst`
/// false when the destination tile does not exist yet and is taken as 0) under `op` and `alpha` (0..255) with optional
/// coverage `mask` (`px` bytes), keeping `dst` (or 0) untouched where `src` has alpha 0 or `mask` is 0
/// (`compositeStroke` in `inpaint_tiles.js`, K36). Returns `UNCHANGED` (0) when no pixel changed, `WRITTEN` (1) when
/// changed and at least one pixel has alpha > 0 afterwards, `EMPTY` (2) when changed and every pixel has alpha 0
/// afterwards, or `REFUSED` (3) when arguments are out of range.
pub fn masked_tile(dst: &mut [u8], has_dst: bool, src: &[u8], op: u8, alpha: u8, mask: Option<&[u8]>) -> u32 {
    if dst.is_empty() || dst.len() % 4 != 0 || src.len() < dst.len() {
        return REFUSED;
    }
    let px = dst.len() / 4;
    if mask.is_some_and(|m| m.len() < px) {
        return REFUSED;
    }
    if !has_dst && matches!(op, DESTINATION_OUT | SOURCE_ATOP | DESTINATION_IN) {
        return UNCHANGED;
    }
    const CHUNK: usize = 256;
    let mut orig = [0u8; CHUNK * 4];
    let mut changed = false;
    let mut non_empty = false;
    for base in (0..px).step_by(CHUNK) {
        let c_px = (px - base).min(CHUNK);
        let d_chunk = &mut dst[base * 4..(base + c_px) * 4];
        let s_chunk = &src[base * 4..(base + c_px) * 4];
        let m_chunk = mask.map(|m| &m[base..base + c_px]);
        let Some((x0, x1)) = simd::active_span(s_chunk, m_chunk, c_px) else {
            if has_dst {
                if !non_empty && simd::any_alpha(d_chunk) {
                    non_empty = true;
                }
            } else {
                d_chunk.fill(0);
            }
            continue;
        };
        if has_dst {
            if !non_empty && (simd::any_alpha(&d_chunk[..x0 * 4]) || simd::any_alpha(&d_chunk[x1 * 4..])) {
                non_empty = true;
            }
        } else {
            d_chunk[..x0 * 4].fill(0);
            d_chunk[x1 * 4..].fill(0);
        }
        let span_px = x1 - x0;
        let span_bytes = span_px * 4;
        let d_span = &mut d_chunk[x0 * 4..x1 * 4];
        let s_span = &s_chunk[x0 * 4..x1 * 4];
        let m_span = m_chunk.map(|m| &m[x0..x1]);
        let orig_span = &mut orig[..span_bytes];
        if has_dst {
            orig_span.copy_from_slice(d_span);
            begin(d_span);
        } else {
            orig_span.fill(0);
            d_span.fill(0);
        }
        let layer = Layer {
            src: s_span,
            op,
            alpha,
            mask: m_span,
        };
        apply(d_span, &layer);
        end(d_span);
        let (done, c, ne) = simd::finish_masked(d_span, orig_span, s_span, m_span);
        changed |= c;
        non_empty |= ne;
        for p in done..span_px {
            let o = p * 4;
            let m = m_span.map_or(255, |m| m[p]);
            if s_span[o + 3] == 0 || m == 0 {
                d_span[o..o + 4].copy_from_slice(&orig_span[o..o + 4]);
            } else if d_span[o..o + 4] != orig_span[o..o + 4] {
                changed = true;
            }
            if d_span[o + 3] != 0 {
                non_empty = true;
            }
        }
    }
    if !changed {
        UNCHANGED
    } else if non_empty {
        WRITTEN
    } else {
        EMPTY
    }
}

/// Multiplies `cov` (`px` bytes, in place) by `base_mask`, `alpha` (when `< 255`), and `own` in that order
/// (`clipCoverage` in `renderer/editor/inpaint_raster.js`, K10c).
pub fn clip_coverage(cov: &mut [u8], base_mask: Option<&[u8]>, alpha: u8, own: Option<&[u8]>) {
    let px = cov.len();
    let base_mask = base_mask.map(|m| &m[..px]);
    let own = own.map(|m| &m[..px]);
    if base_mask.is_none() && alpha == 255 && own.is_none() {
        return;
    }
    let start = simd::clip_coverage(cov, base_mask, alpha, own);
    if let Some(bm) = base_mask {
        for i in start..px {
            cov[i] = mul255(cov[i] as u32, bm[i] as u32) as u8;
        }
    }
    if alpha < 255 {
        let a = alpha as u32;
        for i in start..px {
            cov[i] = mul255(cov[i] as u32, a) as u8;
        }
    }
    if let Some(o) = own {
        for i in start..px {
            cov[i] = mul255(cov[i] as u32, o[i] as u32) as u8;
        }
    }
}

#[inline(always)]
fn lowbias32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

#[inline(always)]
fn hash32(x: u32, y: u32, seed: u32) -> u32 {
    lowbias32(x.wrapping_mul(0x9e37_79b1) ^ y.wrapping_mul(0x85eb_ca77) ^ seed)
}

/// Dissolves `rows` rows (`w` pixels wide, straight RGBA8 in `src`, in place) at image origin `(x0, y0)` with layer
/// `alpha`, optional coverage `mask` (`w * rows` bytes), and `seed` (`inpaint_worker.js` `rowsOfStack` /
/// `stackRowsToWasm`, K10c). Pixels with `srcA == 0` are left untouched; kept pixels get alpha 255; dropped pixels
/// are zeroed in all four channels.
pub fn dissolve_rows(
    src: &mut [u8],
    w: usize,
    rows: usize,
    x0: i32,
    y0: i32,
    alpha: u8,
    mask: Option<&[u8]>,
    seed: u32,
) {
    let px = w * rows;
    let src = &mut src[..px * 4];
    let mask = mask.map(|m| &m[..px]);
    let a = alpha as u32;
    for r in 0..rows {
        let img_y = (y0 as u32).wrapping_add(r as u32);
        let row_src = &mut src[r * w * 4..(r + 1) * w * 4];
        let row_mask = mask.map(|m| &m[r * w..(r + 1) * w]);
        let start = simd::dissolve_row(row_src, w, x0 as u32, img_y, alpha, row_mask, seed);
        for c in start..w {
            let idx = c * 4;
            let src_a = row_src[idx + 3] as u32;
            if src_a == 0 {
                continue;
            }
            let m = row_mask.map_or(255, |rm| rm[c] as u32);
            let c_val = mul255(mul255(src_a, a), m);
            let img_x = (x0 as u32).wrapping_add(c as u32);
            let keep = (c_val == 255) || ((hash32(img_x, img_y, seed) >> 24) < c_val);
            if keep {
                row_src[idx + 3] = 255;
            } else {
                row_src[idx] = 0;
                row_src[idx + 1] = 0;
                row_src[idx + 2] = 0;
                row_src[idx + 3] = 0;
            }
        }
    }
}

#[cfg(not(target_feature = "simd128"))]
mod simd {
    use super::*;
    #[inline(always)]
    pub fn premultiply(_: &mut [u8]) -> usize {
        0
    }
    #[inline(always)]
    pub fn unpremultiply(_: &mut [u8]) -> usize {
        0
    }
    #[inline(always)]
    pub fn layer(_: &mut [u8], _: &[u8], _: u8, _: u8, _: Option<&[u8]>) -> usize {
        let _ = SOURCE_OVER;
        0
    }
    #[inline(always)]
    pub fn blend(_: &mut [u8], _: &[u8], _: u8, _: u8, _: Option<&[u8]>) -> usize {
        0
    }
    #[inline(always)]
    pub fn any_alpha(rgba: &[u8]) -> bool {
        rgba.chunks_exact(4).any(|d| d[3] != 0)
    }
    #[inline(always)]
    pub fn active_span(src: &[u8], mask: Option<&[u8]>, px: usize) -> Option<(usize, usize)> {
        let first = (0..px).find(|&i| src[i * 4 + 3] != 0 && mask.map_or(true, |m| m[i] != 0))?;
        let last = (first..px).rev().find(|&i| src[i * 4 + 3] != 0 && mask.map_or(true, |m| m[i] != 0)).unwrap_or(first);
        Some(((first / 4) * 4, (((last / 4) + 1) * 4).min(px)))
    }
    #[inline(always)]
    pub fn finish_masked(_: &mut [u8], _: &[u8], _: &[u8], _: Option<&[u8]>) -> (usize, bool, bool) {
        (0, false, false)
    }
    #[inline(always)]
    pub fn clip_coverage(_: &mut [u8], _: Option<&[u8]>, _: u8, _: Option<&[u8]>) -> usize {
        0
    }
    #[inline(always)]
    pub fn dissolve_row(_: &mut [u8], _: usize, _: u32, _: u32, _: u8, _: Option<&[u8]>, _: u32) -> usize {
        0
    }
}

#[cfg(target_feature = "simd128")]
mod simd {
    use super::*;
    use core::arch::wasm32::*;

    /// round(x·y / 255) per byte.
    #[inline(always)]
    unsafe fn mul255(x: v128, y: v128) -> v128 {
        let c = u16x8_splat(128);
        let lo = u16x8_add(u16x8_extmul_low_u8x16(x, y), c);
        let hi = u16x8_add(u16x8_extmul_high_u8x16(x, y), c);
        let lo = u16x8_shr(u16x8_add(lo, u16x8_shr(lo, 8)), 8);
        let hi = u16x8_shr(u16x8_add(hi, u16x8_shr(hi, 8)), 8);
        u8x16_narrow_i16x8(lo, hi)
    }

    #[inline(always)]
    unsafe fn alphas(v: v128) -> v128 {
        u8x16_shuffle::<3, 3, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 15, 15, 15, 15>(v, v)
    }

    pub fn premultiply(dst: &mut [u8]) -> usize {
        let n = (dst.len() / 16) * 16;
        unsafe {
            let amask = u32x4_splat(0xFF00_0000);
            let p = dst.as_mut_ptr();
            let mut i = 0;
            while i < n {
                let d = v128_load(p.add(i) as *const v128);
                let a = alphas(d);
                if !u8x16_all_true(u8x16_eq(a, u8x16_splat(255))) {
                    v128_store(p.add(i) as *mut v128, mul255(v128_or(d, amask), a));
                }
                i += 16;
            }
        }
        n / 4
    }

    pub fn unpremultiply(dst: &mut [u8]) -> usize {
        let n = (dst.len() / 16) * 16;
        unsafe {
            let p = dst.as_mut_ptr();
            let byte = u32x4_splat(255);
            let c255 = u32x4_splat(255);
            let mut i = 0;
            while i < n {
                let d = v128_load(p.add(i) as *const v128);
                let a = u32x4_shr(d, 24);
                if !u32x4_all_true(u32x4_eq(a, byte)) {
                    let h = u32x4_shr(a, 1);
                    let af = f32x4_convert_i32x4(a);
                    let div = |c: v128| {
                        // values stay below 2^16: the signed conversions are exact
                        let q = i32x4_trunc_sat_f32x4(f32x4_div(f32x4_convert_i32x4(i32x4_add(i32x4_mul(c, c255), h)), af));
                        u32x4_min(q, byte)
                    };
                    let r = div(v128_and(d, byte));
                    let g = div(v128_and(u32x4_shr(d, 8), byte));
                    let b = div(v128_and(u32x4_shr(d, 16), byte));
                    let out = v128_or(v128_or(r, u32x4_shl(g, 8)), v128_or(u32x4_shl(b, 16), u32x4_shl(a, 24)));
                    v128_store(p.add(i) as *mut v128, out);
                }
                i += 16;
            }
        }
        n / 4
    }

    /// 255 · hard-light in 32-bit lanes: s ≤ 127 ? 2·b·s : 65025 − (255 − b)(510 − 2s).
    #[inline(always)]
    unsafe fn hard_light(b: v128, s: v128) -> v128 {
        let c255 = u32x4_splat(255);
        let lo = u32x4_shl(u32x4_mul(b, s), 1);
        let hi = u32x4_sub(u32x4_splat(65025), u32x4_mul(u32x4_sub(c255, b), u32x4_sub(u32x4_splat(510), u32x4_shl(s, 1))));
        v128_bitselect(hi, lo, u32x4_gt(s, u32x4_splat(127)))
    }

    /// One pixel (its four channels as 32-bit lanes) in a blend mode over an opaque backdrop:
    /// (d·inv·255 + sa·B16 + 32512) / 65025. The sum is below 2²⁴, so the float holds it exactly; the quotient
    /// of the float division is put right by its remainder.
    #[inline(always)]
    unsafe fn blend_pixel(d: v128, s: v128, sa: v128, op: u8) -> v128 {
        let c255 = u32x4_splat(255);
        let b16 = match op {
            MULTIPLY => u32x4_mul(d, s),
            SCREEN => u32x4_sub(u32x4_splat(65025), u32x4_mul(u32x4_sub(c255, d), u32x4_sub(c255, s))),
            OVERLAY => hard_light(s, d),
            DARKEN => u32x4_mul(u32x4_min(d, s), c255),
            LIGHTEN => u32x4_mul(u32x4_max(d, s), c255),
            HARD_LIGHT => hard_light(d, s),
            // lanes are unsigned 0..765: clamp d + 2s to 255..510, then subtract 255
            LINEAR_LIGHT => u32x4_mul(u32x4_sub(u32x4_min(u32x4_max(u32x4_add(d, u32x4_shl(s, 1)), c255), u32x4_splat(510)), c255), c255),
            DIFFERENCE => u32x4_mul(u32x4_sub(u32x4_max(d, s), u32x4_min(d, s)), c255),
            EXCLUSION => u32x4_add(u32x4_mul(d, u32x4_sub(c255, s)), u32x4_mul(s, u32x4_sub(c255, d))),
            LINEAR_DODGE => u32x4_mul(u32x4_min(u32x4_add(d, s), c255), c255),
            LINEAR_BURN => u32x4_mul(u32x4_sub(u32x4_max(u32x4_add(d, s), c255), c255), c255),
            SUBTRACT => u32x4_mul(u32x4_sub(u32x4_max(d, s), s), c255),
            PIN_LIGHT => {
                let lo = u32x4_min(d, u32x4_shl(s, 1));
                let hi = u32x4_max(d, u32x4_sub(u32x4_max(u32x4_shl(s, 1), c255), c255));
                u32x4_mul(v128_bitselect(hi, lo, u32x4_gt(s, u32x4_splat(127))), c255)
            }
            HARD_MIX => {
                let mask = u32x4_ge(u32x4_add(d, s), u32x4_add(c255, u32x4_shr(s, 7)));
                v128_and(mask, u32x4_splat(65025))
            }
            _ => u32x4_mul(u32x4_sub(u32x4_max(d, s), u32x4_min(d, s)), c255),
        };
        let inv = u32x4_sub(c255, sa);
        let x = u32x4_add(u32x4_add(u32x4_mul(u32x4_mul(d, inv), c255), u32x4_mul(sa, b16)), u32x4_splat(32512));
        let q = u32x4_trunc_sat_f32x4(f32x4_mul(f32x4_convert_u32x4(x), f32x4_splat(1.0 / 65025.0)));
        let r = i32x4_sub(x, i32x4_mul(q, i32x4_splat(65025)));
        // r < 0: one too many (the mask is −1); r ≥ 65025: one too few
        let q = i32x4_add(q, i32x4_lt(r, i32x4_splat(0)));
        i32x4_sub(q, i32x4_gt(r, i32x4_splat(65024)))
    }

    /// One source in a blend mode, four pixels at a time where all four backdrop pixels are opaque (the
    /// others, and all of soft-light with its table, go the scalar way). Returns the pixels done.
    pub fn blend(dst: &mut [u8], src: &[u8], op: u8, o: u8, mask: Option<&[u8]>) -> usize {
        if !SIMD_BLENDS.contains(&op) {
            return 0;
        }
        let n = (dst.len() / 16) * 16;
        unsafe {
            let pd = dst.as_mut_ptr();
            let ps = src.as_ptr();
            let amask = u32x4_splat(0xFF00_0000);
            let full = u8x16_splat(255);
            let ov = u8x16_splat(o);
            let mut i = 0;
            while i < n {
                let mv = match mask {
                    Some(m) => {
                        let w = (m.as_ptr().add(i / 4) as *const u32).read_unaligned();
                        let mv = u32x4_splat(w);
                        let mv = u8x16_shuffle::<0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3>(mv, mv);
                        if !v128_any_true(mv) {
                            i += 16;
                            continue;
                        }
                        Some(mv)
                    }
                    None => None,
                };
                let s = v128_load(ps.add(i) as *const v128);
                let mut sa = alphas(s);
                if o != 255 {
                    sa = mul255(sa, ov);
                }
                if !v128_any_true(sa) {
                    i += 16;
                    continue;
                }
                let d = v128_load(pd.add(i) as *const v128);
                if !u8x16_all_true(u8x16_eq(alphas(d), full)) {
                    let m4 = mask.map(|m| &m[i / 4..i / 4 + 4]);
                    blend_from(&mut dst[i..i + 16], &src[i..i + 16], op, o as u32, m4, 0);
                    i += 16;
                    continue;
                }
                // the sixteen bytes as four pixels of four 32-bit lanes; the alpha lane is set to 255 afterwards
                let (dl, dh) = (u16x8_extend_low_u8x16(d), u16x8_extend_high_u8x16(d));
                let (sl, sh) = (u16x8_extend_low_u8x16(s), u16x8_extend_high_u8x16(s));
                let (al, ah) = (u16x8_extend_low_u8x16(sa), u16x8_extend_high_u8x16(sa));
                let p0 = blend_pixel(u32x4_extend_low_u16x8(dl), u32x4_extend_low_u16x8(sl), u32x4_extend_low_u16x8(al), op);
                let p1 = blend_pixel(u32x4_extend_high_u16x8(dl), u32x4_extend_high_u16x8(sl), u32x4_extend_high_u16x8(al), op);
                let p2 = blend_pixel(u32x4_extend_low_u16x8(dh), u32x4_extend_low_u16x8(sh), u32x4_extend_low_u16x8(ah), op);
                let p3 = blend_pixel(u32x4_extend_high_u16x8(dh), u32x4_extend_high_u16x8(sh), u32x4_extend_high_u16x8(ah), op);
                let r = u8x16_narrow_i16x8(i16x8_narrow_i32x4(p0, p1), i16x8_narrow_i32x4(p2, p3));
                let r = v128_or(r, amask);
                let r = match mv {
                    Some(mv) if !u8x16_all_true(u8x16_eq(mv, full)) => u8x16_add(mul255(r, mv), mul255(d, v128_xor(mv, full))),
                    _ => r,
                };
                v128_store(pd.add(i) as *mut v128, r);
                i += 16;
            }
        }
        n / 4
    }

    /// One source over `dst` sixteen bytes at a time. Returns the pixels done.
    pub fn layer(dst: &mut [u8], src: &[u8], op: u8, o: u8, mask: Option<&[u8]>) -> usize {
        let n = (dst.len() / 16) * 16;
        unsafe {
            let pd = dst.as_mut_ptr();
            let ps = src.as_ptr();
            let amask = u32x4_splat(0xFF00_0000);
            let full = u8x16_splat(255);
            let ov = u8x16_splat(o);
            let mut i = 0;
            while i < n {
                let mv = match mask {
                    Some(m) => {
                        let w = (m.as_ptr().add(i / 4) as *const u32).read_unaligned();
                        let mv = u32x4_splat(w);
                        let mv = u8x16_shuffle::<0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3>(mv, mv);
                        if !v128_any_true(mv) {
                            i += 16;
                            continue;
                        }
                        Some(mv)
                    }
                    None => None,
                };
                let s = v128_load(ps.add(i) as *const v128);
                let mut sa = alphas(s);
                if o != 255 {
                    sa = mul255(sa, ov);
                }
                let d = v128_load(pd.add(i) as *const v128);
                let inv = v128_xor(sa, full);
                let r = match op {
                    SOURCE_OVER => {
                        if !v128_any_true(sa) {
                            i += 16;
                            continue;
                        }
                        u8x16_add(mul255(v128_or(s, amask), sa), mul255(d, inv))
                    }
                    DESTINATION_OUT => {
                        if !v128_any_true(sa) {
                            i += 16;
                            continue;
                        }
                        mul255(d, inv)
                    }
                    SOURCE_ATOP => {
                        if !v128_any_true(sa) {
                            i += 16;
                            continue;
                        }
                        let sp = mul255(v128_or(s, amask), sa);
                        u8x16_add(mul255(sp, alphas(d)), mul255(d, inv))
                    }
                    DESTINATION_IN => {
                        if u8x16_all_true(u8x16_eq(sa, full)) {
                            i += 16;
                            continue;
                        }
                        mul255(d, sa)
                    }
                    _ => mul255(v128_or(s, amask), sa),
                };
                let r = match mv {
                    Some(mv) if !u8x16_all_true(u8x16_eq(mv, full)) => u8x16_add(mul255(r, mv), mul255(d, v128_xor(mv, full))),
                    _ => r,
                };
                v128_store(pd.add(i) as *mut v128, r);
                i += 16;
            }
        }
        n / 4
    }

    pub fn any_alpha(rgba: &[u8]) -> bool {
        let n = (rgba.len() / 16) * 16;
        unsafe {
            let p = rgba.as_ptr();
            let amask = u32x4_splat(0xFF00_0000);
            let mut acc = u32x4_splat(0);
            let mut i = 0;
            while i < n {
                acc = v128_or(acc, v128_and(v128_load(p.add(i) as *const v128), amask));
                i += 16;
            }
            if v128_any_true(acc) {
                return true;
            }
        }
        rgba[n..].chunks_exact(4).any(|d| d[3] != 0)
    }

    pub fn active_span(src: &[u8], mask: Option<&[u8]>, px: usize) -> Option<(usize, usize)> {
        let n4 = px / 4;
        let mut first_g = usize::MAX;
        unsafe {
            let ps = src.as_ptr();
            let zero = u32x4_splat(0);
            match mask {
                None => {
                    for g in 0..n4 {
                        let s = v128_load(ps.add(g * 16) as *const v128);
                        if v128_any_true(u32x4_shr(s, 24)) {
                            first_g = g;
                            break;
                        }
                    }
                }
                Some(m) => {
                    let pm = m.as_ptr();
                    for g in 0..n4 {
                        let w = (pm.add(g * 4) as *const u32).read_unaligned();
                        if w == 0 {
                            continue;
                        }
                        let s = v128_load(ps.add(g * 16) as *const v128);
                        let sa = u32x4_gt(u32x4_shr(s, 24), zero);
                        if !v128_any_true(sa) {
                            continue;
                        }
                        let mv = u32x4_splat(w);
                        let mv = u8x16_shuffle::<0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3>(mv, mv);
                        if v128_any_true(v128_and(sa, u32x4_gt(mv, zero))) {
                            first_g = g;
                            break;
                        }
                    }
                }
            }
            let tail_active = (n4 * 4..px).any(|i| src[i * 4 + 3] != 0 && mask.map_or(true, |m| m[i] != 0));
            if first_g == usize::MAX {
                return if tail_active { Some((n4 * 4, px)) } else { None };
            }
            if tail_active {
                return Some((first_g * 4, px));
            }
            let mut last_g = first_g;
            match mask {
                None => {
                    for g in ((first_g + 1)..n4).rev() {
                        let s = v128_load(ps.add(g * 16) as *const v128);
                        if v128_any_true(u32x4_shr(s, 24)) {
                            last_g = g;
                            break;
                        }
                    }
                }
                Some(m) => {
                    let pm = m.as_ptr();
                    for g in ((first_g + 1)..n4).rev() {
                        let w = (pm.add(g * 4) as *const u32).read_unaligned();
                        if w == 0 {
                            continue;
                        }
                        let s = v128_load(ps.add(g * 16) as *const v128);
                        let sa = u32x4_gt(u32x4_shr(s, 24), zero);
                        if !v128_any_true(sa) {
                            continue;
                        }
                        let mv = u32x4_splat(w);
                        let mv = u8x16_shuffle::<0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3>(mv, mv);
                        if v128_any_true(v128_and(sa, u32x4_gt(mv, zero))) {
                            last_g = g;
                            break;
                        }
                    }
                }
            }
            Some((first_g * 4, ((last_g + 1) * 4).min(px)))
        }
    }

    pub fn finish_masked(dst: &mut [u8], orig: &[u8], src: &[u8], mask: Option<&[u8]>) -> (usize, bool, bool) {
        let n = (dst.len() / 16) * 16;
        unsafe {
            let pd = dst.as_mut_ptr();
            let po = orig.as_ptr();
            let ps = src.as_ptr();
            let zero = u32x4_splat(0);
            let mut changed_acc = zero;
            let mut alpha_acc = zero;
            let mut i = 0;
            while i < n {
                let s = v128_load(ps.add(i) as *const v128);
                let mut active = u32x4_gt(u32x4_shr(s, 24), zero);
                if let Some(m) = mask {
                    let w = (m.as_ptr().add(i / 4) as *const u32).read_unaligned();
                    let mv = u32x4_splat(w);
                    let mv = u8x16_shuffle::<0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3>(mv, mv);
                    active = v128_and(active, u32x4_gt(mv, zero));
                }
                let d_after = v128_load(pd.add(i) as *const v128);
                let d_orig = v128_load(po.add(i) as *const v128);
                let d_final = v128_bitselect(d_after, d_orig, active);
                v128_store(pd.add(i) as *mut v128, d_final);
                changed_acc = v128_or(changed_acc, v128_xor(d_final, d_orig));
                alpha_acc = v128_or(alpha_acc, u32x4_shr(d_final, 24));
                i += 16;
            }
            (n / 4, v128_any_true(changed_acc), v128_any_true(alpha_acc))
        }
    }

    pub fn clip_coverage(cov: &mut [u8], base_mask: Option<&[u8]>, alpha: u8, own: Option<&[u8]>) -> usize {
        let n = (cov.len() / 16) * 16;
        unsafe {
            let pc = cov.as_mut_ptr();
            let av = u8x16_splat(alpha);
            let mut i = 0;
            while i < n {
                let mut v = v128_load(pc.add(i) as *const v128);
                if let Some(bm) = base_mask {
                    v = mul255(v, v128_load(bm.as_ptr().add(i) as *const v128));
                }
                if alpha < 255 {
                    v = mul255(v, av);
                }
                if let Some(o) = own {
                    v = mul255(v, v128_load(o.as_ptr().add(i) as *const v128));
                }
                v128_store(pc.add(i) as *mut v128, v);
                i += 16;
            }
        }
        n
    }

    #[inline(always)]
    unsafe fn mul255_u32(x: v128, y: v128) -> v128 {
        let t = u32x4_add(u32x4_mul(x, y), u32x4_splat(128));
        u32x4_shr(u32x4_add(t, u32x4_shr(t, 8)), 8)
    }

    pub fn dissolve_row(
        row_src: &mut [u8],
        w: usize,
        x0: u32,
        img_y: u32,
        alpha: u8,
        row_mask: Option<&[u8]>,
        seed: u32,
    ) -> usize {
        let n = (w / 4) * 4;
        unsafe {
            let ps = row_src.as_mut_ptr();
            let zero = u32x4_splat(0);
            let full = u32x4_splat(255);
            let amask = u32x4_splat(0xFF00_0000);
            let av = u32x4_splat(alpha as u32);
            let y_term = u32x4_splat(img_y.wrapping_mul(0x85eb_ca77) ^ seed);
            let kx = u32x4_splat(0x9e37_79b1);
            let k1 = u32x4_splat(0x7feb_352d);
            let k2 = u32x4_splat(0x846c_a68b);
            let step = u32x4(0, 1, 2, 3);
            let mut c = 0;
            while c < n {
                let p = v128_load(ps.add(c * 4) as *const v128);
                let src_a = u32x4_shr(p, 24);
                if !v128_any_true(src_a) {
                    c += 4;
                    continue;
                }
                let mut c_val = mul255_u32(src_a, av);
                let m_vec = match row_mask {
                    Some(rm) => {
                        let mw = (rm.as_ptr().add(c) as *const u32).read_unaligned();
                        let mv = u32x4_splat(mw);
                        u8x16_shuffle::<0, 16, 16, 16, 1, 16, 16, 16, 2, 16, 16, 16, 3, 16, 16, 16>(mv, zero)
                    }
                    None => full,
                };
                c_val = mul255_u32(c_val, m_vec);
                let xs = u32x4_add(u32x4_splat(x0.wrapping_add(c as u32)), step);
                let mut h = v128_xor(u32x4_mul(xs, kx), y_term);
                h = v128_xor(h, u32x4_shr(h, 16));
                h = u32x4_mul(h, k1);
                h = v128_xor(h, u32x4_shr(h, 15));
                h = u32x4_mul(h, k2);
                h = v128_xor(h, u32x4_shr(h, 16));
                let h_hi = u32x4_shr(h, 24);
                let keep = v128_or(u32x4_eq(c_val, full), u32x4_lt(h_hi, c_val));
                let dissolved = v128_and(v128_or(p, amask), keep);
                let is_zero = u32x4_eq(src_a, zero);
                let out = v128_bitselect(p, dissolved, is_zero);
                v128_store(ps.add(c * 4) as *mut v128, out);
                c += 4;
            }
        }
        n
    }
}
