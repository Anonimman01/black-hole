'use strict';

/* ============================================================================
   GARGANTUA — a fully procedural black hole renderer.
   ============================================================================

   VERSION 3 — STRUCTURAL REWRITE

   Why this rewrite exists
   ------------------------
   Versions 1 and 2 built the accretion disk out of ~130 individual thin
   curves, stroked with additive ("lighter") blending. Two unit-scale bugs
   made those strokes hundreds of pixels thick, and even after fixing the
   units, stacking that many semi-transparent strokes with additive
   blending over the same screen region will *always* trend toward flat
   white wherever they overlap enough — there is no stroke-width or alpha
   value that avoids this for a shape as dense as the inner disk, because
   additive blending has no ceiling: it just keeps summing.

   Version 3 renders the bright, dense inner disk as what it visually is:
   a solid, opaque, continuous surface, not a bundle of transparent hairs.
   It's built as a triangle-free quad mesh (a grid of small filled
   polygons, corner-to-corner, sharing vertices with their neighbors) and
   painted with normal ("source-over") compositing. Painting a solid
   surface this way can never blow out to white no matter how many quads
   are drawn, because each pixel is only ever painted by the one quad that
   covers it — there is nothing to sum.

   The wispy, separated-looking filaments you see trailing off the outer
   edges of the disk in the reference image are a real, distinct visual
   regime (further out, the disk is optically thin and radiatively cool,
   so it genuinely breaks up into visible strands) and those are still
   modelled the old way — thin, sparse, few-enough-to-not-saturate
   additive strokes — because that's the correct tool for *that* job.
   Density-appropriate technique for each visual regime, rather than one
   hammer for both.

   Layer stack, back to front
   --------------------------
     1.  deep space background gradient
     2.  starfield + drifting nebula dust
     3.  disk core (solid mesh) + filaments + sparks that sit BEHIND the
         horizon (the thin secondary sliver peeking out beneath it)
     4.  the event horizon shadow itself (occludes everything under it)
     5.  disk core + filaments + sparks that sit IN FRONT of the horizon
     6.  faint background lensing arcs
     7.  orbit guide rings (subtle HUD-style dashed circles)
     8.  the photon ring and its orbiting hotspots (always frontmost)
     9.  bloom (re-reads only the brightest layers, blurs, adds back)
     10. vignette
     11. film grain

   File map (concatenated in this order into blackhole.js):
     00_config.js         - every tunable constant, grouped by subsystem
     01_utils.js          - math helpers, seeded RNG, noise, color mixing
     02_starfield.js      - background stars, nebula dust, shooting stars
     03_disk_core.js       - the solid, opaque inner accretion disk mesh
     04_disk_filaments.js   - the wispy, separated outer disk strands
     05_ring.js               - the photon ring and its orbiting hotspots
     06_horizon.js             - the event horizon shadow
     07_sparks.js               - infalling / ejected particle sparks
     08_bloom.js                 - cheap multi-pass glow compositing
     09_orbit_guides.js           - faint decorative dashed HUD rings
     10_lensing_arcs.js            - background light smeared by gravity
     11_film_grain.js                - animated dither texture
     12_adaptive_quality.js           - automatic performance scaling
     13_scene.js                       - camera drift, draw-order orchestration
     14_main.js                         - canvas setup, resize, animation loop
   ============================================================================ */

/* ============================================================================
   00. MASTER CONFIGURATION
   ============================================================================ */
const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const DEG2RAD = Math.PI / 180;

const CONFIG = {
  // --- Global scale ---------------------------------------------------------
  horizonRadiusRatio: 0.140,     // event horizon radius as a fraction of min(w,h)
  sceneScaleRatio: 1.0,          // overall multiplier applied to the whole rig

  // --- Disk inclination & the shared silhouette shape ------------------------
  // Both the solid core and the wispy filaments (and the sparks) use this
  // same silhouette function so every part of the disk agrees on its shape.
  // Lensing strength falls off with distance from the horizon, so the arch
  // height is a small constant per layer, NOT something that grows with the
  // orbital radius `f` — a bug from earlier versions that made outer disk
  // material balloon into a giant dome instead of staying close to the ring.
  inclination: -11 * DEG2RAD,     // fixed diagonal tilt of the whole disk
  diskArchRatio: 0.60,            // how tall the lensed arch over the top reaches
  diskUnderRatio: 0.135,          // how deep the secondary sliver dips underneath
  diskBackStart: Math.PI * 1.28,  // angular window (radians) treated as "behind" horizon
  diskBackEnd: Math.PI * 1.72,
  diskBaseAngularSpeed: 0.85,     // rad/s reference Keplerian speed at f = 1

  // --- Solid inner disk (the opaque, dense, optically-thick region) ---------
  diskCore: {
    innerF: 1.03,          // just outside the photon ring
    transitionF: 1.95,     // radius at which the solid core fades into filaments
    shellCount: 17,        // radial resolution of the mesh (more = smoother)
    angularSegments: 150,  // angular resolution of the mesh
    turbFreq: 2.1,         // spatial frequency of the edge turbulence
    turbAmpInner: 0.018,   // how much the innermost shell's edge wobbles
    turbAmpOuter: 0.05,    // how much the outermost (transition) shell wobbles
    featherShells: 4,      // outer shells that fade alpha -> 0 into the filaments
    innerAlpha: 0.98,      // opacity right at the horizon-hugging inner edge
    outerAlpha: 0.55,      // opacity right at the transition edge (pre-feather)
  },

  // --- Wispy outer filaments (the optically-thin, separated strands) --------
  diskInnerF: 1.95,          // starts exactly where the solid core fades out
  diskOuterF: 4.5,
  streakCount: 70,
  streakSegments: 100,
  diskBloomAlphaThreshold: 0.4,
  diskColorBucket: 6,        // segments per solid-color chunk along a strand

  // --- Relativistic beaming: approaching side brighter, receding side dimmer -
  dopplerBeamMin: 0.5,     // alpha / intensity multiplier on the receding side
  dopplerBeamMax: 1.45,    // alpha / intensity multiplier on the approaching side

  // --- Photon ring -----------------------------------------------------------
  ringInnerRatio: 1.0,        // relative to horizon radius
  ringOuterRatio: 1.16,
  ringHotspotCount: 5,
  ringHotspotSpeed: 1.55,     // rad/s
  outerRingRatio: 1.55,       // faint secondary lensed ring, further out
  outerRingAlpha: 0.09,

  // --- Sparks (small ejected flecks near the inner disk edge) ----------------
  sparkMax: 50,
  sparkSpawnRate: 10,         // sparks per second, average
  sparkInnerF: 1.05,
  sparkOuterF: 2.2,

  // --- Starfield & nebula dust -------------------------------------------------
  starCount: 340,
  nebulaBlobCount: 5,

  // --- Bloom -------------------------------------------------------------------
  bloomDownscale: 0.5,
  bloomPasses: [
    { blur: 4, alpha: 0.44 },
    { blur: 12, alpha: 0.28 },
    { blur: 28, alpha: 0.16 },
  ],

  // --- Camera drift ---------------------------------------------------------
  cameraDriftAmount: 10,       // px
  cameraBreatheAmount: 0.018,  // fractional scale wobble

  // --- Lensing arcs -----------------------------------------------------------
  lensingArcCount: 16,

  // --- Orbit guide rings (decorative HUD-style dashed circles) ----------------
  orbitGuideCount: 2,

  // --- Film grain ---------------------------------------------------------------
  grainTileSize: 128,
  grainAlpha: 0.032,
};

