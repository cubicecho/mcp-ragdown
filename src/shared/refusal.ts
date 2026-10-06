/**
 * A request that was understood and is refused: a bad path, a missing document, a name already
 * taken. The HTTP server answers with `status`; an MCP tool reports the message as its error.
 */
export class Refusal extends Error {
  /** The HTTP status that says why: 400, 403, 404, 405, 409 or 413. */
  readonly status: number;
  /** A word a client can branch on, where the status alone does not say enough: `changed`. */
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
