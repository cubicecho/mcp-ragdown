/** True for what `JSON.parse` gives for a JSON object: not null, not an array, not a scalar. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
