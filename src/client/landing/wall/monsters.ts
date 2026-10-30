// The monsters: the Knuckler (a rigged, skinned, cel-shaded 3D creature; its design and clips are in
// website/artifacts/grim-monster/astra) climbs out of the hole and crawls off the page, then more and more of them.
// The visitor can stab them with their pencil: three stabs kill one.
//
// three.js, its GLTFLoader and the model load only when they're about to be needed (index.ts imports this module
// lazily). One transparent canvas over the page's content (under the pencils), drawn with the wall's camera: the same
// near-orthographic view with its slight oblique tilt, and the same key light from the top left. A depth-only copy of
// the wall (its face with the hole cut out, and the hole's rim) hides whatever's still behind it, so a monster is only
// seen through the opening until it climbs out. The canvas never takes the pointer: stabs are caught on the window
// (hitTest/stab) and the pencil (../doodle) is told through ../stab.ts.
//
// The clips were made against a stand-in wall (its hole centred at (-1.2, -0.23), about 1.2 units across to the rim
// the creature climbs over, 0.28 units thick, +Z toward you, the creature crawling along +X with the wall its floor).
// Each monster maps that wall onto ours: scaled to page px, turned to the way it'll go, and moved so the rim it climbs
// over lands on our hole's rim that way. The crawl clips move their root: each completed cycle, the monster is moved
// on by the clip's stride, so its feet stay put.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import glbPath from "./knuckler.glb" with { type: "file" };
import { clamp, rand, type View } from "./core.ts";
import { MATERIAL } from "./material.ts";
import type { Hole } from "./hole.ts";

export const MONSTER = {
  /** at most this many at once (the next waits) */
  max: 14,
  maxLow: 5,
  /** size: px per unit of the model (it's about 1.6 units nose to tail, arms spread 2.4), fitted to the hole: the
   *  hole's radius over `fit`, kept within `scale`; then each monster this much of that */
  fit: 1.15,
  scale: [55, 85] as const,
  scaleLow: [32, 46] as const,
  size: [0.8, 1] as const,
  /** the first one is full size */
  firstSize: 1,
  /** crawling: the clip's speed (each monster: somewhere in the range), the chance it scuttles (else it crawls
   *  deliberately), and the chance per second of stopping to twitch */
  speed: [0.85, 1.2] as const,
  scuttle: 0.4,
  pause: 0.05,
  /** gone this far (px) past the window's edge */
  margin: 160,
  /** device pixel ratio caps (desktop, phones) */
  dpr: 1.5,
  dprLow: 1,
  /** ink widths (CSS px): the silhouette, claws and feet; hovered: the silhouette, and its colour */
  ink: 1.5,
  inkDetail: 0.7,
  inkHover: 2.6,
  inkHoverColor: "#7a0d14",
  /** the soft shadow under each: darkness, size (units: along, across) */
  shadow: 0.2,
  shadowSize: [1.9, 1.1] as const,
  /** stabbing: hits to kill one; hit-test slack (px); the reaction starts this long (s) after the press, as the
   *  pencil's tip goes in (doodle STAB_MS) */
  hp: 3,
  slack: 6,
  connect: 0.09,
  /** a hit: the flinch rises (s) and settles back, critically damped (s, the time constant); the spine bends away
   *  from the hit (degrees, spread over the lower spine, chest and neck), the chest lifts (degrees), the head snaps
   *  back (degrees), the body shifts away (units) and the nearer arm pulls in (units, in and up). The hands and feet
   *  stay planted (two-bone IK). Meanwhile the crawl slows to `hold` of its speed, then skitters on at `skitter` times
   *  its speed, easing back over `skitterTime` (s). */
  flinch: { rise: 0.09, settle: 0.085, bend: [4, 5, 3] as const, lift: 6, head: 16, shift: 0.07, arm: [0.3, 0.16] as const },
  hold: 0.2,
  skitter: 1.7,
  skitterTime: 1.6,
  /** dying: from the pose it's in, it gives out and curls up over `die` (s) (the limbs fold in and the fingers curl,
   *  easing), its body dropping to the wall over `fall`; it twitches twice, then fades away (s) */
  die: 0.55,
  /** (s) the body's drop to the wall, falling (easing in) */
  fall: 0.32,
  twitches: [0.42, 0.68] as const,
  fade: 1,
  /** when the visitor starts writing in the note, they all die at once, quicker: curling up (s), fading (s) */
  quickDie: 0.32,
  quickFade: 0.4,
  /** blood from a stab: droplets thrown, the splat's size (px), drips; a killing stab bleeds this much more */
  blood: { drops: [5, 9] as const, splat: [5, 9] as const, drips: [1, 3] as const, kill: 1.6 },
};

/** The look (from the monster's cel-look.js): flat paint, three bands from the key light, ink hulls. */
const PALETTE = { ink: "#292824", charcoal: "#4f4c47", face: "#cac3b7", claw: "#cac3b7", eye: "#ada78d", void: "#0c0b0b" };
const BANDS = [0.4, 0.67, 1.0];
const GRAIN = 0.01;

/** The stand-in wall the clips were made against (model units). */
const ASTRA = { hole: [-1.2, -0.23] as const, rim: 1.24, depth: 0.28 };

type Clip = "Emerge_Climb" | "Crawl_Deliberate" | "Crawl_Scuttle" | "Idle_Twitch";
/** each crawl cycle's stride (model units, along +X) */
const STRIDE: Partial<Record<Clip, number>> = { Crawl_Deliberate: 0.88, Crawl_Scuttle: 0.95 };

export interface Hit {
  /** page px */
  x: number;
  y: number;
  killed: boolean;
  /** the way the blood goes (unit, page), and how much: the splat's size (px), droplets, drips */
  dx: number;
  dy: number;
  splat: number;
  drops: number;
  drips: number;
  /** (s) when it bleeds: as the pencil's tip goes in */
  delay: number;
}

export class Monsters {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private template: THREE.Object3D | null = null;
  private clips = new Map<string, THREE.AnimationClip>();
  /** the fingers curled (by bone name), for dying */
  private curl = new Map<string, THREE.Quaternion>();
  private list: Monster[] = [];
  private occluder: THREE.Group = new THREE.Group();
  private occluderVersion = -1;
  private hoverMat: THREE.ShaderMaterial | null = null;
  /** the ink hulls' materials (their line width follows the canvas's resolution) */
  private inks: THREE.ShaderMaterial[] = [];
  private shadowMat: THREE.MeshBasicMaterial;
  private shadowGeo = new THREE.PlaneGeometry(1, 1);
  readonly max: number;
  kills = 0;
  private drawn = false;
  private hovered: Monster | null = null;
  ready: Promise<void>;

  constructor(
    /** (the wall swaps in a new one when it starts over) */
    public hole: Hole,
    private low: boolean,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "wall-crawlers";
    this.canvas.setAttribute("aria-hidden", "true");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, premultipliedAlpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.sortObjects = true;
    this.max = low ? MONSTER.maxLow : MONSTER.max;
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    // the wall's key light (page coords: x right, y down; here y is up)
    const L = MATERIAL.light;
    const key = new THREE.DirectionalLight(0xffffff, Math.PI);
    key.position.set(L[0], -L[1], L[2]);
    this.scene.add(key, key.target);
    this.scene.add(this.occluder);
    this.shadowMat = new THREE.MeshBasicMaterial({ color: 0x3a3128, transparent: true, opacity: MONSTER.shadow, depthWrite: false, map: blobTexture() });
    this.ready = this.load();
  }

