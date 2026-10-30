// The landing page's bots (src/client/landing/bots): driven directly, with a fake clock and no interval (tickMs 1e9),
// reading what they do from the messages they emit.
import { describe, expect, test } from "bun:test";
import { DOODLE, INK_FADE_MS, INK_MS } from "../../src/client/landing/doodle/doodle.ts";
import { boxesOverlap, rng, wrapPhrase, writePhrase } from "../../src/client/landing/bots/handwriting.ts";
import { CAST } from "../../src/client/landing/bots/cast.ts";
import { AGENT_LINES, CHILD_STAGES, CRANK_LINES } from "../../src/client/landing/bots/home-lines.ts";
import { DRAWINGS } from "../../src/client/landing/bots/home-drawings.ts";
import { pickLine } from "../../src/client/landing/bots/lines.ts";
import { BotEngine } from "../../src/client/landing/bots/engine.ts";

type Msg = Record<string, any>;

/** A started engine on a fake clock, and everything it emits. */
function bots(clock: { now: number }) {
  const got: Msg[] = [];
  const engine = new BotEngine({ emit: (m) => got.push(m), now: () => clock.now, tickMs: 1e9 });
  engine.start();
  return { engine, got };
}

/** Run the engine on to `until` in steps of `dt`, calling `each` after every step. */
function run(engine: BotEngine, clock: { now: number }, until: number, each?: () => void, dt = 50) {
  for (; clock.now < until; clock.now += dt) {
    engine.tick(dt);
    each?.();
  }
}

