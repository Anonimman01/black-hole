'use strict';

/* ============================================================================
   GARGANTUA — a fully procedural black hole renderer.

   Nothing here is a photograph or texture. The event horizon, the photon
   ring, every one of the individual strands that make up the twisted
   accretion disk, the orbiting hotspots, the infalling sparks and the
   starfield behind it all are computed and drawn frame by frame on a
   single <canvas> element using plain 2D drawing primitives.

   v2 — FIXED + ENHANCED
   ----------------------
   Fix: the disk silhouette used to multiply the lensed "arch height" by
   the streak's orbital radius factor (f) a second time on top of the
   radius scaling already baked into x. That made outer streaks (f up to
   3+) balloon into a huge dome many horizon-radii tall, which is why the
   render looked like a solid white blob instead of a thin ring with a
   dark horizon inside it. Real gravitational lensing gets WEAKER with
   distance from the horizon, not stronger, so the arch height no longer
   scales with f at all.

   Enhancements on top of the fix:
     - More streaks, more starfield, more lensing arcs, more ring hotspots.
     - A relativistic-beaming style alpha boost on the approaching (blue)
       side of the disk and a dimming on the receding (red) side, so the
       asymmetry reads more strongly, like the reference image.
     - A soft highlight compression pass so bright overlapping streaks
       glow instead of clipping to a flat white blob.
     - A secondary, fainter outer photon ring for extra depth.
     - Slightly tamed bloom so the ring stays crisp instead of smearing.

   File map (concatenated in this order into blackhole.js):
     01_utils.js        - math helpers, seeded RNG, value noise, color mixing
     02_starfield.js     - background stars + occasional shooting stars
     03_disk.js          - the accretion disk: streak generation + rotation
     04_ring.js           - the photon ring and its orbiting hotspots
     05_horizon.js        - the event horizon shadow
     06_sparks.js          - infalling / ejected particle sparks
     07_bloom.js            - cheap multi-pass glow compositing
     08_scene.js              - camera drift, draw-order orchestration
     09_main.js                - canvas setup, resize, animation loop, boot
   ============================================================================ */

/* -------------------------------------------------------------------------
   Constants
   ------------------------------------------------------------------------- */
const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const DEG2RAD = Math.PI / 180;

/* -------------------------------------------------------------------------
   Seeded pseudo-random number generator (mulberry32).
   Using a seeded RNG rather than Math.random() means the disk's structure
   is reproducible frame to frame for values we only want to compute once
   (streak layout, star positions) while still looking organically random.
   ------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------
   Generic numeric helpers
   ------------------------------------------------------------------------- */
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
 *  to flat white when many additive layers stack on top of each other. */
function filmicSoftClip(v) {
  // Reinhard-style compression above 1.0, identity below it.
  if (v <= 1) return v;
  return 1 + (v - 1) / (1 + (v - 1));
}

/* -------------------------------------------------------------------------
   Value noise (1D and 2D), used for turbulence: the little organic
   waviness that keeps every streak of the disk from looking like a
   perfect mathematical ellipse. Cheap, seeded, deterministic.
   ------------------------------------------------------------------------- */
class ValueNoise {
  constructor(seed) {
    const rng = makeRng(seed);
    this.size = 256;
    this.perm = new Uint8Array(this.size * 2);
    this.grad = new Float32Array(this.size * 2);
    const base = new Uint8Array(this.size);
    for (let i = 0; i < this.size; i++) base[i] = i;
    // Fisher-Yates shuffle using the seeded RNG for reproducibility.
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

  /** 1D value noise, smooth and continuous, range roughly [-1, 1]. */
  noise1(x) {
    const xi = Math.floor(x) & (this.size - 1);
    const xf = x - Math.floor(x);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const a = this.grad[this.perm[xi]];
    const b = this.grad[this.perm[xi + 1]];
    return lerp(a, b, u);
  }

  /** 2D value noise, range roughly [-1, 1]. */
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

  /** Fractal Brownian motion: layered noise for richer, less regular turbulence. */
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
   Color helpers. Colors are stored/passed as [r,g,b] byte triples and
   composed into "rgba(...)" strings on demand.
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
    // Clamp so a dropped/backgrounded tab doesn't cause the disk to jump.
    dt = Math.min(dt, 1 / 15);
    this.onTick(dt, now / 1000);
    this._raf = requestAnimationFrame(this._frame);
  }
}
'use strict';