  private async load() {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(new URL(glbPath, import.meta.url).href);
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    dequantize(root);
    const { hover, inks } = celLook(root);
    this.hoverMat = hover;
    this.inks = inks;
    for (const c of gltf.animations) this.clips.set(c.name, c);
    this.curl = sampleCurl(root, this.clips.get("Emerge_Climb"));
    this.template = root;
  }

  get count() {
    return this.list.filter((m) => !m.dead).length;
  }

  get busy() {
    return this.list.length > 0;
  }

  /** One comes out of the hole, its way out picked clear of the others coming out (first: full size). */
  spawn(): boolean {
    if (!this.template || this.count >= this.max) return false;
    const { loops } = this.hole.outline();
    const [hx, hy, hr] = this.hole.extent();
    if (!loops.length || hr <= 0) return false;
    // the way out: of a few random ones, the furthest from those already climbing
    const climbing = this.list.filter((m) => m.state === "emerge").map((m) => m.way);
    let way = Math.random() * Math.PI * 2;
    let best = -1;
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = climbing.length ? Math.min(...climbing.map((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))))) : 1;
      if (d > best) {
        best = d;
        way = a;
      }
    }
    const [lo, hi] = this.low ? MONSTER.scaleLow : MONSTER.scale;
    const fitted = clamp(hr / MONSTER.fit, lo, hi);
    const s = fitted * (this.list.length === 0 && this.kills === 0 ? MONSTER.firstSize : rand(...MONSTER.size));
    const rim = rimPoint(loops, hx, hy, way);
    const m = new Monster(SkeletonUtils.clone(this.template), this.clips, way, s, rim, this.shadowGeo, this.shadowMat);
    m.setCurl(this.curl);
    this.scene.add(m.holder, m.shadow);
    this.list.push(m);
    return true;
  }

  clear() {
    for (const m of this.list) m.dispose(this.scene);
    this.list = [];
    this.hovered = null;
    this.kills = 0;
    this.occluderVersion = -1;
  }

  update(dt: number, v: View) {
    for (const m of this.list) m.update(dt);
    // gone: off the window, or faded away
    const keep: Monster[] = [];
    for (const m of this.list) {
      if (m.gone || m.offscreen(v, MONSTER.margin)) {
        if (this.hovered === m) this.hovered = null;
        m.dispose(this.scene);
      } else keep.push(m);
    }
    this.list = keep;
  }

  /** The monster under the window point (client px), if any: the nearest to you. */
  private at(cx: number, cy: number, v: View): Monster | null {
    let hit: Monster | null = null;
    for (const m of this.list) if (!m.dead && !m.doomed && m.contains(cx + v.sx, cy + v.sy, MONSTER.slack)) hit = m;
    return hit;
  }

  /** All of them die at once (the visitor's writing in the note): quickly, and not counted as kills. */
  killAll() {
    for (const m of this.list) if (!m.dead) m.kill(true);
    this.hovered = null;
  }

  /** One of them (any) dies, naturally, not counted as a kill (the cycle's end). False if none are left. */
  killOne(): boolean {
    const live = this.list.filter((m) => !m.dead && !m.doomed);
    if (!live.length) return false;
    const m = live[Math.floor(Math.random() * live.length)]!;
    if (this.hovered === m) this.hovered = null;
    m.kill(false);
    return true;
  }

  /** (the debug panel: where each live one's chest is, in client px) */
  points(v: View): [number, number][] {
    return this.list.filter((m) => !m.dead).map((m) => {
      const [x, y] = m.chest();
      return [x - v.sx, y - v.sy];
    });
  }

  /** (the debug panel: each one's head, chest, pelvis, hands and feet on the page, dying ones too) */
  joints(): number[][][] {
    return this.list.map((m) => m.joints());
  }

  /** Is the pencil over one? (and mark it) */
  hover(cx: number, cy: number, v: View): boolean {
    const m = this.at(cx, cy, v);
    if (m !== this.hovered) {
      this.hovered?.highlight(null);
      this.hovered = m;
      if (m && this.hoverMat) m.highlight(this.hoverMat);
    }
    return !!m;
  }

  /** A stab at the window point (client px): null if there's nothing there. */
  stab(cx: number, cy: number, v: View): Hit | null {
    const m = this.at(cx, cy, v);
    if (!m) return null;
    const x = cx + v.sx;
    const y = cy + v.sy;
    // (its dying copies of the paint are made from what it has on: not the hover's ink)
    if (m.hp <= 1) {
      m.highlight(null);
      if (this.hovered === m) this.hovered = null;
    }
    const killed = m.hurt(x, y);
    if (killed) this.kills++;
    const [dx, dy] = m.away(x, y);
    const B = MONSTER.blood;
    const k = killed ? B.kill : 1;
    return { x, y, killed, dx, dy, splat: rand(...B.splat) * k, drops: Math.round(rand(...B.drops) * k), drips: Math.round(rand(...B.drips) * k), delay: MONSTER.connect };
  }

  draw(v: View) {
    const r = this.renderer;
    const dpr = Math.min(window.devicePixelRatio || 1, this.low ? MONSTER.dprLow : MONSTER.dpr);
    const w = Math.round(v.vw * dpr);
    const h = Math.round(v.vh * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      r.setPixelRatio(dpr);
      r.setSize(v.vw, v.vh, false);
      this.canvas.style.width = v.vw + "px";
      this.canvas.style.height = v.vh + "px";
    }
    if (!this.list.length) {
      if (this.drawn) r.clear();
      this.drawn = false;
      return;
    }
    this.drawn = true;
    this.syncOccluder();
    this.project(v);
    for (const m of this.inks) setInk(m, w, h, dpr);
    for (const m of this.list) m.inkScale(w, h, dpr);
    r.render(this.scene, this.camera);
  }

  /** The wall's camera: page px with y up, z toward you; near-orthographic, slightly oblique, jolted with the page. */
  private project(v: View) {
    const [ox, oy] = MATERIAL.oblique;
    const D = MATERIAL.distance;
    const hw = v.vw / 2;
    const hh = v.vh / 2;
    const cx = v.sx + hw - v.shakeX;
    const cy = v.sy + hh - v.shakeY;
    const ZR = 3000;
    // clip = (x + ox z - cx) / hw, (y - oy z + cy) / hh, depth -z / ZR, w = 1 - z / D
    this.camera.projectionMatrix.set(
      1 / hw, 0, ox / hw, -cx / hw,
      0, 1 / hh, -oy / hh, cy / hh,
      0, 0, -1 / ZR, 0,
      0, 0, -1 / D, 1,
    );
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  /** The wall, depth only: its face with the opening cut out, and the opening's rim. */
  private syncOccluder() {
    const { version, loops } = this.hole.outline();
    if (version === this.occluderVersion) return;
    this.occluderVersion = version;
    for (const c of [...this.occluder.children]) {
      (c as THREE.Mesh).geometry.dispose();
      this.occluder.remove(c);
    }
    const mat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    const B = 1e5;
    const face = new THREE.Shape([new THREE.Vector2(-B, -B), new THREE.Vector2(B, -B), new THREE.Vector2(B, B), new THREE.Vector2(-B, B)]);
    for (const L of loops) face.holes.push(new THREE.Path(L.top.map((p) => new THREE.Vector2(p[0]!, -p[1]!))));
    const faceMesh = new THREE.Mesh(new THREE.ShapeGeometry(face), mat);
    faceMesh.renderOrder = -10;
    this.occluder.add(faceMesh);
    const pos: number[] = [];
    for (const L of loops) {
      const n = L.top.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = L.top[i]!;
        const b = L.top[j]!;
        const c = L.bot[i]!;
        const d = L.bot[j]!;
        pos.push(a[0]!, -a[1]!, 0, c[0]!, -c[1]!, c[2]!, b[0]!, -b[1]!, 0, b[0]!, -b[1]!, 0, c[0]!, -c[1]!, c[2]!, d[0]!, -d[1]!, d[2]!);
      }
    }
    const rim = new THREE.BufferGeometry();
    rim.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const rimMesh = new THREE.Mesh(rim, mat);
    rimMesh.renderOrder = -10;
    this.occluder.add(rimMesh);
    for (const c of this.occluder.children) c.frustumCulled = false;
  }

  dispose() {
    this.clear();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

/** Where a ray from the opening's middle the way `a` (page radians) leaves it: the furthest crossing of its rim. */
function rimPoint(loops: { top: number[][] }[], hx: number, hy: number, a: number): [number, number] {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  let best = 0;
  for (const L of loops) {
    const n = L.top.length;
    for (let i = 0; i < n; i++) {
      const p = L.top[i]!;
      const q = L.top[(i + 1) % n]!;
      const ex = q[0]! - p[0]!;
      const ey = q[1]! - p[1]!;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((p[0]! - hx) * ey - (p[1]! - hy) * ex) / den;
      const u = ((p[0]! - hx) * dy - (p[1]! - hy) * dx) / den;
      if (t > 0 && u >= 0 && u <= 1) best = Math.max(best, t);
    }
  }
  return [hx + dx * best, hy + dy * best];
}

type State = "emerge" | "emerge-hidden" | "crawl" | "pause" | "flinch" | "dying";

/** One monster: its own skeleton and mixer (geometry and materials shared). */
class Monster {
  readonly holder = new THREE.Group();
  private mover = new THREE.Group();
  private mixer: THREE.AnimationMixer;
  private action: THREE.AnimationAction | null = null;
  private clip: Clip = "Emerge_Climb";
  private crawl: Clip;
  private speed: number;
  readonly shadow: THREE.Mesh;
  private rootBone: THREE.Object3D;
  private bones: THREE.Object3D[];
  private head: THREE.Object3D | null;
  private spine: THREE.Object3D | null;
  state: State = "emerge";
  private t = 0;
  hp = MONSTER.hp;
  gone = false;
  /** a hit's flinch: since when (s; negative: the tip's not in yet), and which way (world, unit, in the wall) */
  /** a hit on its way in (s until the tip goes in; -1: none), the flinch's envelope and phase, its way (world, unit,
   *  in the wall: the hit's, and the one it's turning to) */
  private pending = -1;
  private env = 0;
  private eStart = 0;
  private phase: "idle" | "rise" | "settle" = "idle";
  private phaseT = 0;
  private dirTo = new THREE.Vector3(1, 0, 0);
  private dirNow = new THREE.Vector3(1, 0, 0);
  /** the hit that's coming kills it */
  private lethal = false;
  private wasReacting = false;
  /** dying: since when (s), and the pose it died in (each touched bone's local position and rotation, and where its
   *  hands and feet were) */
  private deathT = 0;
  private dead0: { b: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion }[] = [];
  private plant0: Record<string, THREE.Vector3> = {};
  private pelvisZ0 = 0;
  /** dying quickly (the visitor's writing in the note) */
  private quick = false;
  private hitDir = new THREE.Vector3();
  private nearArm: "L" | "R" = "L";
  private skitterT = Infinity;
  /** the fingers curled (the model's, sampled once: see Monsters.load): bone → local rotation */
  private curl = new Map<THREE.Object3D, THREE.Quaternion>();
  private pelvis: THREE.Object3D | null;
  private limbs: Record<string, [THREE.Object3D, THREE.Object3D, THREE.Object3D] | null>;
  private fingers: THREE.Object3D[];
  /** every bone the reactions touch, and its rest pose: put back before each frame's clip pose, so a bone the clips
   *  don't drive (the pelvis's position) can't build up */
  private rest: { b: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion }[] = [];
  private fadeMats: THREE.Material[] | null = null;
  private hulls: THREE.SkinnedMesh[] = [];
  private hullMats: THREE.Material[] = [];
  private v = new THREE.Vector3();

  constructor(
    private model: THREE.Object3D,
    private clips: Map<string, THREE.AnimationClip>,
    readonly way: number,
    readonly s: number,
    rim: [number, number],
    geo: THREE.PlaneGeometry,
    shadowMat: THREE.MeshBasicMaterial,
  ) {
    // the stand-in wall's rim (the side it climbs over: +X) onto ours, the way it goes
    this.holder.position.set(rim[0], -rim[1], 0);
    this.holder.rotation.z = -way;
    this.holder.scale.setScalar(s);
    this.mover.position.set(-(ASTRA.hole[0] + ASTRA.rim), -ASTRA.hole[1], 0);
    this.mover.add(model);
    this.holder.add(this.mover);
    model.traverse((o) => {
      o.frustumCulled = false;
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.userData.hull) {
        this.hulls.push(o as THREE.SkinnedMesh);
        this.hullMats.push((o as THREE.SkinnedMesh).material as THREE.Material);
      }
    });
    this.rootBone = model.getObjectByName("Pelvis") ?? model.getObjectByName("Root") ?? model;
    this.head = model.getObjectByName("Head") ?? null;
    this.spine = model.getObjectByName("Spine_Thorax") ?? null;
    this.pelvis = model.getObjectByName("Pelvis") ?? null;
    const chain = (a: string, b: string, c: string) => {
      const x = [a, b, c].map((n) => model.getObjectByName(n));
      return x.every(Boolean) ? (x as [THREE.Object3D, THREE.Object3D, THREE.Object3D]) : null;
    };
    this.limbs = {
      L: chain("L_Shoulder", "L_Elbow", "L_Wrist"),
      R: chain("R_Shoulder", "R_Elbow", "R_Wrist"),
      LL: chain("L_Hip", "L_Knee", "L_Ankle"),
      RL: chain("R_Hip", "R_Knee", "R_Ankle"),
    };
    this.fingers = [];
    model.traverse((o) => {
      if (/_(Finger\d|Thumb)_(MCP|PIP|DIP)$/.test(o.name)) this.fingers.push(o);
    });
    const touched = new Set<THREE.Object3D>([...this.fingers]);
    for (const n of ["Pelvis", "Spine_Lower", "Spine_Thorax", "Neck", "Head"]) {
      const b = model.getObjectByName(n);
      if (b) touched.add(b);
    }
    for (const l of Object.values(this.limbs)) for (const b of l ?? []) touched.add(b);
    for (const b of touched) this.rest.push({ b, p: b.position.clone(), q: b.quaternion.clone() });
    this.bones = ["Head", "Neck", "Spine_Thorax", "Spine_Lower", "Pelvis", "L_Wrist", "R_Wrist", "L_Elbow", "R_Elbow", "L_Knee", "R_Knee"]
      .map((n) => model.getObjectByName(n))
      .filter((b): b is THREE.Object3D => !!b);
    this.mixer = new THREE.AnimationMixer(model);
    this.mixer.addEventListener("loop", () => {
      // a crawl cycle done: move on by its stride, so the feet stay put
      const stride = STRIDE[this.clip];
      if (stride) this.mover.position.x += stride;
    });
    this.crawl = Math.random() < MONSTER.scuttle ? "Crawl_Scuttle" : "Crawl_Deliberate";
    this.speed = rand(...MONSTER.speed);
    this.shadow = new THREE.Mesh(geo, shadowMat);
    this.shadow.renderOrder = 1;
    this.shadow.frustumCulled = false;
    this.play("Emerge_Climb", false, 1);
  }

  /** Play a clip from its start, keeping the body where it is. */
  private play(name: Clip, loop: boolean, speed: number, fade = 0.2) {
    const clip = this.clips.get(name);
    if (!clip) return;
    const before = this.action ? this.rootWorld() : null;
    const prev = this.action;
    const a = this.mixer.clipAction(clip);
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = true;
    a.timeScale = speed;
    a.play();
    if (prev && prev !== a) {
      if (fade > 0) prev.crossFadeTo(a, fade, false);
      else prev.stop();
    }
    this.action = a;
    this.clip = name;
    this.mixer.update(0);
    if (before) {
      // move it so its body is where it was (across the wall, not off it)
      const after = this.rootWorld();
      const d = this.holder.worldToLocal(before.clone()).sub(this.holder.worldToLocal(after.clone()));
      this.mover.position.x += d.x;
      this.mover.position.y += d.y;
      this.mixer.update(0);
    }
    void fade;
  }

  private rootWorld() {
    this.holder.updateMatrixWorld(true);
    return this.rootBone.getWorldPosition(new THREE.Vector3());
  }

  get dead() {
    return this.state === "dying";
  }

  /** its killing stab is on its way in */
  get doomed() {
    return this.lethal;
  }

  update(dt: number) {
    this.t += dt;
    if (this.state === "emerge") {
      // (by the clip's own time: a flinch slows it)
      if (this.action && this.action.time >= this.action.getClip().duration - 1e-3) this.go();
    } else if (this.state === "crawl") {
      if (Math.random() < dt * MONSTER.pause) {
        this.state = "pause";
        this.t = 0;
        this.play("Idle_Twitch", false, 1, 0.3);
      }
    } else if (this.state === "pause") {
      if (this.action && this.action.time >= this.action.getClip().duration - 0.1) this.go();
    }
    // a hit landing (the pencil's tip going in): the flinch rises from wherever it is
    if (this.pending >= 0) {
      this.pending -= dt;
      if (this.pending < 0) {
        this.pending = -1;
        this.phase = "rise";
        this.phaseT = 0;
        this.eStart = this.env;
        this.dirTo.copy(this.hitDir);
      }
    }
    // the flinch's envelope: up fast, then back, critically damped; continuous across hits
    const F = MONSTER.flinch;
    if (this.phase !== "idle") {
      this.phaseT += dt;
      if (this.phase === "rise") {
        const u = clamp(this.phaseT / F.rise, 0, 1);
        this.env = this.eStart + (1 - this.eStart) * (1 - (1 - u) ** 2);
        if (u >= 1) {
          this.phase = "settle";
          this.phaseT = 0;
          // the killing hit: it dies from right here, at the flinch's height
          if (this.lethal && this.state !== "dying") this.die(false);
        }
      } else {
        const x = this.phaseT / F.settle;
        this.env = Math.exp(-x) * (1 + x);
        if (this.env < 0.002) {
          this.env = 0;
          this.phase = "idle";
          this.skitterT = 0;
        }
      }
    }
    // (the way it flinches turns to a new hit's way, rather than jumping)
    this.dirNow.lerp(this.dirTo, Math.min(1, dt / 0.06)).normalize();
    if (this.state === "dying") {
      this.deathT += dt;
      const D = this.quick ? MONSTER.quickDie : MONSTER.die;
      const f = clamp((this.deathT - D - (this.quick ? 0 : 0.15)) / (this.quick ? MONSTER.quickFade : MONSTER.fade), 0, 1);
      for (const m of this.fadeMats ?? []) {
        m.opacity = 1 - f;
        const u = (m as THREE.ShaderMaterial).uniforms;
        if (u?.opacity) u.opacity.value = 1 - f;
      }
      (this.shadow.material as THREE.MeshBasicMaterial).opacity = MONSTER.shadow * (1 - f);
      if (f >= 1) this.gone = true;
      // it's still: from the pose it died in, falling and curling up
      this.collapse(this.deathT);
    } else {
      // the crawl's speed: held while it flinches, then skittering on, easing back
      if (this.action) {
        const sp = this.clipSpeed();
        if (this.phase !== "idle" || this.pending >= 0) this.action.timeScale = sp * (1 - (1 - MONSTER.hold) * Math.min(1, this.env * 1.5));
        else if (this.skitterT < MONSTER.skitterTime) {
          this.skitterT += dt;
          const k = clamp(this.skitterT / MONSTER.skitterTime, 0, 1);
          this.action.timeScale = sp * (1 + (MONSTER.skitter - 1) * (1 - k) ** 2);
        }
      }
      // every touched bone back to rest before the clip's pose, so nothing builds up; then the flinch on top
      if (this.env > 0 || this.wasReacting) for (const r of this.rest) {
        r.b.position.copy(r.p);
        r.b.quaternion.copy(r.q);
      }
      this.wasReacting = this.env > 0;
      this.mixer.update(dt);
      if (this.env > 0) this.flinch(this.env);
    }
    // the shadow: on the wall under it, pushed away from the light by its height
    const p = this.rootWorld();
    const L = MATERIAL.light;
    const z = Math.max(0, p.z);
    this.shadow.position.set(p.x - (L[0] / L[2]) * z * 0.6, p.y + (L[1] / L[2]) * z * 0.6, 0.4);
    this.shadow.rotation.z = this.holder.rotation.z;
    this.shadow.scale.set(MONSTER.shadowSize[0] * this.s, MONSTER.shadowSize[1] * this.s, 1);
    this.shadow.visible = p.z > -4;
  }

  /** Off it goes: crawling (or scuttling) the way it faces. */
  private go() {
    this.state = "crawl";
    this.t = 0;
    this.play(this.crawl, true, this.speed, this.clip === "Emerge_Climb" ? 0.25 : 0.3);
  }

  offscreen(v: View, m: number) {
    if (this.state === "emerge" || this.dead) return false;
    const p = this.rootWorld();
    return p.x < v.sx - m || p.x > v.sx + v.vw + m || -p.y < v.sy - m || -p.y > v.sy + v.vh + m;
  }

  /** Is the page point (px) on it? (its body as a chain of fat segments through its bones, and its hands) */
  contains(x: number, y: number, slack: number) {
    const pts: [number, number, number][] = [];
    for (const b of this.bones) {
      b.getWorldPosition(this.v);
      if (this.v.z < -6) continue;
      // (seen through the wall's camera: the oblique shift)
      pts.push([this.v.x + MATERIAL.oblique[0] * this.v.z, -this.v.y + MATERIAL.oblique[1] * this.v.z, this.v.z]);
    }
    const r = 0.22 * this.s + slack;
    for (let i = 0; i < pts.length; i++) {
      const [px, py] = pts[i]!;
      if (Math.hypot(x - px, y - py) < r) return true;
      // head → neck → chest → lower spine → pelvis
      if (i < 4 && pts[i + 1]) {
        const [qx, qy] = pts[i + 1]!;
        const ex = qx - px;
        const ey = qy - py;
        const t = clamp(((x - px) * ex + (y - py) * ey) / (ex * ex + ey * ey || 1), 0, 1);
        if (Math.hypot(x - px - ex * t, y - py - ey * t) < r) return true;
      }
    }
    return false;
  }

  /** (debug) its head, chest, pelvis, hands and feet on the page (px, as seen) */
  joints(): number[][] {
    this.holder.updateMatrixWorld(true);
    return ["Head", "Spine_Thorax", "Pelvis", "L_Wrist", "R_Wrist", "L_Ankle", "R_Ankle"].map((n) => {
      const b = this.model.getObjectByName(n);
      if (!b) return [0, 0];
      b.getWorldPosition(this.v);
      return [this.v.x + MATERIAL.oblique[0] * this.v.z, -this.v.y + MATERIAL.oblique[1] * this.v.z];
    });
  }

  /** its chest on the page (px, as seen) */
  chest(): [number, number] {
    (this.spine ?? this.rootBone).getWorldPosition(this.v);
    return [this.v.x + MATERIAL.oblique[0] * this.v.z, -this.v.y + MATERIAL.oblique[1] * this.v.z];
  }

  /** Away from the page point (unit, page): where its blood goes. */
  away(x: number, y: number): [number, number] {
    const p = this.rootWorld();
    const dx = x - p.x;
    const dy = y + p.y;
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }

  /** the clip's own speed (crawling: this monster's) */
  private clipSpeed() {
    return this.state === "crawl" ? this.speed : 1;
  }

  /** Stabbed at the page point (px): it flinches away from it as the pencil's tip goes in (MONSTER.connect from
   *  now); with no hits left, it dies from the height of that flinch. True if that killed it. */
  hurt(x: number, y: number): boolean {
    if (this.state === "dying" || this.lethal) return false;
    this.hp--;
    const c = this.chestWorld();
    this.hitDir.set(c.x - x, c.y + y, 0);
    if (this.hitDir.lengthSq() < 1e-6) this.hitDir.set(1, 0, 0);
    this.hitDir.normalize();
    if (this.phase === "idle") this.dirNow.copy(this.hitDir);
    // the arm nearer the hit
    const near = (side: "L" | "R") => {
      const w = this.limbs[side]?.[2];
      if (!w) return Infinity;
      w.getWorldPosition(this.v);
      return Math.hypot(this.v.x - x, -this.v.y - y);
    };
    this.nearArm = near("L") <= near("R") ? "L" : "R";
    this.pending = MONSTER.connect;
    this.skitterT = Infinity;
    if (this.hp <= 0) {
      this.lethal = true;
      return true;
    }
    return false;
  }

  /** Dies at once, quickly (the visitor's writing in the note, or the cycle's end): from the pose it's in. */
  kill(quick: boolean) {
    if (this.state === "dying") return;
    this.die(quick);
  }

  /** Dies from exactly the pose it's in this frame (the clip's, and any flinch on it): that pose is kept, the clip
   *  stops, and it falls and curls up from there. */
  private die(quick: boolean) {
    // (its fading copies are made from its own ink, not the hover's)
    this.highlight(null);
    this.quick = quick;
    this.state = "dying";
    this.deathT = 0;
    this.holder.updateMatrixWorld(true);
    this.dead0 = this.rest.map((r) => ({ b: r.b, p: r.b.position.clone(), q: r.b.quaternion.clone() }));
    this.plant0 = {};
    for (const [k, l] of Object.entries(this.limbs)) if (l) this.plant0[k] = l[2].getWorldPosition(new THREE.Vector3());
    this.pelvisZ0 = (this.pelvis ?? this.rootBone).getWorldPosition(new THREE.Vector3()).z;
    // its own see-through copies of the paint, to fade
    this.fadeMats = [];
    const copies = new Map<THREE.Material, THREE.Material>();
    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.Material;
      let cp = copies.get(m);
      if (!cp) {
        cp = m.clone();
        cp.transparent = true;
        // (a clone loses onBeforeCompile's patch otherwise)
        cp.onBeforeCompile = m.onBeforeCompile;
        cp.customProgramCacheKey = m.customProgramCacheKey;
        if ((m as THREE.ShaderMaterial).isShaderMaterial) {
          (cp as THREE.ShaderMaterial).uniforms = THREE.UniformsUtils.clone((m as THREE.ShaderMaterial).uniforms);
        }
        copies.set(m, cp);
        this.fadeMats!.push(cp);
      }
      mesh.material = cp;
    });
    this.shadow.material = (this.shadow.material as THREE.Material).clone();
  }

  /** set the fingers' curl (by bone name, from the model) */
  setCurl(byName: Map<string, THREE.Quaternion>) {
    for (const f of this.fingers) {
      const q = byName.get(f.name);
      if (q) this.curl.set(f, q);
    }
  }

  private chestWorld() {
    return (this.spine ?? this.rootBone).getWorldPosition(new THREE.Vector3());
  }

  /** The flinch at envelope `e` (0..1), on top of this frame's clip pose. */
  private flinch(e: number) {
    const F = MONSTER.flinch;
    const s = this.s;
    const plant = this.plants();
    const deg = Math.PI / 180;
    // the body shifts away from the hit
    if (this.pelvis) moveWorld(this.pelvis, this.dirNow.clone().multiplyScalar(F.shift * s * e));
    // the spine bends away from it (about the wall's normal: a bend, not a twist), and the chest lifts a little
    const pelvisP = (this.pelvis ?? this.rootBone).getWorldPosition(new THREE.Vector3());
    const chest = this.chestWorld();
    const up = new THREE.Vector3(0, 0, 1);
    const cross = chest.clone().sub(pelvisP).cross(this.dirNow).z;
    // (a smooth sign: a hit straight along the spine bends it hardly at all, rather than flipping)
    const side = clamp(cross / (0.25 * s), -1, 1);
    const along = chest.clone().sub(pelvisP).setZ(0).normalize();
    const pitch = new THREE.Vector3().crossVectors(along, up).normalize();
    ["Spine_Lower", "Spine_Thorax", "Neck"].forEach((n, i) => {
      const b = this.model.getObjectByName(n);
      if (!b) return;
      rotateWorld(b, up, side * F.bend[i]! * deg * e);
      rotateWorld(b, pitch, -(F.lift / 3) * deg * e);
    });
    // the head snaps back
    if (this.head) rotateWorld(this.head, pitch, -F.head * deg * e);
    // the limbs back where they were planted; the nearer arm pulls in, up off the wall
    const c = this.chestWorld();
    for (const [k, p] of Object.entries(plant)) {
      if (k === this.nearArm) {
        p.pos.lerp(c.clone().setZ(p.pos.z), F.arm[0] * e);
        p.pos.z += F.arm[1] * s * e;
      }
      this.reach(k, p);
    }
  }

  /** Dying, `t` s in: from the pose it died in, the body drops onto the wall (falling: easing in), the limbs fold in
   *  from where they are and the fingers curl (easing), it twitches, then fades (update). */
  private collapse(t: number) {
    const q = this.quick ? MONSTER.quickDie / MONSTER.die : 1;
    // the pose it died in, every frame (nothing builds up)
    for (const d of this.dead0) {
      d.b.position.copy(d.p);
      d.b.quaternion.copy(d.q);
    }
    this.holder.updateMatrixWorld(true);
    const s = this.s;
    const deg = Math.PI / 180;
    const fall = clamp(t / (MONSTER.fall * q), 0, 1) ** 2;
    const fold = smooth01(t / (MONSTER.die * q));
    // down onto the wall (the pelvis to just above it), as if it dropped
    const drop = Math.max(0, this.pelvisZ0 - 0.12 * s) * fall;
    if (this.pelvis && drop > 0) moveWorld(this.pelvis, new THREE.Vector3(0, 0, -drop));
    // the chest sags and the head drops
    const pelvisP = (this.pelvis ?? this.rootBone).getWorldPosition(new THREE.Vector3());
    const up = new THREE.Vector3(0, 0, 1);
    const chest = this.chestWorld();
    const along = chest.clone().sub(pelvisP).setZ(0);
    const pitch = along.lengthSq() > 1e-6 ? new THREE.Vector3().crossVectors(along.normalize(), up).normalize() : new THREE.Vector3(1, 0, 0);
    for (const n of ["Spine_Lower", "Spine_Thorax"]) {
      const b = this.model.getObjectByName(n);
      if (b) rotateWorld(b, pitch, 5 * deg * fall);
    }
    // twitches: a jerk of the chest and head, gone in a blink
    let tw = 0;
    for (const at of MONSTER.twitches) {
      const dt = t - at * q;
      if (dt > 0) tw += Math.exp(-dt / 0.05) * Math.min(1, dt / 0.02);
    }
    if (this.spine) rotateWorld(this.spine, up, 4 * deg * tw);
    if (this.head) rotateWorld(this.head, pitch, (9 * fold - 7 * tw) * deg);
    // the hands and feet: from where they were, drawn in toward the body and down onto the wall (sliding a little)
    const c = this.chestWorld();
    const pv = (this.pelvis ?? this.rootBone).getWorldPosition(new THREE.Vector3());
    for (const [k, l] of Object.entries(this.limbs)) {
      if (!l) continue;
      const p0 = this.plant0[k];
      if (!p0) continue;
      const arm = k.length === 1;
      const to = (arm ? c : pv).clone().setZ(Math.min(p0.z, 0.06 * s));
      const target = p0.clone().lerp(to, (arm ? 0.42 : 0.3) * fold);
      target.z = p0.z + (Math.min(p0.z, 0.04 * s) - p0.z) * fall;
      const keepQ = l[2].getWorldQuaternion(new THREE.Quaternion());
      twoBone(l[0], l[1], l[2], target);
      setWorldQuaternion(l[2], keepQ);
    }
    // the fingers curl, from where they are
    for (const f of this.fingers) {
      const to = this.curl.get(f);
      if (to) f.quaternion.slerp(to, fold);
    }
    for (const f of this.fingers) f.updateMatrixWorld(true);
  }

  /** where each hand and foot is (world), and its orientation, in the clip's pose this frame */
  private plants() {
    const out: Record<string, { pos: THREE.Vector3; q: THREE.Quaternion }> = {};
    this.holder.updateMatrixWorld(true);
    for (const [k, l] of Object.entries(this.limbs)) {
      if (!l) continue;
      out[k] = { pos: l[2].getWorldPosition(new THREE.Vector3()), q: l[2].getWorldQuaternion(new THREE.Quaternion()) };
    }
    return out;
  }

  /** a limb's end to `p` (two-bone IK), keeping its orientation */
  private reach(k: string, p: { pos: THREE.Vector3; q: THREE.Quaternion }) {
    const l = this.limbs[k];
    if (!l) return;
    twoBone(l[0], l[1], l[2], p.pos);
    setWorldQuaternion(l[2], p.q);
  }

  highlight(mat: THREE.ShaderMaterial | null) {
    if (this.fadeMats) return;
    this.hulls.forEach((h, i) => {
      // (only the silhouette hulls: claws and feet keep theirs)
      if (h.userData.hull === "silhouette") h.material = mat ?? this.hullMats[i]!;
    });
  }

  /** (its own fading copies of the ink, when it's dying) */
  inkScale(w: number, h: number, dpr: number) {
    for (const m of this.fadeMats ?? []) if ((m as THREE.ShaderMaterial).isShaderMaterial) setInk(m as THREE.ShaderMaterial, w, h, dpr);
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.holder, this.shadow);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    for (const m of this.fadeMats ?? []) m.dispose();
  }
}

