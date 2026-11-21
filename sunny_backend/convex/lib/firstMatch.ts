export function firstMatch<R extends { id: string }, T>(
  rows: readonly R[],
  run: (row: R) => T | null,
): { rule: string; result: T } | null {
  for (const row of rows) {
    const result = run(row);
    if (result !== null) return { rule: row.id, result };
  }
  return null;
}