/* ============================================================================
   01. UTILITIES
   ============================================================================ */

/** Seeded pseudo-random number generator (mulberry32). Deterministic so the
 *  disk's structure and the starfield are reproducible frame to frame for
 *  values we only want computed once, while still looking organically
 *  random rather than hand-placed. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smooth cubic interpolation curve, 0 at edge0, 1 at edge1. */
function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Smoother quintic version, used where we need a gentler ease at the ends. */
function smootherstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function easeOutCubic(t) {
  const p = 1 - t;
  return 1 - p * p * p;
}

function easeInOutSine(t) {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/** Wraps an angle into the [0, TAU) range. */
function wrapAngle(a) {
  a = a % TAU;
  return a < 0 ? a + TAU : a;
}

/** Shortest signed distance from angle a to angle b, result in (-PI, PI]. */
function angleDelta(a, b) {
  let d = wrapAngle(b - a);
  if (d > Math.PI) d -= TAU;
  return d;
}

/** Soft-clip a 0..1-ish value so highlights compress instead of hard-clipping
 *  to flat white when multiple bright layers stack on top of each other
 *  (used sparingly — the v3 core disk mostly avoids needing this at all,
 *  since it no longer relies on additive stacking to look solid). */
function filmicSoftClip(v) {
  if (v <= 1) return v;
  return 1 + (v - 1) / (1 + (v - 1));
}

/* -------------------------------------------------------------------------
   Value noise (1D and 2D), used for turbulence: the little organic
   waviness that keeps the disk's edges from looking like perfect
   mathematical ellipses.
   ------------------------------------------------------------------------- */
class ValueNoise {
  constructor(seed) {
    const rng = makeRng(seed);
    this.size = 256;
    this.perm = new Uint8Array(this.size * 2);
    this.grad = new Float32Array(this.size * 2);
    const base = new Uint8Array(this.size);
    for (let i = 0; i < this.size; i++) base[i] = i;
    for (let i = this.size - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = base[i];
      base[i] = base[j];
      base[j] = tmp;
    }
    for (let i = 0; i < this.size * 2; i++) {
      this.perm[i] = base[i & (this.size - 1)];
      this.grad[i] = rng() * 2 - 1;
    }
  }

  noise1(x) {
    const xi = Math.floor(x) & (this.size - 1);
    const xf = x - Math.floor(x);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const a = this.grad[this.perm[xi]];
    const b = this.grad[this.perm[xi + 1]];
    return lerp(a, b, u);
  }

  noise2(x, y) {
    const xi = Math.floor(x) & (this.size - 1);
    const yi = Math.floor(y) & (this.size - 1);
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

    const p00 = this.grad[this.perm[(this.perm[xi] + yi) & (this.size * 2 - 1)]];
    const p10 = this.grad[this.perm[(this.perm[xi + 1] + yi) & (this.size * 2 - 1)]];
    const p01 = this.grad[this.perm[(this.perm[xi] + yi + 1) & (this.size * 2 - 1)]];
    const p11 = this.grad[this.perm[(this.perm[xi + 1] + yi + 1) & (this.size * 2 - 1)]];

    const nx0 = lerp(p00, p10, u);
    const nx1 = lerp(p01, p11, u);
    return lerp(nx0, nx1, v);
  }

  fbm2(x, y, octaves = 3, lacunarity = 2.0, gain = 0.5) {
    let sum = 0;
    let amp = 0.5;
    let freq = 1.0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise2(x * freq, y * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

/* -------------------------------------------------------------------------
   Color helpers.
   ------------------------------------------------------------------------- */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3
    ? h.split('').map((c) => c + c).join('')
    : h, 16);
  return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
}

function mixRgb(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function rgba(rgb, alpha) {
  return `rgba(${rgb[0] | 0}, ${rgb[1] | 0}, ${rgb[2] | 0}, ${alpha})`;
}

/**
 * Builds an n-stop gradient sampler: pass an array of {t, color:[r,g,b]}
 * sorted by t (0..1) and get back a function mapping t -> [r,g,b].
 */
function makeGradientSampler(stops) {
  return function sample(t) {
    t = clamp01(t);
    if (t <= stops[0].t) return stops[0].color;
    for (let i = 0; i < stops.length - 1; i++) {
      const s0 = stops[i];
      const s1 = stops[i + 1];
      if (t >= s0.t && t <= s1.t) {
        const localT = (t - s0.t) / (s1.t - s0.t || 1);
        return mixRgb(s0.color, s1.color, localT);
      }
    }
    return stops[stops.length - 1].color;
  };
}

/**
 * Rough Planckian-locus approximation: maps a color temperature in Kelvin
 * to an RGB triple. Not spectroscopically exact, but gives the disk's
 * inner-to-outer color progression a physically-motivated backbone (hot
 * blue-white close in, cooling through yellow/orange/red further out)
 * that the hand-authored gradient stops are then blended against for
 * artistic control.
 */
function blackbodyToRgb(kelvin) {
  const temp = clamp(kelvin, 1000, 40000) / 100;
  let r, g, b;

  if (temp <= 66) {
    r = 255;
  } else {
    r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
  }

  if (temp <= 66) {
    g = 99.4708025861 * Math.log(temp) - 161.1195681661;
  } else {
    g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
  }

  if (temp >= 66) {
    b = 255;
  } else if (temp <= 19) {
    b = 0;
  } else {
    b = 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  }

  return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
}

/* -------------------------------------------------------------------------
   requestAnimationFrame-driven ticker with delta-time clamping, so the
   simulation stays stable even after the tab was backgrounded for a while.
   ------------------------------------------------------------------------- */
class Ticker {
  constructor(onTick) {
    this.onTick = onTick;
    this.running = false;
    this.lastTime = 0;
    this._raf = null;
    this._frame = this._frame.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this._raf = requestAnimationFrame(this._frame);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _frame(now) {
    if (!this.running) return;
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    dt = Math.min(dt, 1 / 15);
    this.onTick(dt, now / 1000);
    this._raf = requestAnimationFrame(this._frame);
  }
}

/* ============================================================================
   02. STARFIELD + NEBULA DUST
   ============================================================================ */

class Star {
  constructor(rng) {
    this.nx = rng() * 2 - 1;
    this.ny = rng() * 2 - 1;
    this.depth = rng();
    this.baseRadius = lerp(0.35, 1.7, Math.pow(rng(), 2));
    this.baseAlpha = lerp(0.25, 1.0, rng());
    this.twinkleSpeed = lerp(0.4, 2.2, rng());
    this.twinklePhase = rng() * TAU;
    this.twinkleDepth = lerp(0.15, 0.85, rng());
    const tempRoll = rng();
    if (tempRoll < 0.72) {
      this.color = [255, 255, 255];
    } else if (tempRoll < 0.92) {
      this.color = [178, 205, 255];
    } else {
      this.color = [255, 214, 170];
    }
    this.driftAngle = rng() * TAU;
    this.driftSpeed = lerp(0.002, 0.01, rng()) * (rng() < 0.5 ? 1 : -1);
  }

  update(dt, t) {
    this.nx += Math.cos(this.driftAngle) * this.driftSpeed * dt;
    this.ny += Math.sin(this.driftAngle) * this.driftSpeed * dt * 0.6;
    if (this.nx > 1.05) this.nx = -1.05;
    if (this.nx < -1.05) this.nx = 1.05;
    if (this.ny > 1.05) this.ny = -1.05;
    if (this.ny < -1.05) this.ny = 1.05;
    this.twinkle = 1 - this.twinkleDepth * (0.5 + 0.5 * Math.sin(t * this.twinkleSpeed + this.twinklePhase));
  }
}

class ShootingStar {
  constructor() {
    this.active = false;
    this.life = 0;
    this.maxLife = 0;
    this.x0 = 0; this.y0 = 0; this.x1 = 0; this.y1 = 0;
    this.width = 0;
  }

  spawn(rng, w, h) {
    this.active = true;
    this.life = 0;
    this.maxLife = lerp(0.5, 0.9, rng());
    const edge = rng();
    const startX = lerp(w * 0.05, w * 0.55, edge);
    const startY = lerp(h * -0.02, h * 0.35, rng());
    const angle = lerp(18, 34, rng()) * DEG2RAD;
    const len = lerp(w * 0.18, w * 0.32, rng());
    this.x0 = startX;
    this.y0 = startY;
    this.x1 = startX + Math.cos(angle) * len;
    this.y1 = startY + Math.sin(angle) * len;
    this.width = lerp(1, 2, rng());
  }

  update(dt) {
    if (!this.active) return;
    this.life += dt;
    if (this.life >= this.maxLife) this.active = false;
  }

  draw(ctx) {
    if (!this.active) return;
    const t = this.life / this.maxLife;
    const head = easeOutCubic(clamp01(t * 1.6));
    const tailFade = clamp01(1 - t);
    const hx = lerp(this.x0, this.x1, head);
    const hy = lerp(this.y0, this.y1, head);
    const tailLen = 0.35;
    const tx = lerp(this.x0, this.x1, Math.max(0, head - tailLen));
    const ty = lerp(this.y0, this.y1, Math.max(0, head - tailLen));

    const grad = ctx.createLinearGradient(tx, ty, hx, hy);
    grad.addColorStop(0, 'rgba(210,225,255,0)');
    grad.addColorStop(1, `rgba(230,240,255,${0.85 * tailFade})`);

    ctx.save();
    ctx.strokeStyle = grad;
    ctx.lineWidth = this.width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(hx, hy);
    ctx.stroke();

    ctx.beginPath();
    ctx.fillStyle = `rgba(255,255,255,${0.9 * tailFade})`;
    ctx.arc(hx, hy, this.width * 1.4, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

/** Large, extremely faint drifting cloud blobs behind the stars — pure
 *  ambience, gives the backdrop a whisper of depth instead of flat black. */
class NebulaDust {
  constructor(rng, count) {
    this.blobs = [];
    const palette = [
      [70, 60, 110],
      [40, 70, 110],
      [90, 50, 70],
      [50, 80, 90],
    ];
    for (let i = 0; i < count; i++) {
      this.blobs.push({
        nx: rng() * 2 - 1,
        ny: rng() * 2 - 1,
        radius: lerp(0.25, 0.5, rng()),
        color: palette[Math.floor(rng() * palette.length)],
        alpha: lerp(0.03, 0.07, rng()),
        driftAngle: rng() * TAU,
        driftSpeed: lerp(0.0008, 0.002, rng()),
      });
    }
  }

  update(dt) {
    for (let i = 0; i < this.blobs.length; i++) {
      const b = this.blobs[i];
      b.nx += Math.cos(b.driftAngle) * b.driftSpeed * dt;
      b.ny += Math.sin(b.driftAngle) * b.driftSpeed * dt;
    }
  }

  draw(ctx, w, h) {
    const cx = w / 2;
    const cy = h / 2;
    const spread = Math.max(w, h) * 0.8;
    ctx.save();
    for (let i = 0; i < this.blobs.length; i++) {
      const b = this.blobs[i];
      const px = cx + b.nx * spread;
      const py = cy + b.ny * spread;
      const r = b.radius * Math.max(w, h);
      const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, rgba(b.color, b.alpha));
      grad.addColorStop(1, rgba(b.color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}

class Starfield {
  constructor(count, seed) {
    this.rng = makeRng(seed);
    this.stars = [];
    for (let i = 0; i < count; i++) this.stars.push(new Star(this.rng));
    this.nebula = new NebulaDust(this.rng, CONFIG.nebulaBlobCount);
    this.shootingStars = [];
    for (let i = 0; i < 2; i++) this.shootingStars.push(new ShootingStar());
    this.shootTimer = lerp(3, 7, this.rng());
    this.reducedMotion = false;
  }

  update(dt, t) {
    for (let i = 0; i < this.stars.length; i++) this.stars[i].update(this.reducedMotion ? 0 : dt, t);
    this.nebula.update(this.reducedMotion ? 0 : dt);

    if (this.reducedMotion) return;

    this.shootTimer -= dt;
    if (this.shootTimer <= 0) {
      const idle = this.shootingStars.find((s) => !s.active);
      if (idle && this._lastW) idle.spawn(this.rng, this._lastW, this._lastH);
      this.shootTimer = lerp(5, 12, this.rng());
    }
    for (let i = 0; i < this.shootingStars.length; i++) this.shootingStars[i].update(dt);
  }

  draw(ctx, w, h, camX, camY, camScale) {
    this._lastW = w;
    this._lastH = h;
    this.nebula.draw(ctx, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const spread = Math.max(w, h) * 0.72;

    ctx.save();
    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i];
      const parallax = 0.15 + s.depth * 0.5;
      const px = cx + s.nx * spread * camScale + camX * parallax;
      const py = cy + s.ny * spread * camScale + camY * parallax;
      if (px < -10 || px > w + 10 || py < -10 || py > h + 10) continue;

      const alpha = s.baseAlpha * s.twinkle;
      const r = s.baseRadius * (0.85 + s.depth * 0.3);
      ctx.beginPath();
      ctx.fillStyle = rgba(s.color, alpha);
      ctx.arc(px, py, r, 0, TAU);
      ctx.fill();

      if (s.baseRadius > 1.35 && alpha > 0.7) {
        ctx.globalAlpha = alpha * 0.5;
        ctx.strokeStyle = rgba(s.color, 1);
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(px - r * 3, py);
        ctx.lineTo(px + r * 3, py);
        ctx.moveTo(px, py - r * 3);
        ctx.lineTo(px, py + r * 3);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    for (let i = 0; i < this.shootingStars.length; i++) this.shootingStars[i].draw(ctx);
    ctx.restore();
  }
}

/* ============================================================================
   03. DISK CORE — the solid, opaque inner accretion disk
   ============================================================================

   The dense, optically-thick part of the disk closest to the horizon is
   modelled as a UV mesh: `shellCount + 1` radial rings, each split into
   `angularSegments` steps, sharing vertices with their radial and angular
   neighbors. Every frame, each grid vertex is repositioned along the
   shared disk silhouette (arch over the top, flat sweep at the sides,
   thin sliver underneath) with its own small turbulence displacement and
   Keplerian rotation phase (inner shells spin faster than outer ones,
   which is what gives the surface its braided, sheared look over time).

   Each small quad between four neighboring vertices is filled as an
   opaque polygon (normal "source-over" compositing) with a color/alpha
   computed from that quad's radius (brightness falls off outward) and
   angular position (Doppler beaming: brighter/bluer on the approaching
   side, dimmer/redder on the receding side). Because adjacent quads share
   exact vertex coordinates, the mesh has no gaps, and because the fill is
   opaque rather than additive, there is no mechanism for it to blow out
   to flat white no matter how dense the mesh is.
   ============================================================================ */

const CORE_COLOR_STOPS = {
  approaching: makeGradientSampler([
    { t: 0.0, color: hexToRgb('#f5fbff') },
    { t: 0.4, color: hexToRgb('#cfe9ff') },
    { t: 1.0, color: hexToRgb('#5aa8ff') },
  ]),
  receding: makeGradientSampler([
    { t: 0.0, color: hexToRgb('#fff2df') },
    { t: 0.4, color: hexToRgb('#ff9a55') },
    { t: 1.0, color: hexToRgb('#8a3018') },
  ]),
};

class DiskCore {
  constructor(seed) {
    const cfg = CONFIG.diskCore;
    this.cfg = cfg;
    this.noise = new ValueNoise(seed);
    this.rng = makeRng(seed + 11);

    this.shellCount = cfg.shellCount;
    this.segCount = cfg.angularSegments;

    // Radius per shell, biased toward the inner edge (more shells packed
    // where curvature is tightest) so the ring stays smooth without
    // needing uniform density everywhere.
    this.shellF = new Array(this.shellCount + 1);
    for (let i = 0; i <= this.shellCount; i++) {
      const t = i / this.shellCount;
      const biased = Math.pow(t, 0.72);
      this.shellF[i] = lerp(cfg.innerF, cfg.transitionF, biased);
    }

    this.shellSeed = new Array(this.shellCount + 1);
    for (let i = 0; i <= this.shellCount; i++) this.shellSeed[i] = this.rng() * 1000;

    this.phase0 = this.rng() * TAU;

    // Flat typed-array-free grid of {x,y,isBack} for simplicity; rebuilt
    // in place every frame rather than reallocated.
    this.points = [];
    for (let i = 0; i <= this.shellCount; i++) {
      const row = new Array(this.segCount + 1);
      for (let j = 0; j <= this.segCount; j++) row[j] = { x: 0, y: 0, isBack: false };
      this.points.push(row);
    }
  }

  update(t, reducedMotion) {
    const cfg = this.cfg;
    const incCos = Math.cos(CONFIG.inclination);
    const incSin = Math.sin(CONFIG.inclination);

    for (let i = 0; i <= this.shellCount; i++) {
      const f = this.shellF[i];
      const angularSpeed = CONFIG.diskBaseAngularSpeed / Math.pow(f, 1.5);
      const phase = reducedMotion ? this.phase0 : this.phase0 + t * angularSpeed;
      const seed = this.shellSeed[i];
      const innerT = clamp01((f - cfg.innerF) / (cfg.transitionF - cfg.innerF));
      const turbAmp = lerp(cfg.turbAmpInner, cfg.turbAmpOuter, innerT);
      const row = this.points[i];

      for (let j = 0; j <= this.segCount; j++) {
        const phi = (j / this.segCount) * TAU + phase;
        const turbT = reducedMotion ? 0 : t * 0.05;
        const n = this.noise.fbm2(
          Math.cos(phi) * cfg.turbFreq + seed,
          Math.sin(phi) * cfg.turbFreq + turbT,
          3
        );
        const phiJ = phi + n * turbAmp;
        const s = Math.sin(phiJ);
        const c = Math.cos(phiJ);

        // Same shared silhouette shape used by the filaments and the
        // sparks: arch over the top (negative Y = up on canvas), thin
        // sliver underneath (positive Y = down). Arch height is a fixed
        // per-layer constant, independent of `f` — see the note in CONFIG.
        let ry;
        if (s >= 0) {
          ry = -CONFIG.diskArchRatio * Math.pow(s, 0.62);
        } else {
          ry = CONFIG.diskUnderRatio * Math.pow(-s, 1.9);
        }

        const radialJitter = 1 + n * 0.02;
        const lx = f * c * radialJitter;
        const ly = ry * radialJitter;

        const rx = lx * incCos - ly * incSin;
        const ryy = lx * incSin + ly * incCos;

        const wrapped = wrapAngle(phi);
        const isBack = wrapped > CONFIG.diskBackStart && wrapped < CONFIG.diskBackEnd;

        const p = row[j];
        p.x = rx;
        p.y = ryy;
        p.isBack = isBack;
      }
    }
  }

  /** Doppler + radial-brightness color and intensity for one mesh quad. */
  _shade(fMid, xMid) {
    const cfg = this.cfg;
    const innerT = clamp01((fMid - cfg.innerF) / (cfg.transitionF - cfg.innerF));
    const side = clamp01(0.5 - xMid / (fMid * 2.2));
    const sampler = side > 0.5 ? CORE_COLOR_STOPS.approaching : CORE_COLOR_STOPS.receding;
    const color = sampler(innerT);
    const beam = lerp(CONFIG.dopplerBeamMin, CONFIG.dopplerBeamMax, side);
    const baseAlpha = lerp(cfg.innerAlpha, cfg.outerAlpha, innerT);
    return { color, alpha: clamp01(baseAlpha * clamp(beam, 0.35, 1.5)) };
  }

  draw(ctx, cx, cy, scale, layer) {
    const cfg = this.cfg;
    const featherStart = this.shellCount - cfg.featherShells;

    ctx.save();
    for (let i = 0; i < this.shellCount; i++) {
      const rowA = this.points[i];
      const rowB = this.points[i + 1];
      const fMid = (this.shellF[i] + this.shellF[i + 1]) / 2;

      let featherAlpha = 1;
      if (i >= featherStart) {
        featherAlpha = 1 - (i - featherStart + 1) / (cfg.featherShells + 1);
      }
      if (featherAlpha <= 0.001) continue;

      for (let j = 0; j < this.segCount; j++) {
        const p00 = rowA[j];
        const p01 = rowA[j + 1];
        const p11 = rowB[j + 1];
        const p10 = rowB[j];

        const matches = layer === 'back' ? p00.isBack : !p00.isBack;
        if (!matches) continue;

        const xMid = (p00.x + p01.x + p11.x + p10.x) / 4;
        const shade = this._shade(fMid, xMid);
        const alpha = shade.alpha * featherAlpha;
        if (alpha <= 0.004) continue;

        ctx.beginPath();
        ctx.moveTo(cx + p00.x * scale, cy + p00.y * scale);
        ctx.lineTo(cx + p01.x * scale, cy + p01.y * scale);
        ctx.lineTo(cx + p11.x * scale, cy + p11.y * scale);
        ctx.lineTo(cx + p10.x * scale, cy + p10.y * scale);
        ctx.closePath();
        ctx.fillStyle = rgba(shade.color, alpha);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** Bright-only pass for the bloom buffer: just the innermost, hottest
   *  shells, drawn additively so they contribute glow without needing to
   *  redraw (and re-cost) the entire mesh. */
  drawBright(ctx, cx, cy, scale, layer) {
    const cfg = this.cfg;
    const brightShells = Math.max(2, Math.round(this.shellCount * 0.28));

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < brightShells; i++) {
      const rowA = this.points[i];
      const rowB = this.points[i + 1];
      const fMid = (this.shellF[i] + this.shellF[i + 1]) / 2;

      for (let j = 0; j < this.segCount; j++) {
        const p00 = rowA[j];
        const p01 = rowA[j + 1];
        const p11 = rowB[j + 1];
        const p10 = rowB[j];

        const matches = layer === 'back' ? p00.isBack : !p00.isBack;
        if (!matches) continue;

        const xMid = (p00.x + p01.x + p11.x + p10.x) / 4;
        const shade = this._shade(fMid, xMid);
        const alpha = shade.alpha * 0.5;

        ctx.beginPath();
        ctx.moveTo(cx + p00.x * scale, cy + p00.y * scale);
        ctx.lineTo(cx + p01.x * scale, cy + p01.y * scale);
        ctx.lineTo(cx + p11.x * scale, cy + p11.y * scale);
        ctx.lineTo(cx + p10.x * scale, cy + p10.y * scale);
        ctx.closePath();
        ctx.fillStyle = rgba(shade.color, alpha);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

/* ============================================================================
   04. DISK FILAMENTS — the wispy, optically-thin outer strands
   ============================================================================

   Further from the horizon, the same accretion flow becomes optically
   thin enough that it genuinely reads as separated strands rather than a
   solid sheet — the frayed, hair-like trailing edges visible in the
   reference image. These are drawn the way v1/v2 drew the *whole* disk:
   thin individual curves with additive blending. That approach is the
   right tool here specifically because there are few enough of them, and
   they're thin and faint enough, that they don't saturate — unlike the
   dense inner region, which is why that part moved to the opaque mesh
   approach in DiskCore above.
   ============================================================================ */

const FILAMENT_COLOR_STOPS = {
  approaching: makeGradientSampler([
    { t: 0.0, color: hexToRgb('#eaf6ff') },
    { t: 1.0, color: hexToRgb('#3f7fc9') },
  ]),
  receding: makeGradientSampler([
    { t: 0.0, color: hexToRgb('#ffd9b0') },
    { t: 1.0, color: hexToRgb('#5c2410') },
  ]),
};

class DiskFilament {
  constructor(rng, noise) {
    this.noise = noise;

    const spread = Math.pow(rng(), 1.6);
    this.f = lerp(CONFIG.diskInnerF, CONFIG.diskOuterF, spread);

    this.angularSpeed = CONFIG.diskBaseAngularSpeed / Math.pow(this.f, 1.5);
    this.phase = rng() * TAU;
    this.turbSeed = rng() * 1000;
    this.turbFreq = lerp(1.2, 2.6, rng());

    const innerness = 1 - clamp01((this.f - CONFIG.diskInnerF) / (CONFIG.diskOuterF - CONFIG.diskInnerF));
    this.turbAmp = lerp(0.05, 0.20, 1 - innerness) + 0.03;

    // Thin, real strand widths (a small fraction of the horizon radius,
    // NOT multiples of it — see the v2 fix notes for why this matters).
    this.baseAlpha = lerp(0.05, 0.34, Math.pow(innerness, 1.3));
    this.baseWidth = lerp(0.006, 0.020, Math.pow(innerness, 1.1));

    this.archLift = lerp(0.85, 1.05, rng());
    this.points = new Array(CONFIG.streakSegments + 1);
    for (let i = 0; i <= CONFIG.streakSegments; i++) this.points[i] = { x: 0, y: 0, isBack: false };
  }

  _silhouette(phi) {
    const s = Math.sin(phi);
    const c = Math.cos(phi);
    const rx = this.f;
    let ry;
    if (s >= 0) {
      ry = -CONFIG.diskArchRatio * Math.pow(s, 0.62) * this.archLift;
    } else {
      ry = CONFIG.diskUnderRatio * Math.pow(-s, 1.9) * this.archLift;
    }
    return { x: rx * c, y: ry };
  }

  update(t, reducedMotion) {
    const phase = reducedMotion ? this.phase : this.phase + t * this.angularSpeed;
    const segs = CONFIG.streakSegments;
    const incCos = Math.cos(CONFIG.inclination);
    const incSin = Math.sin(CONFIG.inclination);

    for (let i = 0; i <= segs; i++) {
      const phi = (i / segs) * TAU + phase;
      const turbT = reducedMotion ? 0 : t * 0.06;
      const n = this.noise.fbm2(
        Math.cos(phi) * this.turbFreq + this.turbSeed,
        Math.sin(phi) * this.turbFreq + turbT,
        3
      );
      const phiJ = phi + n * this.turbAmp;

      const local = this._silhouette(phiJ);
      const radialJitter = 1 + n * 0.04;
      const lx = local.x * radialJitter;
      const ly = local.y * radialJitter;

      const rx = lx * incCos - ly * incSin;
      const ry = lx * incSin + ly * incCos;

      const isBack = wrapAngle(phi) > CONFIG.diskBackStart && wrapAngle(phi) < CONFIG.diskBackEnd;

      const p = this.points[i];
      p.x = rx;
      p.y = ry;
      p.isBack = isBack;
    }
  }

  _colorFor(point) {
    const side = clamp01(0.5 - point.x / (this.f * 2.2));
    const sampler = side > 0.5 ? FILAMENT_COLOR_STOPS.approaching : FILAMENT_COLOR_STOPS.receding;
    const innerness = 1 - clamp01((this.f - CONFIG.diskInnerF) / (CONFIG.diskOuterF - CONFIG.diskInnerF));
    return { color: sampler(1 - innerness), side };
  }

  draw(ctx, cx, cy, scale, layer) {
    const pts = this.points;
    const bucketSize = CONFIG.diskColorBucket;

    ctx.lineWidth = this.baseWidth * scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let i = 0;
    while (i < pts.length - 1) {
      const bucketEnd = Math.min(i + bucketSize, pts.length - 1);
      const mid = pts[Math.floor((i + bucketEnd) / 2)];
      const matches = layer === 'back' ? mid.isBack : !mid.isBack;

      if (matches) {
        const { color, side } = this._colorFor(mid);
        const beam = lerp(CONFIG.dopplerBeamMin, CONFIG.dopplerBeamMax, side);
        const alpha = clamp01(this.baseAlpha * beam);
        ctx.strokeStyle = rgba(color, alpha);
        ctx.beginPath();
        ctx.moveTo(cx + pts[i].x * scale, cy + pts[i].y * scale);
        for (let j = i + 1; j <= bucketEnd; j++) {
          const p = pts[j];
          const pMatches = layer === 'back' ? p.isBack : !p.isBack;
          if (!pMatches) break;
          ctx.lineTo(cx + p.x * scale, cy + p.y * scale);
        }
        ctx.stroke();
      }
      i = bucketEnd;
    }
  }

  isBright() {
    return this.baseAlpha > CONFIG.diskBloomAlphaThreshold;
  }
}

class DiskFilaments {
  constructor(seed) {
    this.rng = makeRng(seed);
    this.noise = new ValueNoise(seed + 7);
    this.strands = [];
    for (let i = 0; i < CONFIG.streakCount; i++) {
      this.strands.push(new DiskFilament(this.rng, this.noise));
    }
    this.strands.sort((a, b) => b.f - a.f);
  }

  update(dt, t, reducedMotion) {
    for (let i = 0; i < this.strands.length; i++) this.strands[i].update(t, reducedMotion);
  }

  drawLayer(ctx, cx, cy, scale, layer) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.strands.length; i++) {
      this.strands[i].draw(ctx, cx, cy, scale, layer);
    }
    ctx.restore();
  }

  drawBright(ctx, cx, cy, scale, layer) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.strands.length; i++) {
      const s = this.strands[i];
      if (s.isBright()) s.draw(ctx, cx, cy, scale, layer);
    }
    ctx.restore();
  }
}

/* ============================================================================
   05. PHOTON RING
   ============================================================================ */

class PhotonRing {
  constructor(rng) {
    this.hotspots = [];
    for (let i = 0; i < CONFIG.ringHotspotCount; i++) {
      this.hotspots.push({
        phase: (i / CONFIG.ringHotspotCount) * TAU + rng() * 0.6,
        speedMul: lerp(0.85, 1.25, rng()),
        sizeMul: lerp(0.7, 1.3, rng()),
        flickerSeed: rng() * 1000,
      });
    }
    this.baseRotation = 0;
  }

  update(dt, t, reducedMotion) {
    this.t = t;
    this.reducedMotion = reducedMotion;
    this.baseRotation = reducedMotion ? 0 : t * 0.12;
  }

  _drawBandTilted(ctx, cx, cy, r, squash, rotation) {
    const layers = [
      { w: r * 0.30, a: 0.09, colorT: 0.9 },
      { w: r * 0.17, a: 0.20, colorT: 0.55 },
      { w: r * 0.085, a: 0.50, colorT: 0.22 },
      { w: r * 0.04, a: 0.95, colorT: 0.0 },
    ];
    const coldEdge = hexToRgb('#4fa6ff');
    const hotCore = hexToRgb('#ffffff');

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      const color = mixRgb(hotCore, coldEdge, L.colorT);
      ctx.beginPath();
      ctx.strokeStyle = rgba(color, L.a);
      ctx.lineWidth = L.w;
      ctx.save();
      ctx.scale(1, squash);
      ctx.arc(0, 0, r, 0, TAU);
      ctx.restore();
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawOuterRing(ctx, cx, cy, horizonRadius, squash, rotation) {
    const r = horizonRadius * CONFIG.outerRingRatio;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.scale(1, squash);
    ctx.beginPath();
    ctx.strokeStyle = rgba(hexToRgb('#bfe3ff'), CONFIG.outerRingAlpha);
    ctx.lineWidth = horizonRadius * 0.03;
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  _drawHotspots(ctx, cx, cy, r, squash, rotation) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.hotspots.length; i++) {
      const h = this.hotspots[i];
      const angle = h.phase + this.t * CONFIG.ringHotspotSpeed * h.speedMul * (this.reducedMotion ? 0 : 1);
      const flicker = 0.75 + 0.25 * Math.sin(this.t * 4.3 + h.flickerSeed);

      const lx = Math.cos(angle) * r;
      const ly = Math.sin(angle) * r * squash;
      const rx = lx * Math.cos(rotation) - ly * Math.sin(rotation);
      const ry = lx * Math.sin(rotation) + ly * Math.cos(rotation);
      const px = cx + rx;
      const py = cy + ry;

      const size = r * 0.15 * h.sizeMul * flicker;
      const grad = ctx.createRadialGradient(px, py, 0, px, py, size);
      grad.addColorStop(0, 'rgba(255,255,255,0.9)');
      grad.addColorStop(0.4, 'rgba(220,240,255,0.5)');
      grad.addColorStop(1, 'rgba(220,240,255,0)');
      ctx.beginPath();
      ctx.fillStyle = grad;
      ctx.arc(px, py, size, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  draw(ctx, cx, cy, horizonRadius) {
    const rMid = horizonRadius * (CONFIG.ringInnerRatio + CONFIG.ringOuterRatio) / 2;
    const squash = 0.94;
    this._drawOuterRing(ctx, cx, cy, horizonRadius, squash, CONFIG.inclination);
    this._drawBandTilted(ctx, cx, cy, rMid, squash, CONFIG.inclination + this.baseRotation * 0.05);
    this._drawHotspots(ctx, cx, cy, rMid, squash, CONFIG.inclination);
  }

  drawBright(ctx, cx, cy, horizonRadius) {
    const rMid = horizonRadius * (CONFIG.ringInnerRatio + CONFIG.ringOuterRatio) / 2;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = rMid * 0.04;
    ctx.translate(cx, cy);
    ctx.rotate(CONFIG.inclination + this.baseRotation * 0.05);
    ctx.scale(1, 0.94);
    ctx.arc(0, 0, rMid, 0, TAU);
    ctx.stroke();
    ctx.restore();
    this._drawHotspots(ctx, cx, cy, rMid, 0.94, CONFIG.inclination);
  }
}

/* ============================================================================
   06. EVENT HORIZON
   ============================================================================ */

class EventHorizon {
  constructor() {
    this.pulsePhase = 0;
  }

  update(dt, t, reducedMotion) {
    this.pulsePhase = reducedMotion ? 0 : Math.sin(t * 0.22) * 0.012;
  }

  draw(ctx, cx, cy, radius) {
    const r = radius * (1 + this.pulsePhase);

    const haloR = r * 2.1;
    const halo = ctx.createRadialGradient(cx, cy, r * 0.7, cx, cy, haloR);
    halo.addColorStop(0, 'rgba(2,3,10,0.9)');
    halo.addColorStop(0.5, 'rgba(2,3,10,0.55)');
    halo.addColorStop(1, 'rgba(2,3,10,0)');
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = halo;
    ctx.arc(cx, cy, haloR, 0, TAU);
    ctx.fill();
    ctx.restore();

    const body = ctx.createRadialGradient(
      cx - r * 0.18, cy - r * 0.18, r * 0.1,
      cx, cy, r
    );
    body.addColorStop(0, '#050608');
    body.addColorStop(0.7, '#020207');
    body.addColorStop(1, '#000000');

    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = body;
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

/* ============================================================================
   07. SPARKS
   ============================================================================ */

class Spark {
  constructor() {
    this.active = false;
  }

  spawn(rng, innerF, outerF) {
    this.active = true;
    this.f = lerp(innerF, outerF, rng());
    this.angle = rng() * TAU;
    this.angularSpeed = (CONFIG.diskBaseAngularSpeed / Math.pow(this.f, 1.5)) * lerp(0.9, 1.3, rng());
    this.driftOut = lerp(0.1, 0.35, rng());
    this.life = 0;
    this.maxLife = lerp(1.2, 2.8, rng());
    // Real, small units: a fraction of the horizon radius, not a multiple.
    this.size = lerp(0.010, 0.026, rng());
    this.hue = rng();
    this.prevX = null;
    this.prevY = null;
  }

  update(dt) {
    if (!this.active) return;
    this.life += dt;
    if (this.life >= this.maxLife) {
      this.active = false;
      return;
    }
    this.angle += this.angularSpeed * dt;
    this.f += this.driftOut * dt * 0.3;
  }

  _localPos() {
    const s = Math.sin(this.angle);
    const c = Math.cos(this.angle);
    const rx = this.f;
    const ry = (s >= 0
      ? -CONFIG.diskArchRatio * Math.pow(s, 0.62)
      : CONFIG.diskUnderRatio * Math.pow(-s, 1.9));
    return { x: rx * c, y: ry };
  }

  worldPos() {
    const local = this._localPos();
    const incCos = Math.cos(CONFIG.inclination);
    const incSin = Math.sin(CONFIG.inclination);
    return {
      x: local.x * incCos - local.y * incSin,
      y: local.x * incSin + local.y * incCos,
      isBack: wrapAngle(this.angle) > CONFIG.diskBackStart && wrapAngle(this.angle) < CONFIG.diskBackEnd,
    };
  }

  draw(ctx, cx, cy, scale, layer) {
    if (!this.active) return;
    const pos = this.worldPos();
    if ((layer === 'back') !== !!pos.isBack) {
      this.prevX = null;
      this.prevY = null;
      return;
    }

    const fadeIn = clamp01(this.life / 0.2);
    const fadeOut = clamp01((this.maxLife - this.life) / 0.5);
    const alpha = fadeIn * fadeOut * 0.85;

    const color = this.hue < 0.6
      ? mixRgb(hexToRgb('#ffffff'), hexToRgb('#bfe3ff'), this.hue / 0.6)
      : mixRgb(hexToRgb('#bfe3ff'), hexToRgb('#ff8a4a'), (this.hue - 0.6) / 0.4);

    const px = cx + pos.x * scale;
    const py = cy + pos.y * scale;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    if (this.prevX !== null) {
      ctx.beginPath();
      ctx.strokeStyle = rgba(color, alpha * 0.5);
      ctx.lineWidth = this.size * scale * 0.4;
      ctx.lineCap = 'round';
      ctx.moveTo(this.prevX, this.prevY);
      ctx.lineTo(px, py);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.fillStyle = rgba(color, alpha);
    ctx.arc(px, py, this.size * scale * 0.55, 0, TAU);
    ctx.fill();
    ctx.restore();

    this.prevX = px;
    this.prevY = py;
  }
}

class SparkSystem {
  constructor(seed) {
    this.rng = makeRng(seed);
    this.pool = [];
    for (let i = 0; i < CONFIG.sparkMax; i++) this.pool.push(new Spark());
    this.spawnAccumulator = 0;
  }

  update(dt, reducedMotion) {
    if (reducedMotion) return;
    this.spawnAccumulator += dt * CONFIG.sparkSpawnRate;
    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;
      const idle = this.pool.find((s) => !s.active);
      if (idle) idle.spawn(this.rng, CONFIG.sparkInnerF, CONFIG.sparkOuterF);
    }
    for (let i = 0; i < this.pool.length; i++) this.pool[i].update(dt);
  }

  draw(ctx, cx, cy, scale, layer) {
    for (let i = 0; i < this.pool.length; i++) this.pool[i].draw(ctx, cx, cy, scale, layer);
  }
}

/* ============================================================================
   08. BLOOM
   ============================================================================ */

class Bloom {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
  }

  resize(w, h) {
    this.w = Math.max(1, Math.round(w * CONFIG.bloomDownscale));
    this.h = Math.max(1, Math.round(h * CONFIG.bloomDownscale));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
  }

  render(mainCtx, fullW, fullH, paintBright) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();
    ctx.scale(CONFIG.bloomDownscale, CONFIG.bloomDownscale);
    paintBright(ctx);
    ctx.restore();

    mainCtx.save();
    mainCtx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < CONFIG.bloomPasses.length; i++) {
      const pass = CONFIG.bloomPasses[i];
      mainCtx.globalAlpha = pass.alpha;
      mainCtx.filter = `blur(${pass.blur}px)`;
      mainCtx.drawImage(this.canvas, 0, 0, this.w, this.h, 0, 0, fullW, fullH);
    }
    mainCtx.filter = 'none';
    mainCtx.globalAlpha = 1;
    mainCtx.restore();
  }
}

/* ============================================================================
   09. ORBIT GUIDES — faint decorative dashed HUD-style rings
   ============================================================================
   A small finishing touch: one or two very faint, slowly-rotating dashed
   circles a bit further out than the photon ring, reminiscent of a
   targeting reticle or an orbit-plane indicator in a spacecraft HUD. Pure
   decoration, tuned to be almost subliminal rather than a visible design
   element competing with the ring itself.
   ============================================================================ */

class OrbitGuides {
  constructor(rng, count) {
    this.rings = [];
    for (let i = 0; i < count; i++) {
      this.rings.push({
        radiusRatio: lerp(1.55, 2.3, rng()),
        dashLen: lerp(4, 14, rng()),
        gapLen: lerp(10, 28, rng()),
        rotSpeed: lerp(-0.02, 0.02, rng()),
        alpha: lerp(0.05, 0.11, rng()),
        squash: lerp(0.9, 0.97, rng()),
      });
    }
  }

  update(dt, t, reducedMotion) {
    this.t = t;
    this.reducedMotion = reducedMotion;
  }

  draw(ctx, cx, cy, horizonRadius) {
    ctx.save();
    for (let i = 0; i < this.rings.length; i++) {
      const g = this.rings[i];
      const rot = CONFIG.inclination + (this.reducedMotion ? 0 : this.t * g.rotSpeed);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.scale(1, g.squash);
      ctx.beginPath();
      ctx.setLineDash([g.dashLen, g.gapLen]);
      ctx.strokeStyle = rgba([180, 205, 235], g.alpha);
      ctx.lineWidth = 1;
      ctx.arc(0, 0, horizonRadius * g.radiusRatio, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    ctx.restore();
  }
}

/* ============================================================================
   10. LENSING ARCS
   ============================================================================ */

class LensingArcs {
  constructor(rng, count) {
    this.arcs = [];
    for (let i = 0; i < count; i++) {
      const angle = rng() * TAU;
      this.arcs.push({
        angle,
        arcSpan: lerp(0.10, 0.34, rng()),
        radiusRatio: lerp(1.22, 1.9, rng()),
        thickness: lerp(0.6, 1.6, rng()),
        baseAlpha: lerp(0.08, 0.28, rng()),
        flickerSpeed: lerp(0.15, 0.5, rng()),
        flickerSeed: rng() * TAU,
        driftSpeed: lerp(-0.03, 0.03, rng()),
      });
    }
  }

  update(dt, t, reducedMotion) {
    this.t = t;
    this.reducedMotion = reducedMotion;
  }

  draw(ctx, cx, cy, horizonRadius) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.arcs.length; i++) {
      const a = this.arcs[i];
      const drift = this.reducedMotion ? 0 : this.t * a.driftSpeed;
      const flicker = this.reducedMotion
        ? 0.7
        : 0.55 + 0.45 * Math.sin(this.t * a.flickerSpeed + a.flickerSeed);
      const alpha = a.baseAlpha * flicker;
      const r = horizonRadius * a.radiusRatio;
      const start = a.angle + drift;
      const end = start + a.arcSpan;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(CONFIG.inclination);
      ctx.scale(1, 0.94);
      ctx.beginPath();
      ctx.strokeStyle = rgba([210, 230, 255], alpha);
      ctx.lineWidth = a.thickness;
      ctx.lineCap = 'round';
      ctx.arc(0, 0, r, start, end);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }
}

/* ============================================================================
   11. FILM GRAIN
   ============================================================================ */

class FilmGrain {
  constructor(seed, tileSize) {
    this.tileSize = tileSize;
    this.tiles = [];
    const rng = makeRng(seed);
    for (let t = 0; t < 4; t++) {
      const c = document.createElement('canvas');
      c.width = tileSize;
      c.height = tileSize;
      const tctx = c.getContext('2d');
      const imgData = tctx.createImageData(tileSize, tileSize);
      for (let i = 0; i < imgData.data.length; i += 4) {
        const v = Math.floor(rng() * 255);
        imgData.data[i] = v;
        imgData.data[i + 1] = v;
        imgData.data[i + 2] = v;
        imgData.data[i + 3] = 255;
      }
      tctx.putImageData(imgData, 0, 0);
      this.tiles.push(c);
    }
    this._frameCounter = 0;
    this._tileIndex = 0;
  }

  draw(ctx, w, h, alpha) {
    this._frameCounter++;
    if (this._frameCounter % 3 === 0) {
      this._tileIndex = (this._tileIndex + 1) % this.tiles.length;
    }
    const tile = this.tiles[this._tileIndex];
    const pattern = ctx.createPattern(tile, 'repeat');
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}

/* ============================================================================
   12. ADAPTIVE QUALITY
   ============================================================================ */

class AdaptiveQuality {
  constructor(scene) {
    this.scene = scene;
    this.samples = [];
    this.sampleWindow = 90;
    this.settled = false;
    this.tier = 3;
  }

  record(dt) {
    if (this.settled) return;

    this.samples.push(dt);
    if (this.samples.length < this.sampleWindow) return;

    const avg = this.samples.reduce((s, v) => s + v, 0) / this.samples.length;
    const fps = 1 / Math.max(avg, 0.0001);
    this.samples.length = 0;

    if (fps >= 50) {
      this.settled = true;
      return;
    }

    if (this.tier > 0) {
      this.tier -= 1;
      this._applyTier();
    } else {
      this.settled = true;
    }
  }

  _applyTier() {
    switch (this.tier) {
      case 2:
        CONFIG.grainAlpha = 0;
        break;
      case 1:
        CONFIG.bloomPasses = [
          { blur: 5, alpha: 0.5 },
          { blur: 16, alpha: 0.3 },
        ];
        CONFIG.lensingArcCount = 8;
        this.scene.lensing.arcs.length = Math.min(this.scene.lensing.arcs.length, 8);
        break;
      case 0:
        this.scene.filaments.strands.sort((a, b) => a.f - b.f);
        this.scene.filaments.strands.length = Math.min(this.scene.filaments.strands.length, 40);
        CONFIG.sparkMax = 22;
        this.scene.sparks.pool.length = Math.min(this.scene.sparks.pool.length, 22);
        break;
    }
  }
}

/* ============================================================================
   13. SCENE
   ============================================================================ */

class Scene {
  constructor(seed) {
    this.seed = seed;
    this.starfield = new Starfield(CONFIG.starCount, seed + 1);
    this.core = new DiskCore(seed + 2);
    this.filaments = new DiskFilaments(seed + 20);
    this.ring = new PhotonRing(makeRng(seed + 3));
    this.horizon = new EventHorizon();
    this.sparks = new SparkSystem(seed + 4);
    this.camera = new CameraDrift(seed + 5);
    this.bloom = new Bloom();
    this.lensing = new LensingArcs(makeRng(seed + 6), CONFIG.lensingArcCount);
    this.orbitGuides = new OrbitGuides(makeRng(seed + 8), CONFIG.orbitGuideCount);
    this.grain = new FilmGrain(seed + 7, CONFIG.grainTileSize);

    this.reducedMotion = false;
    this.w = 0;
    this.h = 0;
    this.cx = 0;
    this.cy = 0;
    this.horizonRadius = 0;
    this.diskScale = 0;
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.cx = w / 2;
    this.cy = h * 0.46;
    this.horizonRadius = Math.min(w, h) * CONFIG.horizonRadiusRatio;
    this.diskScale = this.horizonRadius;
    this.bloom.resize(w, h);
  }

  setReducedMotion(v) {
    this.reducedMotion = v;
    this.starfield.reducedMotion = v;
  }

  update(dt, t) {
    this.starfield.update(dt, t);
    this.core.update(t, this.reducedMotion);
    this.filaments.update(dt, t, this.reducedMotion);
    this.ring.update(dt, t, this.reducedMotion);
    this.horizon.update(dt, t, this.reducedMotion);
    this.sparks.update(dt, this.reducedMotion);
    this.camera.update(t, this.reducedMotion);
    this.lensing.update(dt, t, this.reducedMotion);
    this.orbitGuides.update(dt, t, this.reducedMotion);
  }

  _drawDiskBack(ctx, cx, cy, scale) {
    this.core.draw(ctx, cx, cy, scale, 'back');
    this.filaments.drawLayer(ctx, cx, cy, scale, 'back');
    this.sparks.draw(ctx, cx, cy, scale, 'back');
  }

  _drawDiskFront(ctx, cx, cy, scale) {
    this.core.draw(ctx, cx, cy, scale, 'front');
    this.filaments.drawLayer(ctx, cx, cy, scale, 'front');
    this.sparks.draw(ctx, cx, cy, scale, 'front');
  }

  draw(ctx) {
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);

    const bg = ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, Math.max(w, h) * 0.75);
    bg.addColorStop(0, '#050710');
    bg.addColorStop(0.55, '#020308');
    bg.addColorStop(1, '#000000');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const camX = this.camera.x;
    const camY = this.camera.y;
    const camScale = this.camera.scale;

    this.starfield.draw(ctx, w, h, camX, camY, camScale);

    const cx = this.cx + camX;
    const cy = this.cy + camY;
    const scale = this.diskScale * camScale;

    this._drawDiskBack(ctx, cx, cy, scale);
    this.horizon.draw(ctx, cx, cy, this.horizonRadius * camScale);
    this._drawDiskFront(ctx, cx, cy, scale);
    this.lensing.draw(ctx, cx, cy, this.horizonRadius * camScale);
    this.orbitGuides.draw(ctx, cx, cy, this.horizonRadius * camScale);
    this.ring.draw(ctx, cx, cy, this.horizonRadius * camScale);

    this.bloom.render(ctx, w, h, (bctx) => {
      this.core.drawBright(bctx, cx, cy, scale, 'front');
      this.filaments.drawBright(bctx, cx, cy, scale, 'front');
      this.ring.drawBright(bctx, cx, cy, this.horizonRadius * camScale);
    });

    this._drawVignette(ctx, w, h);
    this.grain.draw(ctx, w, h, CONFIG.grainAlpha);
  }

  _drawVignette(ctx, w, h) {
    const vg = ctx.createRadialGradient(
      this.cx, this.cy, Math.min(w, h) * 0.25,
      this.cx, this.cy, Math.max(w, h) * 0.72
    );
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.save();
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}

/* Camera drift lives here so Scene can reference it above without forward
 * declaration trouble in engines that care about hoisting order. */
class CameraDrift {
  constructor(seed) {
    this.noise = new ValueNoise(seed + 99);
    this.x = 0;
    this.y = 0;
    this.scale = 1;
  }

  update(t, reducedMotion) {
    if (reducedMotion) {
      this.x = 0;
      this.y = 0;
      this.scale = 1;
      return;
    }
    const nx = this.noise.noise1(t * 0.05);
    const ny = this.noise.noise1(t * 0.05 + 37.1);
    const nz = this.noise.noise1(t * 0.035 + 91.4);
    this.x = nx * CONFIG.cameraDriftAmount;
    this.y = ny * CONFIG.cameraDriftAmount * 0.6;
    this.scale = 1 + nz * CONFIG.cameraBreatheAmount;
  }
}

/* ============================================================================
   14. MAIN
   ============================================================================ */

(function boot() {
  const canvas = document.getElementById('bh-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });

  const seed = 1337;
  const scene = new Scene(seed);
  const quality = new AdaptiveQuality(scene);

  let dpr = Math.min(window.devicePixelRatio || 1, 2.5);

  function applyReducedMotion() {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    scene.setReducedMotion(mq.matches);
    if (mq.addEventListener) {
      mq.addEventListener('change', () => scene.setReducedMotion(mq.matches));
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scene.resize(w, h);
  }

  const ticker = new Ticker((dt, t) => {
    scene.update(dt, t);
    scene.draw(ctx);
    quality.record(dt);
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      ticker.stop();
    } else {
      ticker.start();
    }
  });

  applyReducedMotion();
  resize();
  ticker.start();
})();