/** The fingers' curled grip (from the emerging clip's first moments, as the hands come through the opening), sampled
 *  on the model once; the model is put back as it was. */
function sampleCurl(root: THREE.Object3D, clip: THREE.AnimationClip | undefined) {
  const out = new Map<string, THREE.Quaternion>();
  if (!clip) return out;
  const saved: [THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3][] = [];
  root.traverse((o) => saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.setTime(0.3);
  root.traverse((o) => {
    if (/_(Finger\d|Thumb)_(MCP|PIP|DIP)$/.test(o.name)) out.set(o.name, o.quaternion.clone());
  });
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  for (const [o, p, q, sc] of saved) {
    o.position.copy(p);
    o.quaternion.copy(q);
    o.scale.copy(sc);
  }
  root.updateMatrixWorld(true);
  return out;
}

const smooth01 = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Turn a bone by `angle` about a world axis, in its own local space (so it bends where it is), and update below it. */
function rotateWorld(bone: THREE.Object3D, axis: THREE.Vector3, angle: number) {
  if (!angle || !bone.parent) return;
  bone.parent.getWorldQuaternion(_q);
  const local = axis.clone().applyQuaternion(_q.invert()).normalize();
  bone.quaternion.premultiply(_q2.setFromAxisAngle(local, angle));
  bone.updateMatrixWorld(true);
}

/** Move a bone by a world offset (in its parent's space), and update below it. */
function moveWorld(bone: THREE.Object3D, offset: THREE.Vector3) {
  if (!bone.parent) return;
  const w = bone.getWorldPosition(new THREE.Vector3()).add(offset);
  bone.position.copy(bone.parent.worldToLocal(w));
  bone.updateMatrixWorld(true);
}

/** Set a bone's world orientation. */
function setWorldQuaternion(bone: THREE.Object3D, q: THREE.Quaternion) {
  if (!bone.parent) return;
  bone.parent.getWorldQuaternion(_q);
  bone.quaternion.copy(_q.invert().multiply(q));
  bone.updateMatrixWorld(true);
}

/** Two-bone IK: bend `mid` (in the plane it already bends in) and swing `upper` so `end` lands on `target`. */
function twoBone(upper: THREE.Object3D, mid: THREE.Object3D, end: THREE.Object3D, target: THREE.Vector3) {
  upper.getWorldPosition(_a);
  mid.getWorldPosition(_b);
  end.getWorldPosition(_c);
  const l1 = _a.distanceTo(_b);
  const l2 = _b.distanceTo(_c);
  if (l1 < 1e-6 || l2 < 1e-6) return;
  const d = clamp(_a.distanceTo(target), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const ba = _a.clone().sub(_b);
  const bc = _c.clone().sub(_b);
  const n = new THREE.Vector3().crossVectors(ba, bc);
  if (n.lengthSq() > 1e-10) {
    n.normalize();
    // the bend at `mid`: from what it is to what reaches `d` (law of cosines)
    const now = ba.angleTo(bc);
    const want = Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
    // (turning bc about n by +δ, which way opens the angle?)
    const test = bc.clone().applyAxisAngle(n, 0.01);
    const sign = ba.angleTo(test) > now ? 1 : -1;
    rotateWorld(mid, n, sign * (want - now));
  }
  // then swing the whole limb so its end points at the target
  end.getWorldPosition(_c);
  const from = _c.clone().sub(_a);
  const to = target.clone().sub(_a);
  const axis = new THREE.Vector3().crossVectors(from, to);
  if (axis.lengthSq() > 1e-12) rotateWorld(upper, axis.normalize(), from.angleTo(to));
}

function setInk(m: THREE.ShaderMaterial, w: number, h: number, dpr: number) {
  m.uniforms.resolution!.value.set(w, h);
  m.uniforms.dpr!.value = dpr;
}

/** A soft round shadow texture. */
function blobTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.55, "rgba(255,255,255,0.55)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  // (the colour is the material's: white × colour)
  return t;
}

/**
 * The model is meshopt-compressed with quantized positions, which for a skinned mesh folds the dequantizing
 * transform into the skeleton's inverse bind matrices. The cel look reads bind-space positions (the face's paint,
 * the feet), so undo it: float positions in bind space again, and the plain inverse bind matrices.
 */
function dequantize(root: THREE.Object3D) {
  const done = new Set<THREE.BufferGeometry>();
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || done.has(mesh.geometry)) return;
    done.add(mesh.geometry);
    const sk = mesh.skeleton;
    // at rest, bone · inverse = identity; with quantization it's the dequantizing transform
    const T = new THREE.Matrix4().multiplyMatrices(sk.bones[0]!.matrixWorld, sk.boneInverses[0]!);
    T.premultiply(new THREE.Matrix4().copy(mesh.bindMatrixInverse));
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const out = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(T);
      out[i * 3] = v.x;
      out[i * 3 + 1] = v.y;
      out[i * 3 + 2] = v.z;
    }
    mesh.geometry.setAttribute("position", new THREE.BufferAttribute(out, 3));
    const nrm = mesh.geometry.attributes.normal as THREE.BufferAttribute | undefined;
    if (nrm) {
      const n = new Float32Array(nrm.count * 3);
      for (let i = 0; i < nrm.count; i++) {
        v.fromBufferAttribute(nrm, i).normalize();
        n[i * 3] = v.x;
        n[i * 3 + 1] = v.y;
        n[i * 3 + 2] = v.z;
      }
      mesh.geometry.setAttribute("normal", new THREE.BufferAttribute(n, 3));
    }
    const Ti = T.clone().invert();
    for (let i = 0; i < sk.boneInverses.length; i++) sk.boneInverses[i]!.multiply(Ti);
    mesh.geometry.computeBoundingSphere();
  });
}

