const ADJECTIVES = ["soggy", "wobbly", "crunchy", "sneaky", "grumpy", "moist", "chonky", "sleepy", "spicy", "lumpy", "confused", "feral", "squishy", "smelly", "bonkers", "dizzy", "greasy", "sassy", "noodly", "crusty"];
const THINGS = ["potato", "noodle", "goblin", "pickle", "toaster", "walrus", "burrito", "nugget", "pigeon", "meatball", "spoon", "waffle", "gremlin", "turnip", "possum", "sock", "biscuit", "llama", "pretzel", "blob"];

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;

/** A silly name, lower case with a dash, e.g. "moist-noodle". */
export function sillyName(): string {
  return `${pick(ADJECTIVES)}-${pick(THINGS)}`;
}
