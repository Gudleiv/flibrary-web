// Детерминированный PRNG: фикстуры должны быть воспроизводимы, иначе на них нельзя
// опираться в тестах и сравнивать замеры производительности между прогонами.

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** mulberry32 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick из пустого массива');
    return item;
  }

  /** Несколько уникальных элементов. */
  sample<T>(items: readonly T[], count: number): T[] {
    const taken = new Set<number>();
    const result: T[] = [];
    const limit = Math.min(count, items.length);
    while (result.length < limit) {
      const index = this.int(0, items.length - 1);
      if (taken.has(index)) continue;
      taken.add(index);
      result.push(items[index] as T);
    }
    return result;
  }

  /** Смещённое к малым значениям целое — реалистичнее для «числа авторов у книги». */
  weightedInt(minInclusive: number, maxInclusive: number, bias = 2): number {
    const t = Math.pow(this.next(), bias);
    return minInclusive + Math.floor(t * (maxInclusive - minInclusive + 1));
  }
}