/** The cel look on the template (shared by every clone): paint by surface, banded toon materials, ink hulls. */
function celLook(root: THREE.Object3D) {
  const gradient = new THREE.DataTexture(new Uint8Array(BANDS.map((v) => Math.round(v * 255))), BANDS.length, 1, THREE.RedFormat);
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  const col = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, new THREE.Color(v)])) as Record<keyof typeof PALETTE, THREE.Color>;
  const hullSil = hullMaterial(MONSTER.ink, PALETTE.ink);
  const hullDetail = hullMaterial(MONSTER.inkDetail, PALETTE.ink);
  const hover = hullMaterial(MONSTER.inkHover, MONSTER.inkHoverColor);
  const mats = new Map<string, THREE.Material>();
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
  });
  for (const mesh of meshes) {
    // (GLTFLoader turns Skin_0.83 into Skin_083)
    const enc = mesh.name.match(/Skin_([\d.]+)/)?.[1] ?? "083";
    const role = (enc.includes(".") ? Number(enc) : Number(enc) / 100).toFixed(2);
    const g = mesh.geometry;
    if (role === "0.83") softenNormals(g, 7);
    const p = g.attributes.position as THREE.BufferAttribute;
    const c = role === "0.58" ? col.claw : role === "0.40" ? col.eye : role === "0.94" ? col.ink : col.charcoal;
    const colors = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) colors.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    if (role === "0.88" && g.index) {
      // the feet only (not the palm tendons in this batch)
      const idx = g.index.array;
      const kept: number[] = [];
      for (let j = 0; j < idx.length; j += 3)
        if (p.getY(idx[j]!) < -0.35 && p.getY(idx[j + 1]!) < -0.35 && p.getY(idx[j + 2]!) < -0.35) kept.push(idx[j]!, idx[j + 1]!, idx[j + 2]!);
      g.setIndex(kept);
    }
    const key = role === "0.83" ? "face" : "plain";
    let mat = mats.get(key);
    if (!mat) mats.set(key, (mat = celMaterial(gradient, key === "face")));
    mesh.material = mat;
    mesh.frustumCulled = false;
    const sil = role === "0.83";
    if (sil || role === "0.58" || role === "0.88") {
      const hull = new THREE.SkinnedMesh(g, sil ? hullSil : hullDetail);
      hull.name = `Ink_${mesh.name}`;
      hull.userData.hull = sil ? "silhouette" : "detail";
      hull.frustumCulled = false;
      hull.bind(mesh.skeleton, mesh.bindMatrix);
      mesh.add(hull);
    }
  }
  return { hover, inks: [hullSil, hullDetail, hover] };
}