describe("the bots", () => {
  test("they move and write, inside the bots' area", () => {
    const clock = { now: 0 };
    const { engine, got } = bots(clock);
    run(engine, clock, 20_000);
    const strokes = got.filter((m) => m.t === "s");
    expect(strokes.length).toBeGreaterThan(5);
    expect(got.filter((m) => m.t === "c").length).toBeGreaterThan(5);
    for (const s of strokes) {
      expect(s.p.length % 3).toBe(0);
      for (let i = 0; i < s.p.length; i += 3) {
        expect(s.p[i]).toBeGreaterThanOrEqual(DOODLE.bot.minX - 1);
        expect(s.p[i]).toBeLessThanOrEqual(DOODLE.bot.maxX + 1);
        expect(s.p[i + 1]).toBeGreaterThanOrEqual(DOODLE.bot.minY - 1);
        expect(s.p[i + 1]).toBeLessThanOrEqual(DOODLE.bot.maxY + 1);
      }
    }
    engine.stop();
    expect(engine.running).toBe(false);
  });

  test("a hidden tab pauses them; showing it again carries on", () => {
    const clock = { now: 0 };
    const { engine } = bots(clock);
    expect(engine.running).toBe(true);
    engine.pause();
    expect(engine.running).toBe(false);
    engine.resume();
    expect(engine.running).toBe(true);
    engine.stop();
  });

  test("they keep to a phone's window, and to the desktop area again when the window widens", () => {
    const clock = { now: 0 };
    const { engine, got } = bots(clock);
    engine.view(1440, 900);
    expect(engine.area()).toEqual({ ...DOODLE.bot });
    // your pencil hovers far out on the left (a bot may come to fight it)
    engine.cursor({ x: -600, y: 400 });
    run(engine, clock, 10_000);
    engine.view(360, 740);
    const a = engine.area();
    expect(a.maxX).toBeLessThanOrEqual(180 - 20);
    expect(a.minX).toBeGreaterThanOrEqual(-180 + 20);
    expect(a.maxY).toBeLessThanOrEqual(740 - 30);
    const narrowed = clock.now;
    const out: string[] = [];
    let from = got.length;
    run(engine, clock, 190_000, () => {
      // (the ones outside take a moment to come in)
      if (clock.now - narrowed < 1000) return void (from = got.length);
      for (const b of engine.bots) if (b.x < a.minX - 0.5 || b.x > a.maxX + 0.5 || b.y < a.minY - 0.5 || b.y > a.maxY + 0.5) out.push(`${b.peer.id} at ${b.x},${b.y}`);
    });
    const after = got.slice(from);
    const strokes = after.filter((m) => m.t === "s" && m.p.length);
    expect(strokes.length).toBeGreaterThan(100);
    for (const s of strokes) for (let i = 0; i < s.p.length; i += 3) if (s.p[i] < a.minX - 1 || s.p[i] > a.maxX + 1 || s.p[i + 1] > a.maxY + 1) out.push(`ink ${s.p[i]},${s.p[i + 1]}`);
    for (const c of after.filter((m) => m.t === "c")) if (c.x < a.minX - 1 || c.x > a.maxX + 1) out.push(`pencil ${c.x}`);
    expect(out.slice(0, 5)).toEqual([]);
    // nonsense sizes are clamped
    engine.view(5, -3);
    expect(engine.area().maxX).toBeGreaterThanOrEqual(110);
    engine.view(1440, 900);
    expect(engine.area()).toEqual({ ...DOODLE.bot, maxY: Math.min(DOODLE.bot.maxY, 900 - 36) });
    engine.stop();
  });

  test("they keep a few phrases showing, and don't write over ones still showing", () => {
    const clock = { now: 0 };
    const { engine } = bots(clock);
    const counts: number[] = [];
    let pairs = 0;
    let overlaps = 0;
    run(engine, clock, 400_000, () => {
      const now = clock.now;
      if (now < 90_000 || now % 1000) return;
      const showing = (engine as any).recent.filter((r: { until: number }) => r.until > now);
      counts.push(showing.length);
      for (let i = 0; i < showing.length; i++)
        for (let j = i + 1; j < showing.length; j++) {
          pairs++;
          if (boxesOverlap(showing[i].box, showing[j].box, 0)) overlaps++;
        }
    });
    // a few on the page at a time, not a crowd
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(avg).toBeGreaterThanOrEqual(3);
    expect(avg).toBeLessThanOrEqual(9);
    expect(overlaps / pairs).toBeLessThan(0.05);
    engine.stop();
  });

  test("on a phone they take turns: a few lines at a time, not written over each other, and every bot gets turns", () => {
    const clock = { now: 0 };
    const { engine } = bots(clock);
    engine.view(390, 694);
    const turns = new Map<string, number>();
    const pick = engine.pickTurn.bind(engine);
    engine.pickTurn = (who) => {
      const t = pick(who);
      turns.set(who.key, (turns.get(who.key) ?? 0) + 1);
      return t;
    };
    const place = engine.placePhrase.bind(engine);
    engine.placePhrase = (who, chosen) => {
      // (the bots that don't draw choose their lines here; moist-burrito's turns are counted in pickTurn)
      if (!who.draws) turns.set(who.key, (turns.get(who.key) ?? 0) + 1);
      return place(who, chosen);
    };
    const counts: number[] = [];
    let pairs = 0;
    let overlaps = 0;
    run(engine, clock, 400_000, () => {
      const now = clock.now;
      if (now < 90_000 || now % 1000) return;
      const showing = (engine as any).recent.filter((r: { until: number }) => r.until > now);
      counts.push(showing.length);
      // (writing over a line that's nearly gone is fine)
      const fresh = showing.filter((r: { until: number }) => r.until - now > (INK_MS + INK_FADE_MS) / 3);
      for (let i = 0; i < fresh.length; i++)
        for (let j = i + 1; j < fresh.length; j++) {
          pairs++;
          if (boxesOverlap(fresh[i].box, fresh[j].box, 0)) overlaps++;
        }
    });
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(avg).toBeGreaterThanOrEqual(1.5);
    expect(avg).toBeLessThanOrEqual(4);
    expect(overlaps / pairs).toBeLessThan(0.03);
    for (const c of CAST) expect(turns.get(c.key) ?? 0).toBeGreaterThanOrEqual(3);
    engine.stop();
  });

  test("when the window narrows, they soon write again: dropped and off-screen phrases don't hold turns", () => {
    for (let r = 0; r < 5; r++) {
      const clock = { now: 0 };
      const { engine, got } = bots(clock);
      engine.view(390, 844);
      run(engine, clock, 60_000 + r * 7_000);
      engine.view(360, 740);
      const narrowed = clock.now;
      const from = got.length;
      let first = Infinity;
      run(engine, clock, narrowed + 40_000, () => {
        if (first === Infinity && got.slice(from).some((m) => m.t === "s" && m.p.length)) first = clock.now;
      });
      expect(first - narrowed).toBeLessThanOrEqual(35_000);
      engine.stop();
    }
  });

  test("no pencil is idle more than 5 s: each starts its next line 3-5 s after the last", () => {
    for (let r = 0; r < 5; r++) {
      const clock = { now: 0 };
      const { engine, got } = bots(clock);
      // when each last put ink down (a fight counts as busy too), from its first
      const last = new Map<string, number>();
      let seen = 0;
      let worst = 0;
      run(engine, clock, 120_000, () => {
        for (const m of got.slice(seen)) if (m.t === "s" && m.p.length) last.set(m.u, clock.now);
        seen = got.length;
        for (const b of engine.bots) {
          if (!last.has(b.peer.id)) continue;
          if (b.fight) last.set(b.peer.id, clock.now);
          worst = Math.max(worst, clock.now - last.get(b.peer.id)!);
        }
      });
      expect(last.size).toBe(3);
      expect(worst).toBeLessThanOrEqual(5_050);
      engine.stop();
    }
  });

  test("they come in one at a time, 1-2 s apart; each shows hovering over its first line, lowers its tip as its pencil lands, and writes straight away", () => {
    for (let r = 0; r < 5; r++) {
      const clock = { now: 0 };
      const { engine, got } = bots(clock);
      const shown = new Map<string, { t: number; z: number; g: boolean }>();
      const firstInk = new Map<string, number>();
      let seen = 0;
      run(
        engine,
        clock,
        15_000,
        () => {
          for (const m of got.slice(seen)) {
            if (m.t === "c" && !shown.has(m.id)) shown.set(m.id, { t: clock.now, z: m.z, g: !!m.g });
            if (m.t === "s" && m.p.length && !firstInk.has(m.u)) firstInk.set(m.u, clock.now);
          }
          seen = got.length;
        },
        25,
      );
      const ins = [...shown.values()].map((s) => s.t).sort((a, b) => a - b);
      expect(ins.length).toBe(3);
      expect(ins[0]).toBeGreaterThanOrEqual(400);
      expect(ins[0]).toBeLessThanOrEqual(700 + 25);
      for (let i = 1; i < 3; i++) {
        expect(ins[i]! - ins[i - 1]!).toBeGreaterThanOrEqual(1000 - 25);
        expect(ins[i]! - ins[i - 1]!).toBeLessThanOrEqual(2000 + 25);
      }
      for (const b of engine.bots) {
        const s = shown.get(b.peer.id)!;
        // it first shows between lines, hovering, where its first stroke starts (the page drops its pencil in there)
        expect(s.g).toBe(true);
        expect(s.z).toBeGreaterThan(10);
        // its first ink as soon as it has landed and lowered its tip (FADE_IN_MS + SETTLE_MS + FIRST_LINE_DELAY_MS)
        expect(firstInk.get(b.peer.id)! - s.t).toBeGreaterThanOrEqual(500 + 300 + 80 - 50);
        expect(firstInk.get(b.peer.id)! - s.t).toBeLessThanOrEqual(600 + 300 + 80 + 100);
      }
      engine.stop();
    }
  });

  test("the first lines wait for the page to say how big its window is, so they fit a phone", () => {
    for (let r = 0; r < 5; r++) {
      const clock = { now: 0 };
      const { engine } = bots(clock);
      const placed: boolean[] = [];
      const place = engine.placePhrase.bind(engine);
      engine.placePhrase = (who, chosen) => {
        const ph = place(who, chosen);
        placed.push(engine.area().maxX < 300);
        return ph;
      };
      // (its window size comes in a moment after the bots started, as on a slow phone)
      run(engine, clock, 20_000, () => clock.now === 300 && engine.view(390, 694));
      expect(placed.length).toBeGreaterThanOrEqual(3);
      expect(placed.every(Boolean)).toBe(true);
      engine.stop();
    }
  });

  test("your pencil: jabbing a bot's body may make it chase you; a bot may pick a fight with it when it's near", () => {
    let fought = 0;
    for (let r = 0; r < 20 && !fought; r++) {
      const clock = { now: 0 };
      const { engine } = bots(clock);
      run(engine, clock, 15_000, () => {
        // keep jabbing at the first bot's body, just up its pencil from the tip
        const b = engine.bots[0]!;
        const k = (clock.now / 50) % 2;
        engine.cursor({ x: b.x + 10 + k * 10, y: b.y + 20 + k * 20 });
        if (engine.bots.some((x) => x.fight?.foe === engine.visitor)) fought++;
      });
      engine.stop();
    }
    expect(fought).toBeGreaterThan(0);
  });
});

