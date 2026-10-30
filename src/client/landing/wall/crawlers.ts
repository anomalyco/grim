// Crawlers: things from behind the wall. Big clawed hands slap onto the hole's rim first, then a pale, wrong face
// pulls up out of the dark, then the whole thing hauls itself out, drops onto the page and crawls off it in a random
// direction on long jointed arms (two bone IK, each hand planted until the body has moved on, then lifted and swung
// ahead, in two alternating sets), lurching, twitching. Once it's off the window it's gone. Speed, size and gait vary
// a little per crawler. When many are out they're drawn more simply. (When they come, and how fast the stream gets:
// TIMELINE in timeline.ts.) A 2D canvas over the content (under the pencils); it never takes clicks.
import { clamp, gauss, lerp, rand, smooth, type View } from "./core.ts";
import type { Fracture } from "./cracks.ts";

export const CRAWLER = {
  /** at most this many at once (no more come out until some have left) */
  max: 25,
  maxLow: 8,
  /** above this many, the cheap drawing: no soft shadows, ridges, highlights or teeth, one-joint fingers */
  simpleAbove: 10,
  /** limbs: 6 (two big front arms and four smaller), or 4 on phones */
  limbs: 6,
  limbsLow: 4,
  /** the head's size against the body */
  head: 1.45,
  /** overall size (1: a torso about 80 px long) */
  size: [0.9, 1.25] as const,
  /** speed (px/s) at the peak of a lurch, and lurches per second (each crawler: somewhere in the range) */
  speed: [110, 190] as const,
  lurch: [0.5, 1.1] as const,
  /** how far its course drifts (rad/s, one sd): mostly straight off the page */
  drift: 0.5,
  /** a hand steps when it's this far (px, at size 1) from where it should be, taking this long (s): each crawler's
   *  gait is these times a factor in `gait` */
  stepDist: 46,
  stepTime: 0.2,
  gait: [0.75, 1.3] as const,
  /** coming out: hands on the rim (s), the face rising (s), hauling out (s); each crawler: times a factor in `pace` */
  grip: 2.4,
  rise: 3.2,
  haul: 2.6,
  pace: [0.7, 1.2] as const,
  /** colours: body, limbs, face, claws */
  body: "#191716",
  limb: "#201d1c",
  face: "#e7e1d5",
  claw: "#ece5d6",
  /** shadow under them on the page (alpha) */
  shadow: 0.16,
};

interface Limb {
  /** shoulder, in the body's frame (px at size 1: x forward, y right) */
  sx: number;
  sy: number;
  /** where its hand rests, in the body's frame */
  rx: number;
  ry: number;
  upper: number;
  lower: number;
  hand: number;
  side: number;
  group: number;
  x: number;
  y: number;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  /** 1: planted; below 1: mid-step */
  t: number;
  /** finger spread jitter */
  splay: number[];
  /** the wrist's angle (set when the arm is drawn) */
  wa: number;
}

interface Eye {
  x: number;
  y: number;
  r: number;
}

type Stage = "grip" | "rise" | "haul" | "crawl";

class Crawler {
  x: number;
  y: number;
  heading: number;
  size: number;
  limbs: Limb[] = [];
  eyes: Eye[] = [];
  stage: Stage = "grip";
  t = 0;
  speed: number;
  phase = Math.random() * 6;
  lurch: number;
  gait: number;
  pace: number;
  look = 0;
  twitch = 0;
  twitchV = 0;
  /** the way out of the hole (unit vector), and where it starts and ends */
  ox: number;
  oy: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  /** how far out of the wall (0: deep in the dark, small and clipped; 1: out on the page) */
  out = 0;
  mouth: number;
  teeth: number;