function celMaterial(gradient: THREE.DataTexture, faceMask: boolean) {
  const material = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: gradient });
  const skin = new THREE.Color(PALETTE.charcoal);
  const face = new THREE.Color(PALETTE.face);
  const line = new THREE.Color(PALETTE.ink);
  const dark = new THREE.Color(PALETTE.void);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.inkSkin = { value: skin };
    shader.uniforms.inkFace = { value: face };
    shader.uniforms.inkLine = { value: line };
    shader.uniforms.inkVoid = { value: dark };
    shader.vertexShader = "varying vec3 inkRest;\nvarying float inkDepth;\n" + shader.vertexShader
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ninkRest = position;")
      .replace("#include <project_vertex>", "#include <project_vertex>\ninkDepth = (modelMatrix * vec4(transformed, 1.0)).z;");
    let fs = "varying vec3 inkRest;\nvarying float inkDepth;\nuniform vec3 inkSkin;\nuniform vec3 inkFace;\nuniform vec3 inkLine;\nuniform vec3 inkVoid;\n" + shader.fragmentShader;
    fs = fs.replace("#include <gradientmap_pars_fragment>", `
      uniform sampler2D gradientMap;
      vec3 getGradientIrradiance(vec3 normal, vec3 lightDirection) {
        float d = dot(normal, lightDirection), aa = max(fwidth(d) * 0.65, 0.0001);
        float low = texture2D(gradientMap, vec2(1.0 / 6.0, 0.5)).r;
        float middle = texture2D(gradientMap, vec2(0.5, 0.5)).r;
        float high = texture2D(gradientMap, vec2(5.0 / 6.0, 0.5)).r;
        float band = mix(low, middle, smoothstep(-1.0 / 3.0 - aa, -1.0 / 3.0 + aa, d));
        return vec3(mix(band, high, smoothstep(1.0 / 3.0 - aa, 1.0 / 3.0 + aa, d)));
      }`);
    if (faceMask)
      fs = fs.replace("#include <color_fragment>", `
        #include <color_fragment>
        vec2 faceUV = (inkRest.xy - vec2(-0.025, 0.53)) / vec2(0.255, 0.35);
        float faceEdge = dot(faceUV, faceUV), edgeAA = max(fwidth(faceEdge), 0.001);
        float paint = (1.0 - smoothstep(1.0 - edgeAA, 1.0 + edgeAA, faceEdge)) * smoothstep(0.700, 0.720, inkRest.z);
        diffuseColor.rgb = mix(inkSkin, inkFace, paint);
        float handSide = sign(inkRest.x);
        vec3 hand = vec3((inkRest.x - handSide * 0.85) * handSide, inkRest.y - 0.56, inkRest.z - 0.025);
        float knuckleInk = 0.0;
        if (abs(inkRest.x) > 0.52 && hand.y > 0.18 && hand.y < 0.36) {
          for (int finger = 0; finger < 4; finger++) {
            float center = (float(finger) - 1.5) * 0.115 * 1.32;
            float across = (hand.x - center) / 0.055;
            float ln = hand.y - 0.27 + 0.010 * (1.0 - across * across);
            float aa2 = max(fwidth(ln), 0.0007);
            float stroke = 1.0 - smoothstep(0.0025 - aa2, 0.0025 + aa2, abs(ln));
            stroke *= 1.0 - smoothstep(0.65, 1.0, abs(across));
            knuckleInk = max(knuckleInk, stroke * smoothstep(0.17, 0.195, hand.z));
          }
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, inkLine, knuckleInk * 0.55);`);
    fs = fs.replace("#include <opaque_fragment>", `
      vec3 grainCell = floor(inkRest * 220.0);
      float pigment = fract(sin(dot(grainCell, vec3(127.1, 311.7, 74.7))) * 43758.5453);
      outgoingLight *= 1.0 + (pigment - 0.5) * ${GRAIN.toFixed(3)};
      // in the hole, behind the wall's face: down into the dark
      outgoingLight = max(inkVoid, outgoingLight * (0.001 + 0.999 * smoothstep(-36.0, 7.0, inkDepth)));
      #include <opaque_fragment>`);
    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => `grim-knuckler-${faceMask}`;
  return material;
}