describe("handwriting", () => {
  test("a long line wraps onto as many even lines as keep within the limit (a phone's, too)", () => {
    expect(wrapPhrase("stop. writing. near. me.", 30)).toEqual(["stop. writing. near. me."]);
    expect(wrapPhrase("I hate this pencil. I hate this page. I hate you specifically.", 20)).toEqual(["I hate this", "pencil. I hate", "this page. I hate", "you specifically."]);
    for (const c of CAST)
      for (const text of c.lines)
        for (const max of [c.wrap, c.narrowWrap]) {
          const lines = wrapPhrase(text, max);
          expect(lines.join(" ")).toBe(text);
          for (const l of lines) expect(l.length <= max || !l.includes(" ")).toBe(true);
        }
  });

  test("phrases are strokes in writing order inside their box", () => {
    const w = writePhrase(["two heads, one cursor"], { cx: 0, cy: 300, size: 30, angle: 0.3, seed: 1 });
    expect(w.strokes.length).toBeGreaterThan(3);
    // cursive: most letters join, so far fewer strokes than letters plus dots
    expect(w.strokes.length).toBeLessThan(16);
    for (const st of w.strokes) {
      for (let i = 0; i < st.length; i += 2) {
        const dx = st[i]! - w.box.cx;
        const dy = st[i + 1]! - w.box.cy;
        const u = dx * Math.cos(w.box.angle) + dy * Math.sin(w.box.angle);
        const v = -dx * Math.sin(w.box.angle) + dy * Math.cos(w.box.angle);
        expect(Math.abs(u)).toBeLessThan(w.box.hw + 10);
        expect(Math.abs(v)).toBeLessThan(w.box.hh + 20);
      }
    }
    // same seed, same writing; another seed, different
    expect(writePhrase(["hi"], { cx: 0, cy: 0, size: 30, angle: 0, seed: 5 })).toEqual(writePhrase(["hi"], { cx: 0, cy: 0, size: 30, angle: 0, seed: 5 }));
    expect(writePhrase(["hi"], { cx: 0, cy: 0, size: 30, angle: 0, seed: 5 })).not.toEqual(writePhrase(["hi"], { cx: 0, cy: 0, size: 30, angle: 0, seed: 6 }));
  });

  test("box overlap", () => {
    const a = { cx: 0, cy: 0, hw: 50, hh: 10, angle: 0 };
    expect(boxesOverlap(a, { cx: 90, cy: 0, hw: 50, hh: 10, angle: 0 })).toBe(true);
    expect(boxesOverlap(a, { cx: 0, cy: 30, hw: 50, hh: 10, angle: 0 })).toBe(false);
    expect(boxesOverlap(a, { cx: 0, cy: 30, hw: 50, hh: 10, angle: 0.6 })).toBe(true);
  });

  test("spicy-pretzel underlines about 1 in 5 of its lines", () => {
    const hand = CAST.find((c) => c.key === "crank")!.hand;
    const lines = ["who keeps opening", "this notebook"];
    let underlined = 0;
    for (let seed = 1; seed <= 1000; seed++) {
      const opts = { cx: 0, cy: 0, size: 30, angle: 0, seed };
      const n = writePhrase(lines, { ...opts, hand }).strokes.length;
      if (n > writePhrase(lines, { ...opts, hand: { ...hand, underlineOdds: 0 } }).strokes.length) underlined++;
    }
    expect(underlined / 1000).toBeGreaterThan(0.15);
    expect(underlined / 1000).toBeLessThan(0.25);
  });
});

