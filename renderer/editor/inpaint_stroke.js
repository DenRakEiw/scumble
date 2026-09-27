/**
 * What a brush gesture does with the pointer before it paints (docs/PLAN_0_1_31.md §4 step 5): the pen's pressure through
 * a curve, and a stabiliser. Pure, no DOM, so tools/stroke_test.js runs it in plain Node.
 */

/** A pen's pressure (0..1) through the curve the options bar chose: "linear", "soft" (a light hand gives more) or "hard". */
export function pressureCurve(p, curve = "linear") {
    const v = Math.max(0, Math.min(1, +p || 0));
    return curve === "soft" ? Math.sqrt(v) : curve === "hard" ? v * v : v;
}

/**
 * A pull string (Krita's and Photoshop's "lazy" smoothing): the brush point stays where it is while the cursor moves within
 * `radius` of it, and beyond that it is pulled along the line to the cursor, `radius` behind; a trembling hand draws a
 * calm line and a corner is rounded by the string's length. The release draws the rest of the string to the cursor
 * (Krita's "finish line"). Coordinates in image pixels; the caller turns the options bar's screen pixels into them.
 */
export class Stabiliser {
    constructor(radius, x, y, pressure = 1) {
        this.r = Math.max(0, +radius || 0);
        this.x = x; this.y = y; this.p = pressure;
        this.cx = x; this.cy = y; this.cp = pressure;
    }

    /** The cursor at (x, y): the brush points to draw to, `[[x, y, pressure]]`, or none while the string is slack. */
    push(x, y, pressure = 1) {
        this.cx = x; this.cy = y; this.cp = pressure;
        const dx = x - this.x, dy = y - this.y, d = Math.hypot(dx, dy);
        if (!(d > this.r)) return [];
        const k = (d - this.r) / d;
        this.x += dx * k; this.y += dy * k; this.p = pressure;
        return [[this.x, this.y, pressure]];
    }

    /** The release: the rest of the string, to where the cursor was last (none when the brush is there already). */
    finish() {
        if (this.x === this.cx && this.y === this.cy) return [];
        this.x = this.cx; this.y = this.cy; this.p = this.cp;
        return [[this.x, this.y, this.cp]];
    }
}