/** An inverted-hull ink outline, `width` CSS px wide. */
function hullMaterial(width: number, color: string) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      ink: { value: new THREE.Color(color) },
      inkVoid: { value: new THREE.Color(PALETTE.void) },
      resolution: { value: new THREE.Vector2(1, 1) },
      lineWidth: { value: width },
      dpr: { value: 1 },
      opacity: { value: 1 },
    },
    vertexShader: `
      #include <common>
      #include <skinning_pars_vertex>
      uniform vec2 resolution;
      uniform float lineWidth;
      uniform float dpr;
      varying float inkDepth;
      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        inkDepth = (modelMatrix * vec4(transformed, 1.0)).z;
        vec3 hullNormal = transformedNormal;
        #ifdef FLIP_SIDED
          hullNormal = -hullNormal;
        #endif
        vec2 direction = normalize((projectionMatrix * vec4(hullNormal, 0.0)).xy + vec2(0.00001));
        gl_Position.xy += direction * lineWidth * dpr * 2.0 / resolution * gl_Position.w;
        gl_Position.z += 0.000015 * gl_Position.w;
      }`,
    fragmentShader: `
      uniform vec3 ink;
      uniform vec3 inkVoid;
      uniform float opacity;
      varying float inkDepth;
      void main() {
        gl_FragColor = vec4(max(inkVoid, ink * (0.001 + 0.999 * smoothstep(-36.0, 7.0, inkDepth))), opacity);
        #include <colorspace_fragment>
      }`,
  });
}

