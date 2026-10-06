import { isRecord } from "./json.ts";

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether something caught is an error with this `code`, as Node's system errors carry one. */
export function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
