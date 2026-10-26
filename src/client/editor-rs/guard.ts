// The wasm engine is built with panic=abort: a Rust panic (e.g. inside yrs on a malformed update) traps with a
// WebAssembly.RuntimeError and leaves the instance unusable (the object stays "borrowed": every later call throws).
// guardEngine wraps an engine so the first trap is reported once (the owner then shows the text read-only with a
// Reload button, fallback.ts) and every later call fails fast with EngineCrashed instead of touching the broken
// instance.

export class EngineCrashed extends Error {
  constructor(readonly cause?: unknown) {
    super("the Rust editor engine crashed");
  }
}

/** A trap in the wasm (panic → `unreachable`), or a call into an instance left broken by one. */
export function isEngineCrash(err: unknown): boolean {
  if (err instanceof EngineCrashed) return true;
  if (typeof WebAssembly !== "undefined" && err instanceof WebAssembly.RuntimeError) return true;
  return err instanceof Error && /recursive use of an object|unreachable/.test(err.message);
}

export function guardEngine<T extends object>(engine: T, onCrash: (err: unknown) => void): T {
  let dead = false;
  const wrapped = new WeakMap<object, unknown>();
  return new Proxy(engine, {
    get(target, prop) {
      const v: unknown = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      const fn = v as (...args: unknown[]) => unknown;
      let w = wrapped.get(fn);
      if (!w) {
        w = (...args: unknown[]) => {
          if (dead) throw new EngineCrashed();
          try {
            return fn.apply(target, args);
          } catch (err) {
            if (!isEngineCrash(err)) throw err;
            dead = true;
            onCrash(err);
            throw new EngineCrashed(err);
          }
        };
        wrapped.set(fn, w);
      }
      return w;
    },
  });
}
