/** Sessions whose returned chunks are remembered; past this the oldest is forgotten. */
const MAX_SESSIONS = 200;

/**
 * The chunk ids `ragdown_context` already returned for each session, least recently used first.
 * One per `Ragdown`, shared by every scope and every stateless HTTP request.
 */
export class SessionMemory {
  private readonly sessions = new Map<string, Set<string>>();

  seen(key: string): Set<string> {
    let seen = this.sessions.get(key);
    if (seen) {
      // Re-insert so Map order is least-recently-used first.
      this.sessions.delete(key);
    } else {
      seen = new Set();
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
    }
    this.sessions.set(key, seen);
    return seen;
  }
}
