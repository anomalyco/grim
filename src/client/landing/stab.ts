// Between the wall's monsters (./wall/monsters.ts) and your pencil (./doodle): the wall says when your pencil is over a
// monster (`aiming`) and when you stab one; the pencil takes a stabbing grip and stabs. Either side may be missing
// (reduced motion, no WebGL): then nothing calls anything.
export const stabBridge = {
  /** your pencil is over a monster */
  aiming: false,
  /** set by the doodle: the wall calls it when `aiming` changes */
  onAim: null as (() => void) | null,
  /** set by the doodle: a stab at (client px), with a finger or not */
  onStab: null as ((x: number, y: number, touch: boolean) => void) | null,
};