  constructor(hx: number, hy: number, hr: number, low: boolean, v: View) {
    this.size = rand(...CRAWLER.size) * (low ? 0.8 : 1);
    // out of any side of the hole, then off that way (a random direction)
    const a = Math.random() * Math.PI * 2;
    this.ox = Math.cos(a);
    this.oy = Math.sin(a);
    this.heading = a;
    this.startX = hx + this.ox * hr * 0.2;
    this.startY = hy + this.oy * hr * 0.2;
    this.endX = hx + this.ox * (hr + 40 * this.size);
    this.endY = hy + this.oy * (hr + 40 * this.size);
    this.x = this.startX;
    this.y = this.startY;
    this.speed = rand(...CRAWLER.speed);
    this.lurch = rand(...CRAWLER.lurch);
    this.gait = rand(...CRAWLER.gait);
    this.pace = rand(...CRAWLER.pace);
    this.mouth = rand(0.6, 1.2);
    this.teeth = Math.round(rand(7, 12));
    const n = low ? CRAWLER.limbsLow : CRAWLER.limbs;
    const rows = n / 2;
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 ? 1 : -1;
      const front = row === 0;
      const sx = 22 - row * (44 / Math.max(1, rows - 1));
      const upper = front ? 58 : 44;
      const lower = front ? 62 : 46;
      this.limbs.push({
        sx, sy: side * 12, rx: sx + (front ? 46 : 10 - row * 6), ry: side * (front ? 58 : 66),
        upper, lower, hand: front ? 1.5 : 0.8, side,
        group: (row + (side > 0 ? 1 : 0)) % 2,
        x: 0, y: 0, fx: 0, fy: 0, tx: 0, ty: 0, t: 1,
        splay: [0, 1, 2, 3].map(() => gauss() * 0.12),
        wa: 0,
      });
    }
    // three to five eyes, never where you'd expect
    const ne = Math.round(rand(3, 5));
    for (let i = 0; i < ne; i++) this.eyes.push({ x: rand(-7, 5), y: rand(-11, 11), r: rand(1.6, 4.2) });
    this.eyes[0] = { x: 2, y: rand(-3, 3), r: rand(4.5, 6) };
    // hands start on the rim, either side of the way out
    for (const l of this.limbs) {
      const along = (l.side * (l.hand > 1 ? 34 : 70) + gauss() * 8) * this.size;
      const back = l.hand > 1 ? 0 : -hr * 0.5;
      l.x = l.tx = hx + this.ox * (hr * 0.95 + back) - this.oy * along;
      l.y = l.ty = hy + this.oy * (hr * 0.95 + back) + this.ox * along;
    }
  }

  /** a point in the body's frame, on the page */
  world(fx: number, fy: number, s = this.size): [number, number] {
    const c = Math.cos(this.heading);
    const n = Math.sin(this.heading);
    return [this.x + (fx * c - fy * n) * s, this.y + (fx * n + fy * c) * s];
  }

  update(dt: number, v: View, low: boolean) {
    this.t += dt;
    const grip = CRAWLER.grip * this.pace;
    const rise = CRAWLER.rise * this.pace;
    const haul = CRAWLER.haul * this.pace;
    if (this.stage === "grip") {
      if (this.t > grip) this.next("rise");
    } else if (this.stage === "rise") {
      const k = smooth(this.t / rise);
      this.out = k * 0.55;
      this.x = lerp(this.startX, lerp(this.startX, this.endX, 0.45), k);
      this.y = lerp(this.startY, lerp(this.startY, this.endY, 0.45), k);
      if (this.t > rise) this.next("haul");
    } else if (this.stage === "haul") {
      const k = smooth(this.t / haul);
      this.out = 0.55 + k * 0.45;
      this.x = lerp(lerp(this.startX, this.endX, 0.45), this.endX, k);
      this.y = lerp(lerp(this.startY, this.endY, 0.45), this.endY, k);
      if (this.t > haul) this.next("crawl");
    } else this.crawl(dt);
    // the head: snapping round, then holding still
    this.twitchV += (-this.twitch * 60 - this.twitchV * 9) * dt;
    this.twitch += this.twitchV * dt;
    if (Math.random() < dt * 0.6) this.twitchV += gauss() * 9;
    // coming out, it looks at you
    const want = Math.atan2(v.py - this.y, v.px - this.x) - this.heading;
    const lookAt = this.stage !== "crawl" ? clamp(wrap(want), -1.1, 1.1) : 0;
    this.look += (lookAt - this.look) * Math.min(1, dt * 5);
    this.stepLimbs(dt, low);
  }

  private next(s: Stage) {
    this.stage = s;
    this.t = 0;
  }

  /** off the page: straight-ish away, in lurches */
  private crawl(dt: number) {
    this.heading += gauss() * CRAWLER.drift * Math.sqrt(dt);
    this.phase += dt * this.lurch * Math.PI * 2;
    const surge = Math.max(0, Math.sin(this.phase)) ** 1.5;
    const sp = this.speed * (0.35 + 0.65 * surge);
    this.x += Math.cos(this.heading) * sp * dt;
    this.y += Math.sin(this.heading) * sp * dt;
  }

  /** out on the page and wholly outside the window */
  gone(v: View) {
    if (this.stage !== "crawl") return false;
    const m = 190 * this.size;
    return this.x < v.sx - m || this.x > v.sx + v.vw + m || this.y < v.sy - m || this.y > v.sy + v.vh + m;
  }

  private stepLimbs(dt: number, low: boolean) {
    const crawling = this.stage === "crawl";
    const stepping = [0, 0];
    for (const l of this.limbs) if (l.t < 1) stepping[l.group]!++;
    for (const l of this.limbs) {
      if (l.t < 1) {
        l.t = Math.min(1, l.t + dt / (CRAWLER.stepTime * this.gait));
        const e = smooth(l.t);
        l.x = lerp(l.fx, l.tx, e);
        l.y = lerp(l.fy, l.ty, e);
        continue;
      }
      // coming out, the front hands hold the rim; the others reach for it once the body is near
      if (!crawling && (l.hand > 1 || this.out < 0.5)) continue;
      const [ix, iy] = this.world(l.rx + 22, l.ry);
      const far = Math.hypot(ix - l.x, iy - l.y) > CRAWLER.stepDist * this.size * this.gait;
      const other = stepping[1 - l.group]! > 0;
      const reach = l.upper + l.lower;
      const [sx, sy] = this.world(l.sx, l.sy);
      const over = Math.hypot(l.x - sx, l.y - sy) > reach * this.size * 0.98;
      if ((far && !other) || over) {
        l.fx = l.x;
        l.fy = l.y;
        l.tx = ix + gauss() * 6;
        l.ty = iy + gauss() * 6;
        l.t = 0;
        stepping[l.group]!++;
        if (low) l.t = 0.3;
      }
    }
  }

}

