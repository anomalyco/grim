// just-bash's browser build (the one workerd runs) has no defense-in-depth box, so host code needs no escape hatch.
export function trusted<T>(fn: () => T): T {
  return fn();
}