describe("what the bots write", () => {
  test("no bot writes the same line (or draws the same drawing) twice in a row, each gets round all its lines, and no two write the same one together", () => {
    const clock = { now: 0 };
    const { engine } = bots(clock);
    const written = new Map<string, string[]>();
    const note = (key: string, what: string) => written.set(key, [...(written.get(key) ?? []), what]);
    const lastPlaced = new Map<string, { by: string; at: number }>();
    let together = 0;
    const place = engine.placePhrase.bind(engine);
    engine.placePhrase = (who, chosen) => {
      const ph = place(who, chosen);
      note(who.key, ph.text);
      const prev = lastPlaced.get(ph.text);
      if (prev && prev.by !== who.key && clock.now - prev.at < 20_000) together++;
      lastPlaced.set(ph.text, { by: who.key, at: clock.now });
      return ph;
    };
    const pick = engine.pickTurn.bind(engine);
    engine.pickTurn = (who) => {
      const t = pick(who);
      if (t.drawing) note(who.key, `drawing:${t.drawing.id}`);
      return t;
    };
    run(engine, clock, 30 * 60_000);
    for (const c of CAST) {
      const mine = written.get(c.key)!;
      expect(mine.length).toBeGreaterThan(40);
      for (let i = 1; i < mine.length; i++) expect(mine[i]).not.toBe(mine[i - 1]);
      for (const l of c.lines) expect(mine).toContain(l);
    }
    expect(together).toBe(0);
    // moist-burrito: mostly lines, a drawing now and then (both of them)
    const mb = written.get("agent")!;
    const drawn = mb.filter((w) => w.startsWith("drawing:"));
    expect(drawn.length / mb.length).toBeGreaterThan(0.1);
    expect(drawn.length / mb.length).toBeLessThan(0.3);
    for (const d of DRAWINGS) expect(mb).toContain(`drawing:${d.id}`);
    engine.stop();
  });

  test("the bots: grumpy-pickle (the kid, in stages), spicy-pretzel (the diarist), moist-burrito (the agent)", () => {
    const engine = new BotEngine({ emit: () => {}, tickMs: 1e9 });
    expect(engine.peers().map((p) => p.name)).toEqual(["grumpy-pickle", "spicy-pretzel", "moist-burrito"]);
    expect(engine.bots[0]!.cast.lines).toEqual(CHILD_STAGES.flatMap((s) => s.lines));
    expect(engine.bots[1]!.cast.lines).toEqual(CRANK_LINES);
    expect(engine.bots[2]!.cast.lines).toEqual(AGENT_LINES);
    expect(DRAWINGS.map((d) => d.id)).toEqual(["tall-one", "smile"]);
  });

  test("the kid's fear escalates: stage 1, then 2, then 3 (and stays), over the page's first minutes; a new page load starts over", () => {
    const stageOf = (l: string) => CHILD_STAGES.findIndex((s) => s.lines.includes(l));
    const watch = (engine: BotEngine, clock: { now: number }) => {
      const kid: { t: number; stage: number }[] = [];
      const place = engine.placePhrase.bind(engine);
      engine.placePhrase = (who, chosen) => {
        const ph = place(who, chosen);
        if (who.key === "child") kid.push({ t: clock.now, stage: stageOf(ph.text) });
        return ph;
      };
      return kid;
    };
    const clock = { now: 0 };
    const { engine } = bots(clock);
    const kid = watch(engine, clock);
    run(engine, clock, 12 * 60_000);
    for (const { t, stage } of kid) expect(stage).toBe(CHILD_STAGES.filter((s) => s.fromMin * 60_000 <= t).length - 1);
    expect(new Set(kid.map((k) => k.stage))).toEqual(new Set([0, 1, 2]));
    engine.stop();
    // a reload: a new engine, from the start
    const later = { now: clock.now + 60_000 };
    const again = bots(later);
    const kid2 = watch(again.engine, later);
    run(again.engine, later, later.now + 60_000);
    expect(kid2.length).toBeGreaterThan(0);
    for (const { stage } of kid2) expect(stage).toBe(0);
    again.engine.stop();
  });

  test("a line is one nobody has written for longest, never the last one written (by anyone)", () => {
    const rand = rng(5);
    const lines = ["a", "b", "c", "d"];
    for (let i = 0; i < 2_000; i++) {
      expect(["c", "d"]).toContain(pickLine(lines, ["a", "b"], rand)!);
      expect(pickLine(lines, ["b", "c", "d", "a", "b", "c"], rand)).toBe("d");
      expect(pickLine(lines, ["d"], rand)).not.toBe("d");
    }
    expect(pickLine([], ["a"], rand)).toBeUndefined();
  });
});