/* ============================================================================
   00. MASTER CONFIGURATION
   Every tunable constant for the whole piece lives here so the visual
   language stays consistent and easy to reason about in one place.
   ============================================================================ */
const CONFIG = {
  // --- Global scale -------------------------------------------------------
  horizonRadiusRatio: 0.140,   // event horizon radius as a fraction of min(w,h)
  sceneScaleRatio: 1.0,        // overall multiplier applied to the whole rig

  // --- Disk inclination & silhouette --------------------------------------
  inclination: -11 * DEG2RAD,  // fixed diagonal tilt of the whole disk
  diskArchRatio: 0.62,         // how tall the lensed arch over the top reaches
                                // (FIXED: no longer multiplied by streak radius f,
                                // so this alone now controls the ring/dome height)
  diskUnderRatio: 0.14,        // how deep the secondary sliver dips underneath
  diskBackStart: Math.PI * 1.28,   // angular window (radians) treated as "behind" the horizon
  diskBackEnd: Math.PI * 1.72,

  // --- Streak population ---------------------------------------------------
  streakCount: 130,
  streakSegments: 120,
  diskInnerF: 1.05,
  diskOuterF: 4.2,
  diskBaseAngularSpeed: 0.85,  // rad/s reference speed at f = 1
  diskBloomAlphaThreshold: 0.5,
  diskColorBucket: 6,           // segments per solid-color chunk along a streak

  // --- Relativistic beaming: approaching side brighter, receding side dimmer
  dopplerBeamMin: 0.55,   // alpha multiplier on the receding (red) side
  dopplerBeamMax: 1.35,   // alpha multiplier on the approaching (blue) side

  // --- Photon ring -----------------------------------------------------
  ringInnerRatio: 1.0,          // relative to horizon radius
  ringOuterRatio: 1.16,
  ringHotspotCount: 6,
  ringHotspotSpeed: 1.55,       // rad/s
  outerRingRatio: 1.55,         // faint secondary lensed ring, further out
  outerRingAlpha: 0.10,

  // --- Sparks ---------------------------------------------------------
  sparkMax: 60,
  sparkSpawnRate: 12,            // sparks per second, average

  // --- Starfield --------------------------------------------------------
  starCount: 380,

  // --- Bloom ------------------------------------------------------------
  bloomDownscale: 0.5,
  bloomPasses: [
    { blur: 4, alpha: 0.46 },
    { blur: 12, alpha: 0.30 },
    { blur: 28, alpha: 0.17 },
  ],

  // --- Camera drift -------------------------------------------------------
  cameraDriftAmount: 10,     // px
  cameraBreatheAmount: 0.018, // fractional scale wobble

  // --- Lensing arcs -----------------------------------------------------
  lensingArcCount: 18,

  // --- Film grain ---------------------------------------------------------
  grainTileSize: 128,
  grainAlpha: 0.035,
};
/* ============================================================================
   02. STARFIELD
   A field of individually-parametrized stars behind the black hole, each
   with its own twinkle rhythm, color temperature and parallax weight, plus
   a slow, rare shooting star that streaks across and fades.
   ============================================================================ */