function softenNormals(geometry: THREE.BufferGeometry, passes: number) {
  const attr = geometry.attributes.normal as THREE.BufferAttribute;
  const normals = attr.array as Float32Array;
  const index = geometry.index?.array;
  if (!index || !passes) return;
  const count = normals.length / 3;
  const accum = new Float32Array(normals.length);
  const weight = new Uint16Array(count);
  for (let pass = 0; pass < passes; pass++) {
    accum.fill(0);
    weight.fill(0);
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t]!;
      const b = index[t + 1]!;
      const c = index[t + 2]!;
      for (const [i, j, k] of [[a, b, c], [b, c, a], [c, a, b]] as const) {
        for (let d = 0; d < 3; d++) accum[i * 3 + d] = accum[i * 3 + d]! + normals[j * 3 + d]! + normals[k * 3 + d]!;
        weight[i] = weight[i]! + 2;
      }
    }
    for (let i = 0; i < count; i++) {
      const n = i * 3;
      const w = weight[i] || 1;
      const x = normals[n]! * 0.45 + (accum[n]! / w) * 0.55;
      const y = normals[n + 1]! * 0.45 + (accum[n + 1]! / w) * 0.55;
      const z = normals[n + 2]! * 0.45 + (accum[n + 2]! / w) * 0.55;
      const l = Math.hypot(x, y, z) || 1;
      normals[n] = x / l;
      normals[n + 1] = y / l;
      normals[n + 2] = z / l;
    }
  }
  attr.needsUpdate = true;
}

