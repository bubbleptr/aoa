/**
 * Deterministic 32-bit FNV-1a hash for string seeds; normalizes numeric seeds to uint32.
 */
export function hashSeed(input: string | number): number {
  if (typeof input === "number") return input >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic 32-bit seeded PRNG (Mulberry32). Never touches Math.random or crypto.
 */
export class Prng {
  readonly seed: number;
  private state: number;

  constructor(seed: number | string) {
    this.seed = hashSeed(seed);
    this.state = this.seed;
  }

  /** Returns a uniformly distributed unsigned 32-bit integer in [0, 2^32 - 1]. */
  u32(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Returns a float in [0, 1). */
  next(): number {
    return this.u32() / 0x1_0000_0000;
  }

  /** Returns a uniformly distributed integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    if (hi < lo) throw new RangeError(`int(${min}, ${max}): max must be >= min`);
    const span = hi - lo + 1;
    if (span === 1) return lo;
    if (span <= 0x1_0000_0000) {
      const limit = 0x1_0000_0000 - (0x1_0000_0000 % span);
      for (;;) {
        const x = this.u32();
        if (x < limit) return lo + (x % span);
      }
    }
    return lo + Math.floor(this.next() * span);
  }

  /** Returns true with the given probability in [0, 1]. */
  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  /** Picks one element uniformly from a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("Cannot pick from an empty array");
    return items[this.int(0, items.length - 1)]!;
  }

  /** Picks one value with probability proportional to its non-negative finite weight. */
  weighted<T>(choices: readonly { weight: number; value: T }[]): T {
    if (choices.length === 0) throw new RangeError("Cannot pick from empty weighted choices");
    let total = 0;
    for (const choice of choices) {
      if (choice.weight < 0 || !Number.isFinite(choice.weight)) {
        throw new RangeError(`Invalid weight: ${choice.weight}`);
      }
      total += choice.weight;
    }
    if (total <= 0) throw new RangeError("Total weight must be positive");
    let r = this.next() * total;
    for (const choice of choices) {
      if (choice.weight <= 0) continue;
      r -= choice.weight;
      if (r < 0) return choice.value;
    }
    for (let i = choices.length - 1; i >= 0; i--) {
      if (choices[i]!.weight > 0) return choices[i]!.value;
    }
    return choices[choices.length - 1]!.value;
  }

  /** Returns a new shuffled copy of `items` using Fisher-Yates. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }

  /** Derives an independent child PRNG stream, advancing this generator's state. */
  fork(label?: string | number): Prng {
    const base = this.u32();
    if (label === undefined) return new Prng(base);
    const tag = hashSeed(label);
    let mixed = (base ^ Math.imul(tag, 0x9e3779b1)) >>> 0;
    mixed ^= mixed >>> 16;
    mixed = Math.imul(mixed, 0x85ebca6b) >>> 0;
    mixed ^= mixed >>> 13;
    mixed = Math.imul(mixed, 0xc2b2ae35) >>> 0;
    mixed ^= mixed >>> 16;
    return new Prng(mixed >>> 0);
  }
}
