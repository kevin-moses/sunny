export type Level = "yes" | "unsure" | "no";

const SURE = 0.7;

export interface Picked {
  choice: string;
  probability: number;
}

export function isSure(probability: number): boolean {
  return probability >= SURE;
}

export function level(probability: number): Level {
  if (isSure(probability)) return "yes";
  if (isSure(1 - probability)) return "no";
  return "unsure";
}

export function sure(pick: Picked): string | null {
  return isSure(pick.probability) ? pick.choice : null;
}

export function oneOf<T extends string>(values: readonly T[], value: string | null): T | null {
  return values.find((v) => v === value) ?? null;
}