class Star {
  constructor(rng, noise, index) {
    this.index = index;
    // Normalized position in [-1, 1] space, later mapped to the canvas.
    this.nx = rng() * 2 - 1;
    this.ny = rng() * 2 - 1;
    this.depth = rng();                    // 0 = far/dim, 1 = near/parallax-strong
    this.baseRadius = lerp(0.35, 1.7, Math.pow(rng(), 2));
    this.baseAlpha = lerp(0.25, 1.0, rng());
    this.twinkleSpeed = lerp(0.4, 2.2, rng());
    this.twinklePhase = rng() * TAU;
    this.twinkleDepth = lerp(0.15, 0.85, rng());
    // Slight color temperature variance: mostly white, some cool blue, rare warm amber.
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
    // Extremely slow drift, mostly imperceptible but keeps the field alive
    // over long viewing sessions.
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

class Starfield {
  constructor(count, seed) {
    this.rng = makeRng(seed);
    this.noise = new ValueNoise(seed + 1);
    this.stars = [];
    for (let i = 0; i < count; i++) {
      this.stars.push(new Star(this.rng, this.noise, i));
    }
    this.shootingStars = [];
    for (let i = 0; i < 2; i++) this.shootingStars.push(new ShootingStar());
    this.shootTimer = lerp(3, 7, this.rng());
    this.reducedMotion = false;
  }

  update(dt, t) {
    for (let i = 0; i < this.stars.length; i++) this.stars[i].update(this.reducedMotion ? 0 : dt, t);

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
    const cx = w / 2;
    const cy = h / 2;
    const spread = Math.max(w, h) * 0.72;

    ctx.save();
    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i];
      // Parallax: nearer (higher depth) stars shift a bit more with camera drift.
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

      // A soft plus-shaped glint on the brightest few stars.
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
   03. ACCRETION DISK
   This is the heart of the piece: the "twisted ring" itself.

   Physical idea being stylized here (loosely modelled on how gravitationally
   lensed accretion disks render in things like Interstellar's Gargantua):
   a thin disk of infalling matter orbits the black hole. Because of strong
   lensing near the horizon, light from the far side of the disk bends up
   and arcs OVER the sphere, light from the near side sweeps past it on the
   sides in a flat plane, and a second, fainter lensed image of the far side
   peeks out from underneath. All three of those are really the same disk,
   just light from it taking different bent paths to reach the viewer.

   Each streak orbits at its own radius, and — like real Keplerian orbits —
   streaks closer to the horizon complete a revolution much faster than
   streaks further out. Layered together and rendered with per-strand noise
   turbulence, this differential rotation is what makes the ring look
   "twisted" / braided rather than a rigid spinning disc.

   IMPORTANT FIX: the amount a streak's far-side image gets lifted into the
   arch is a lensing effect, and lensing strength falls off with distance
   from the horizon — it does NOT grow with orbital radius. So the arch
   height below is independent of `f`; only the flat, in-plane extent
   (`x`) grows with `f`. This keeps the whole structure a tight ring/dome
   near the horizon with long thin flat wings reaching outward, instead of
   a giant ballooning dome.
   ============================================================================ */

const DISK_COLOR_STOPS = {
  // Approaching (blue-shifted) edge: hot white -> ice blue.
  approaching: makeGradientSampler([
    { t: 0.0, color: hexToRgb('#eaf6ff') },
    { t: 0.45, color: hexToRgb('#bfe3ff') },
    { t: 1.0, color: hexToRgb('#4fa6ff') },
  ]),
  // Receding (red-shifted) edge: dim ember orange fading to dark red.
  receding: makeGradientSampler([
    { t: 0.0, color: hexToRgb('#ffd9b0') },
    { t: 0.45, color: hexToRgb('#ff8a4a') },
    { t: 1.0, color: hexToRgb('#7a2a12') },
  ]),
};

/**
 * A single strand of the disk: one continuous ring-shaped path at a given
 * orbital radius, distorted by the lensing silhouette function and by
 * per-strand turbulence noise, rotating over time.
 */
class DiskStreak {
  constructor(rng, noise, index, total) {
    this.index = index;
    this.noise = noise;

    // Orbital radius factor: 1.0 sits just outside the photon ring, larger
    // values are further out in the disk. Bias toward the inner disk so it
    // reads as dense near the horizon and wispy further out, like the ref.
    const spread = Math.pow(rng(), 1.7);
    this.f = lerp(CONFIG.diskInnerF, CONFIG.diskOuterF, spread);

    // Keplerian-ish differential rotation: inner streaks orbit much faster.
    this.angularSpeed = CONFIG.diskBaseAngularSpeed / Math.pow(this.f, 1.5);
    this.direction = 1; // all streaks co-rotate; direction of spin of the disk

    this.phase = rng() * TAU;
    this.turbSeed = rng() * 1000;
    this.turbFreq = lerp(1.4, 3.2, rng());
    this.turbAmp = lerp(0.05, 0.16, rng()) * (1 - clamp01((this.f - CONFIG.diskInnerF) / (CONFIG.diskOuterF - CONFIG.diskInnerF))) + 0.02;

    // Visual weight: inner streaks are brighter/thicker (more energy near
    // the horizon), outer streaks are thin and faint. Toned down slightly
    // vs. v1 so dozens of additive strokes near the horizon don't clip to
    // flat white as easily.
    const innerness = 1 - clamp01((this.f - CONFIG.diskInnerF) / (CONFIG.diskOuterF - CONFIG.diskInnerF));
    this.baseAlpha = lerp(0.08, 0.62, Math.pow(innerness, 1.5));
    this.baseWidth = lerp(0.5, 2.3, Math.pow(innerness, 1.2));

    // How strongly the lensed arch lifts THIS streak, independent of f.
    // Slight per-streak variance keeps the ring's top edge from looking
    // like a perfectly uniform band.
    this.archLift = lerp(0.9, 1.08, rng());

    // Slight per-streak vertical bias so the "under sliver" isn't a single
    // sharp line but a soft little bundle of arcs.
    this.underBiasSeed = rng() * 1000;

    this.points = new Array(CONFIG.streakSegments + 1);
  }

  /**
   * Computes the local-space (pre-inclination) silhouette of the disk at
   * angle phi: an arch over the top for the far/lensed image, a thin
   * pinched sliver underneath for the secondary lensed image, and a flat
   * sweep at the sides for the near, unlensed plane.
   *
   * `x` scales with the streak's orbital radius (f) — further-out matter
   * sweeps further out to the sides, as expected. `y` (the lensed arch
   * height) does NOT scale with f — lensing strength falls off with
   * distance from the horizon, so only `archLift`, a small fixed
   * per-streak variance, adjusts it.
   */
  _silhouette(phi) {
    const s = Math.sin(phi);
    const c = Math.cos(phi);
    const rx = this.f;
    let ry;
    if (s >= 0) {
      // Upper half: tall lensed arch over the sphere. Canvas Y grows
      // downward, so this must be NEGATIVE to appear above the horizon.
      ry = -CONFIG.diskArchRatio * Math.pow(s, 0.62) * this.archLift;
    } else {
      // Lower half: thin secondary image peeking from underneath, so this
      // must be POSITIVE to appear below the horizon.
      ry = CONFIG.diskUnderRatio * Math.pow(-s, 1.9) * this.archLift;
    }
    return { x: rx * c, y: ry };
  }

  /** Recomputes this streak's world-space point list for the current time. */
  update(t, reducedMotion) {
    const phase = reducedMotion ? this.phase : this.phase + t * this.angularSpeed * this.direction;
    const segs = CONFIG.streakSegments;
    const incCos = Math.cos(CONFIG.inclination);
    const incSin = Math.sin(CONFIG.inclination);

    for (let i = 0; i <= segs; i++) {
      const phi = (i / segs) * TAU + phase;

      // Turbulence: displaces the effective angle slightly and perturbs
      // radius, giving each streak an organic, non-perfectly-elliptical
      // wobble that also slowly evolves over time (the "hair in the wind"
      // quality of the reference art).
      const turbT = reducedMotion ? 0 : t * 0.06;
      const n = this.noise.fbm2(
        Math.cos(phi) * this.turbFreq + this.turbSeed,
        Math.sin(phi) * this.turbFreq + turbT,
        3
      );
      const phiJ = phi + n * this.turbAmp;

      const local = this._silhouette(phiJ);
      const radialJitter = 1 + n * 0.035;
      let lx = local.x * radialJitter;
      let ly = local.y * radialJitter;

      // Rotate into screen space by the fixed disk inclination so the
      // whole structure sweeps diagonally, matching the reference framing.
      const rx = lx * incCos - ly * incSin;
      const ry = lx * incSin + ly * incCos;

      const isBack = wrapAngle(phi) > CONFIG.diskBackStart && wrapAngle(phi) < CONFIG.diskBackEnd;

      this.points[i] = { x: rx, y: ry, phi: wrapAngle(phi), isBack };
    }
  }

  /**
   * Doppler-style shading: streaks (or parts of streaks) on the side of the
   * disk rotating toward the viewer render hot/blue, the receding side
   * renders dim/red. We approximate "toward viewer" using the x position
   * post-inclination (left side approaches, right side recedes here).
   * Returns both the color and a "side" 0..1 value (0 = fully receding,
   * 1 = fully approaching) so the caller can also apply beaming to alpha.
   */
  _colorFor(point) {
    const side = clamp01(0.5 - point.x / (this.f * 2.2));
    const sampler = side > 0.5 ? DISK_COLOR_STOPS.approaching : DISK_COLOR_STOPS.receding;
    const innerness = 1 - clamp01((this.f - CONFIG.diskInnerF) / (CONFIG.diskOuterF - CONFIG.diskInnerF));
    return { color: sampler(1 - innerness), side };
  }

  /**
   * Draws only the sub-paths of this streak matching the requested layer
   * ('back' = occluded by / peeking from behind the horizon, drawn before
   * it; 'front' = the arch + side sweep, drawn after / on top of it).
   *
   * Color is bucketed along the path (rather than a single flat color per
   * streak) so the approaching side genuinely reads blue-hot and the
   * receding side genuinely reads red-dim as you trace a single strand
   * all the way around — a cheap stand-in for a real per-pixel Doppler
   * shift without the cost of a stroke-per-point. A relativistic-beaming
   * alpha multiplier is layered on top: the approaching side gets brighter,
   * the receding side gets dimmer, which reads much closer to the
   * reference image's strong left/right asymmetry.
   */
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

  /** Returns the brightest handful of points for the bloom pass. */
  isBright() {
    return this.baseAlpha > CONFIG.diskBloomAlphaThreshold;
  }
}

class DiskSystem {
  constructor(seed) {
    this.rng = makeRng(seed);
    this.noise = new ValueNoise(seed + 7);
    this.streaks = [];
    for (let i = 0; i < CONFIG.streakCount; i++) {
      this.streaks.push(new DiskStreak(this.rng, this.noise, i, CONFIG.streakCount));
    }
    // Stable draw order: outer (fainter) streaks first, inner (brighter) last,
    // so bright inner strands read clearly on top of the wispy outer haze.
    this.streaks.sort((a, b) => b.f - a.f);
  }

  update(dt, t, reducedMotion) {
    for (let i = 0; i < this.streaks.length; i++) this.streaks[i].update(t, reducedMotion);
  }

  drawLayer(ctx, cx, cy, scale, layer) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.streaks.length; i++) {
      this.streaks[i].draw(ctx, cx, cy, scale, layer);
    }
    ctx.restore();
  }

  drawBright(ctx, cx, cy, scale, layer) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.streaks.length; i++) {
      const s = this.streaks[i];
      if (s.isBright()) s.draw(ctx, cx, cy, scale, layer);
    }
    ctx.restore();
  }
}
/* ============================================================================
   04. PHOTON RING
   The tight, near-perfectly-circular band of light hugging the event
   horizon — this is light that grazed the black hole closely enough to
   loop around it before escaping toward us. It's the brightest, sharpest
   feature in the whole image, so it gets its own layer: a solid glowing
   band plus a handful of brighter "hotspots" that orbit around it much
   faster than the disk itself, like clumps of superheated plasma catching
   the light as they whip past. A second, much fainter ring further out
   adds a subtle secondary lensing echo, like the higher-order photon
   rings you get in real simulated black hole images.
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

  /** A slightly squashed ellipse gives the ring a hint of the disk's tilt. */
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

  /** Faint secondary lensed ring, further out — a subtle echo of the horizon. */
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
      // rotate by ring rotation
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
    const squash = 0.94; // ring is nearly circular but carries a whisper of the disk tilt
    this._drawOuterRing(ctx, cx, cy, horizonRadius, squash, CONFIG.inclination);
    this._drawBandTilted(ctx, cx, cy, rMid, squash, CONFIG.inclination + this.baseRotation * 0.05);
    this._drawHotspots(ctx, cx, cy, rMid, squash, CONFIG.inclination);
  }

  /** Bright-only pass for the bloom buffer: just the hot core + hotspots. */
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
   05. EVENT HORIZON
   The black shadow itself: not just a flat black circle, but a soft
   gradient falloff into the surrounding dark (so it reads as a void with
   depth rather than a sticker), plus a very faint, slow breathing pulse
   to keep the center of the composition from feeling static.
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

    // Ambient dark halo bleeding outward, so the shadow doesn't have a hard
    // edge against the disk glow behind it.
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

    // The shadow disc itself, with an extremely subtle inner gradient
    // (never fully flat) so it still reads as three-dimensional.
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
   06. SPARKS
   Small, short-lived particles ejected tangentially from the inner disk —
   the sort of turbulent flecks of superheated matter that get flung loose
   from an accretion flow. Pooled for performance (fixed-size array, no
   per-frame allocation once warmed up).
   ============================================================================ */