function wrap(a: number) {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

export class Crawlers {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private list: Crawler[] = [];
  readonly max: number;
  private drawn = false;

  constructor(
    private fracture: Fracture,
    private low: boolean,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "wall-crawlers";
    this.canvas.setAttribute("aria-hidden", "true");
    this.ctx = this.canvas.getContext("2d")!;
    this.max = low ? CRAWLER.maxLow : CRAWLER.max;
  }

  get count() {
    return this.list.length;
  }

  get full() {
    return this.list.length >= this.max;
  }

  /** One comes out of the hole at (hx, hy), radius hr. */
  spawn(hx: number, hy: number, hr: number, v: View) {
    if (this.full || hr <= 0) return false;
    this.list.push(new Crawler(hx, hy, hr, this.low, v));
    return true;
  }

  clear() {
    this.list = [];
  }

  update(dt: number, v: View) {
    for (const c of this.list) c.update(dt, v, this.low);
    this.list = this.list.filter((c) => !c.gone(v));
  }

  get busy() {
    return this.list.length > 0;
  }

  draw(v: View) {
    const cv = this.canvas;
    const w = Math.round(v.vw * v.dpr);
    const h = Math.round(v.vh * v.dpr);
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
      cv.style.width = v.vw + "px";
      cv.style.height = v.vh + "px";
    }
    const g = this.ctx;
    if (!this.list.length && !this.drawn) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    this.drawn = this.list.length > 0;
    if (!this.drawn) return;
    g.setTransform(v.dpr, 0, 0, v.dpr, (-v.sx + v.shakeX) * v.dpr, (-v.sy + v.shakeY) * v.dpr);
    this.simple = this.list.length > CRAWLER.simpleAbove;
    this.hole = null;
    // the ones still coming out behind, the ones on the page in front
    for (const c of this.list) if (c.stage !== "crawl") this.drawOne(g, c, v);
    for (const c of this.list) if (c.stage === "crawl") this.drawOne(g, c, v);
  }

  /** the cheap drawing, this frame */
  private simple = false;
  private hole: Path2D | null = null;

  /** the hole as a clip path (built once a frame) */
  private clipHole(g: CanvasRenderingContext2D) {
    if (!this.hole) {
      const p = new Path2D();
      for (const c of this.fracture.removed) {
        p.moveTo(c.poly[0]!, c.poly[1]!);
        for (let i = 2; i < c.poly.length; i += 2) p.lineTo(c.poly[i]!, c.poly[i + 1]!);
        p.closePath();
      }
      this.hole = p;
    }
    g.clip(this.hole);
  }

  private drawOne(g: CanvasRenderingContext2D, c: Crawler, v: View) {
    const s = c.size * (0.55 + 0.45 * c.out);
    // the body: in the dark (clipped to the hole) until it's halfway out
    const inside = c.out < 0.5;
    // the hands come in over the rim
    const handIn = c.stage === "grip" ? smooth(c.t / (CRAWLER.grip * c.pace * 0.4)) : 1;
    if (!inside) this.shadow(g, c, s);
    // limbs: behind the body
    g.save();
    if (inside) this.clipHole(g);
    for (const l of c.limbs) {
      const [sx, sy] = c.world(l.sx, l.sy, s);
      this.arm(g, l, sx, sy, s);
    }
    this.torso(g, c, s, inside);
    g.restore();
    // hands are in front of the rim even while the body is still inside
    for (const l of c.limbs) {
      if (inside && l.hand <= 1 && c.out < 0.3) continue;
      this.handAt(g, c, l, s, handIn);
    }
    if (c.out > 0.08) {
      g.save();
      if (inside) this.clipHole(g);
      this.head(g, c, s, v, inside);
      g.restore();
    }
  }

  private shadow(g: CanvasRenderingContext2D, c: Crawler, s: number) {
    const [x, y] = c.world(0, 0, s);
    const r = 70 * s;
    if (this.simple) {
      g.fillStyle = `rgba(0,0,0,${CRAWLER.shadow * 0.5})`;
      g.beginPath();
      g.ellipse(x + 8, y + 14, r * 0.6, r * 0.45, c.heading, 0, Math.PI * 2);
      g.fill();
      return;
    }
    const grad = g.createRadialGradient(x + 8, y + 14, 0, x + 8, y + 14, r);
    grad.addColorStop(0, `rgba(0,0,0,${CRAWLER.shadow})`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(x + 8, y + 14, r, r * 0.8, c.heading, 0, Math.PI * 2);
    g.fill();
  }

  private arm(g: CanvasRenderingContext2D, l: Limb, sx: number, sy: number, s: number) {
    const lift = l.t < 1 ? Math.sin(l.t * Math.PI) : 0;
    let tx = l.x;
    let ty = l.y;
    const a = l.upper * s;
    const b = l.lower * s;
    let dx = tx - sx;
    let dy = ty - sy;
    let d = Math.hypot(dx, dy) || 1;
    if (d > (a + b) * 0.995) {
      const k = ((a + b) * 0.995) / d;
      tx = sx + dx * k;
      ty = sy + dy * k;
      dx = tx - sx;
      dy = ty - sy;
      d = (a + b) * 0.995;
    }
    const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    // elbows bend up and away from the body: high, spidery
    const ang = Math.atan2(dy, dx) + Math.acos(cosA) * -l.side;
    const ex = sx + Math.cos(ang) * a;
    const ey = sy + Math.sin(ang) * a;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = CRAWLER.limb;
    g.lineWidth = (l.hand > 1 ? 11 : 7) * s;
    g.beginPath();
    g.moveTo(sx, sy);
    g.lineTo(ex, ey);
    g.stroke();
    g.lineWidth = (l.hand > 1 ? 7 : 4.5) * s * (1 + lift * 0.15);
    g.beginPath();
    g.moveTo(ex, ey);
    g.lineTo(tx, ty);
    g.stroke();
    // a bony spur on the elbow
    const ox = Math.cos(ang) * 1 - Math.sin(ang) * -l.side;
    const oy = Math.sin(ang) * 1 + Math.cos(ang) * -l.side;
    g.fillStyle = CRAWLER.limb;
    g.beginPath();
    g.moveTo(ex - Math.cos(ang) * 6 * s, ey - Math.sin(ang) * 6 * s);
    g.lineTo(ex + ox * 11 * s, ey + oy * 11 * s);
    g.lineTo(ex + Math.cos(ang) * 6 * s, ey + Math.sin(ang) * 6 * s);
    g.fill();
    l.wa = Math.atan2(ty - ey, tx - ex);
    if (this.simple) return;
    // a thin pale highlight along the forearm
    g.strokeStyle = "rgba(255,255,255,0.07)";
    g.lineWidth = 1.2 * s;
    g.beginPath();
    g.moveTo(ex, ey - 1.5 * s);
    g.lineTo(tx, ty - 1.5 * s);
    g.stroke();
    l.wa = Math.atan2(ty - ey, tx - ex);
  }

  private handAt(g: CanvasRenderingContext2D, c: Crawler, l: Limb, s: number, alpha: number) {
    const wa = l.wa;
    const lift = l.t < 1 ? Math.sin(l.t * Math.PI) : 0;
    const k = l.hand * s * (1 + lift * 0.18);
    g.save();
    g.globalAlpha = alpha;
    g.translate(l.x, l.y);
    g.rotate(wa);
    if (lift > 0 && !this.simple) {
      g.fillStyle = "rgba(0,0,0,0.12)";
      g.beginPath();
      g.ellipse(10 * lift, 14 * lift, 16 * k, 12 * k, 0, 0, Math.PI * 2);
      g.fill();
    }
    // palm
    g.fillStyle = CRAWLER.limb;
    g.beginPath();
    g.ellipse(4 * k, 0, 14 * k, 11 * k, 0, 0, Math.PI * 2);
    g.fill();
    // four long fingers, two joints each, curled when gripping, ending in hooked claws
    const curl = l.t < 1 ? 0.15 : 0.45;
    for (let i = 0; i < 4; i++) {
      const spread = (i - 1.5) * 0.42 + l.splay[i]!;
      let x = 12 * k;
      let y = (i - 1.5) * 6 * k;
      let a = spread;
      const joints = this.simple ? 1 : 2;
      const seg = ((i === 0 || i === 3 ? 13 : 17) * k * 2) / joints;
      g.strokeStyle = CRAWLER.limb;
      g.lineCap = "round";
      for (let j = 0; j < joints; j++) {
        const nx = x + Math.cos(a) * seg;
        const ny = y + Math.sin(a) * seg;
        g.lineWidth = (4.2 - j * 1.2) * k;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(nx, ny);
        g.stroke();
        x = nx;
        y = ny;
        a += curl * (i < 2 ? -0.3 : 0.3) + curl * 0.4;
      }
      // the claw: a curved, tapering hook
      const cl = 14 * k;
      const bx = x + Math.cos(a) * cl;
      const by = y + Math.sin(a) * cl;
      const hx = x + Math.cos(a + 0.9) * cl * 0.5;
      const hy = y + Math.sin(a + 0.9) * cl * 0.5;
      const w = 1.8 * k;
      g.fillStyle = CRAWLER.claw;
      g.strokeStyle = "rgba(20,18,17,0.85)";
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(x - Math.sin(a) * w, y + Math.cos(a) * w);
      g.quadraticCurveTo(hx, hy, bx, by);
      g.quadraticCurveTo(hx - Math.cos(a) * 3 * k, hy - Math.sin(a) * 3 * k, x + Math.sin(a) * w, y - Math.cos(a) * w);
      g.closePath();
      g.fill();
      g.stroke();
    }
    g.restore();
  }

  private torso(g: CanvasRenderingContext2D, c: Crawler, s: number, inside: boolean) {
    g.save();
    const [x, y] = c.world(0, 0, s);
    g.translate(x, y);
    g.rotate(c.heading);
    // breathing
    const br = 1 + Math.sin(c.t * 2.3) * 0.03;
    g.fillStyle = inside ? "#0c0b0b" : CRAWLER.body;
    g.beginPath();
    g.moveTo(34 * s, 0);
    g.bezierCurveTo(30 * s, -22 * s * br, -10 * s, -24 * s * br, -38 * s, -10 * s);
    g.bezierCurveTo(-52 * s, -4 * s, -52 * s, 4 * s, -38 * s, 10 * s);
    g.bezierCurveTo(-10 * s, 24 * s * br, 30 * s, 22 * s * br, 34 * s, 0);
    g.fill();
    // a ridge of vertebrae down its back
    g.fillStyle = "rgba(255,255,255,0.08)";
    for (let i = 0; i < (this.simple ? 0 : 7); i++) {
      const vx = (24 - i * 9) * s;
      g.beginPath();
      g.ellipse(vx, Math.sin(c.t * 3 + i) * 0.6 * s, 2.6 * s, 4.2 * s * (1 - i * 0.07), 0, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  private head(g: CanvasRenderingContext2D, c: Crawler, s: number, v: View, inside: boolean) {
    const [x, y] = c.world(42, 0, s);
    g.save();
    g.translate(x, y);
    g.rotate(c.heading + c.look + c.twitch * 0.35);
    // a long neck joint
    g.fillStyle = CRAWLER.body;
    g.beginPath();
    g.ellipse(-8 * s, 0, 12 * s, 8 * s, 0, 0, Math.PI * 2);
    g.fill();
    // the face: a pale, too-long mask, seen from above, tilted
    g.rotate(Math.PI / 2 + c.twitch * 0.2);
    g.scale(CRAWLER.head, CRAWLER.head);
    g.fillStyle = inside ? "#bdb7ab" : CRAWLER.face;
    g.strokeStyle = "rgba(25,22,20,0.8)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, -12 * s);
    g.bezierCurveTo(14 * s, -12 * s, 15 * s, 8 * s, 6 * s, 22 * s);
    g.bezierCurveTo(3 * s, 27 * s, -3 * s, 27 * s, -6 * s, 22 * s);
    g.bezierCurveTo(-15 * s, 8 * s, -14 * s, -12 * s, 0, -12 * s);
    g.fill();
    g.stroke();
    // shading down one side
    g.fillStyle = "rgba(80,70,60,0.18)";
    g.beginPath();
    g.moveTo(2 * s, -12 * s);
    g.bezierCurveTo(14 * s, -12 * s, 15 * s, 8 * s, 6 * s, 22 * s);
    g.bezierCurveTo(9 * s, 6 * s, 9 * s, -6 * s, 2 * s, -12 * s);
    g.fill();
    // eyes: black, mismatched, a pinprick in each that follows you
    const look = Math.atan2(v.py - y, v.px - x) - (c.heading + c.look + Math.PI / 2);
    for (const e of c.eyes) {
      const ex = e.y * s;
      const ey = e.x * s - 2 * s;
      g.fillStyle = "#050404";
      g.beginPath();
      g.ellipse(ex, ey, e.r * s, e.r * s * 0.8, 0.3, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "rgba(255,250,235,0.9)";
      g.beginPath();
      g.arc(ex + Math.cos(look) * e.r * 0.4 * s, ey + Math.sin(look) * e.r * 0.4 * s, Math.max(0.6, e.r * 0.16 * s), 0, Math.PI * 2);
      g.fill();
    }
    // the mouth: a long vertical gash, opening and closing, needle teeth
    const open = (0.35 + 0.65 * Math.max(0, Math.sin(c.t * 1.7 + c.phase))) * c.mouth;
    const mw = 4.5 * s * open;
    const my0 = 6 * s;
    const my1 = 21 * s;
    g.fillStyle = "#0a0606";
    g.beginPath();
    g.moveTo(0, my0);
    g.quadraticCurveTo(mw * 1.6, (my0 + my1) / 2, 0, my1);
    g.quadraticCurveTo(-mw * 1.6, (my0 + my1) / 2, 0, my0);
    g.fill();
    g.strokeStyle = "#efe9dc";
    g.lineWidth = 0.7 * s;
    for (let i = 0; i < (this.simple ? 0 : c.teeth); i++) {
      const ty = lerp(my0 + 1.5 * s, my1 - 1.5 * s, i / (c.teeth - 1));
      const sd = i % 2 ? 1 : -1;
      const edge = mw * 0.8 * Math.sin((Math.PI * (i + 0.5)) / c.teeth);
      g.beginPath();
      g.moveTo(sd * edge, ty);
      g.lineTo(sd * (edge - 2.2 * s), ty + 0.8 * s);
      g.stroke();
    }
    g.restore();
  }
}