class Spark {
  constructor() {
    this.active = false;
  }

  spawn(rng, innerF, outerF) {
    this.active = true;
    this.f = lerp(innerF, innerF + (outerF - innerF) * 0.4, rng());
    this.angle = rng() * TAU;
    this.angularSpeed = (CONFIG.diskBaseAngularSpeed / Math.pow(this.f, 1.5)) * lerp(0.9, 1.3, rng());
    this.driftOut = lerp(0.15, 0.5, rng());   // outward drift speed (f-units/sec)
    this.life = 0;
    this.maxLife = lerp(1.4, 3.2, rng());
    this.size = lerp(0.8, 2.0, rng());
    this.hue = rng(); // 0 = hot white/blue, 1 = ember orange
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
    this.f += this.driftOut * dt * 0.35;
  }

  /**
   * Local-space (pre-inclination) position, reusing the disk's silhouette
   * shape. FIXED: the arch height no longer scales with `f` (see the
   * matching fix and explanation in DiskStreak._silhouette above) so
   * sparks stay glued to the same tight ring/disk shape as the streaks
   * instead of flying off into a huge dome as they drift outward.
   */
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
      if (idle) idle.spawn(this.rng, CONFIG.diskInnerF, CONFIG.diskOuterF);
    }
    for (let i = 0; i < this.pool.length; i++) this.pool[i].update(dt);
  }

  draw(ctx, cx, cy, scale, layer) {
    for (let i = 0; i < this.pool.length; i++) this.pool[i].draw(ctx, cx, cy, scale, layer);
  }
}
/* ============================================================================
   07. BLOOM
   Cheap multi-pass glow: the brightest elements (photon ring, hotspots,
   the inner disk streaks) are redrawn into a small offscreen canvas, then
   composited back onto the main canvas several times with increasing blur
   radius and decreasing opacity using an additive blend. This is what
   gives the ring its soft luminous halo instead of looking like a flat
   vector line. Pass alphas were trimmed down slightly from v1 so the
   glow enhances the ring rather than smearing it into a blob.
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

  /**
   * `paintBright` is a callback that draws only the bright elements into
   * the given context, at the given (already downscaled) center/scale.
   */
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
   08. CAMERA DRIFT
   A slow, noise-driven micro pan and breathing zoom applied to the whole
   composition — no mouse or scroll input, purely automatic — so the frame
   never feels perfectly locked-down even though nothing is "happening"
   from a user's point of view. Kept extremely subtle by design.
   ============================================================================ */

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
   11. LENSING ARCS
   A small extra detail: background light passing close to the black hole
   doesn't just vanish or stay a point — it gets smeared tangentially by
   the curved spacetime, same principle as the disk's own arch, just
   applied to a handful of background points instead of disk matter. We
   fake this cheaply with a fixed set of thin, faint tangential arcs
   sitting just outside the photon ring, brightening and dimming slowly
   and independently so they read as drifting gravitational glints rather
   than a static decal.
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
   12. FILM GRAIN
   A very light, animated noise texture over the whole frame. Pure flat
   gradients on a canvas tend to band and look plasticky at large sizes;
   a faint dithering layer breaks that up and reads as cinematic grain
   rather than a compression artifact. Rebuilt as a small tile and
   repeated, not computed per-pixel every frame, to stay cheap.
   ============================================================================ */

class FilmGrain {
  constructor(seed, tileSize) {
    this.tileSize = tileSize;
    this.tiles = [];
    const rng = makeRng(seed);
    // Pre-render a handful of grain tiles and cycle through them over time,
    // which reads as flickering grain without regenerating noise per frame.
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
   13. ADAPTIVE QUALITY
   Watches the actual rendering frame time for the first several seconds
   and, if the scene is struggling to hold a reasonable frame rate (an
   older laptop, an integrated GPU, a phone), progressively trims the most
   expensive effects in order of least visual impact first: film grain,
   then bloom pass count, then lensing arcs, then finally spark count and
   streak segment resolution. Never touches anything once it has settled,
   so there's no visible stepping mid-session beyond the first few seconds.
   ============================================================================ */

class AdaptiveQuality {
  constructor(scene) {
    this.scene = scene;
    this.samples = [];
    this.sampleWindow = 90; // ~1.5s at 60fps
    this.settled = false;
    this.tier = 3; // 3 = full quality, 0 = minimal
    this.evalCooldown = 0;
  }

  /** Call once per frame with the delta time in seconds. */
  record(dt) {
    if (this.settled) return;

    this.samples.push(dt);
    if (this.samples.length < this.sampleWindow) return;

    const avg = this.samples.reduce((s, v) => s + v, 0) / this.samples.length;
    const fps = 1 / Math.max(avg, 0.0001);
    this.samples.length = 0;

    if (fps >= 50) {
      // Comfortably smooth: stop watching, lock in current tier.
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
        // Drop film grain first: cheapest visual sacrifice, priciest per-pixel op.
        CONFIG.grainAlpha = 0;
        break;
      case 1:
        // Reduce bloom to two passes and shrink the lensing arc count.
        CONFIG.bloomPasses = [
          { blur: 5, alpha: 0.42 },
          { blur: 16, alpha: 0.24 },
        ];
        CONFIG.lensingArcCount = 8;
        this.scene.lensing.arcs.length = Math.min(this.scene.lensing.arcs.length, 8);
        break;
      case 0:
        // Last resort: fewer, simpler streaks and fewer sparks.
        this._downsampleStreaks(70);
        CONFIG.sparkMax = 24;
        this.scene.sparks.pool.length = Math.min(this.scene.sparks.pool.length, 24);
        break;
    }
  }

  _downsampleStreaks(targetCount) {
    const disk = this.scene.disk;
    if (disk.streaks.length <= targetCount) return;
    // Keep the brightest (innermost) streaks, since they carry the most
    // visible structure of the ring.
    disk.streaks.sort((a, b) => a.f - b.f);
    disk.streaks.length = targetCount;
    disk.streaks.sort((a, b) => b.f - a.f);
  }
}
/* ============================================================================
   09. SCENE
   Owns every subsystem and is responsible for exactly one thing done
   right: draw order. Depth in this piece is faked entirely through layering
   (paint the far things first, the near things last) since we're in plain
   2D canvas, so getting this sequence right is what sells the illusion of
   the disk actually wrapping around a sphere:

     1. starfield (background)
     2. disk streaks + sparks that are BEHIND the horizon (the peeking sliver)
     3. the event horizon shadow itself (occludes everything under it)
     4. disk streaks + sparks that are IN FRONT of the horizon (the arch + sides)
     5. the photon ring and its hotspots (always frontmost, brightest)
     6. bloom (reads back the bright layers and adds glow on top of everything)
     7. highlight compression (soft-clip overlapping bright layers)
     8. vignette
   ============================================================================ */

class Scene {
  constructor(seed) {
    this.seed = seed;
    this.starfield = new Starfield(CONFIG.starCount, seed + 1);
    this.disk = new DiskSystem(seed + 2);
    this.ring = new PhotonRing(makeRng(seed + 3));
    this.horizon = new EventHorizon();
    this.sparks = new SparkSystem(seed + 4);
    this.camera = new CameraDrift(seed + 5);
    this.bloom = new Bloom();
    this.lensing = new LensingArcs(makeRng(seed + 6), CONFIG.lensingArcCount);
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
    this.cy = h * 0.46; // slightly above true center, matching the reference composition
    this.horizonRadius = Math.min(w, h) * CONFIG.horizonRadiusRatio;
    // The disk streak points are generated in "f" units (multiples of the
    // horizon radius), so the world-to-screen scale is just the horizon
    // radius itself.
    this.diskScale = this.horizonRadius;
    this.bloom.resize(w, h);
  }

  setReducedMotion(v) {
    this.reducedMotion = v;
    this.starfield.reducedMotion = v;
  }

  update(dt, t) {
    this.starfield.update(dt, t);
    this.disk.update(dt, t, this.reducedMotion);
    this.ring.update(dt, t, this.reducedMotion);
    this.horizon.update(dt, t, this.reducedMotion);
    this.sparks.update(dt, this.reducedMotion);
    this.camera.update(t, this.reducedMotion);
    this.lensing.update(dt, t, this.reducedMotion);
  }

  _drawFrontBack(ctx, cx, cy, scale) {
    this.disk.drawLayer(ctx, cx, cy, scale, 'back');
    this.sparks.draw(ctx, cx, cy, scale, 'back');
  }

  _drawFrontFront(ctx, cx, cy, scale) {
    this.disk.drawLayer(ctx, cx, cy, scale, 'front');
    this.sparks.draw(ctx, cx, cy, scale, 'front');
  }

  draw(ctx) {
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);

    // Deep space backdrop gradient: not pure black, a whisper of indigo
    // toward the center so the scene has ambient depth even off to the edges.
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

    this._drawFrontBack(ctx, cx, cy, scale);
    this.horizon.draw(ctx, cx, cy, this.horizonRadius * camScale);
    this._drawFrontFront(ctx, cx, cy, scale);
    this.lensing.draw(ctx, cx, cy, this.horizonRadius * camScale);
    this.ring.draw(ctx, cx, cy, this.horizonRadius * camScale);

    // Bloom: redraw only the brightest bits at reduced resolution, blur,
    // and add back on top.
    this.bloom.render(ctx, w, h, (bctx) => {
      this.disk.drawBright(bctx, cx, cy, scale, 'front');
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
/* ============================================================================
   10. MAIN
   Canvas + DPR setup, resize handling, visibility pausing, reduced-motion
   detection, and the top-level animation loop. This is the only file that
   touches the DOM directly.
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
