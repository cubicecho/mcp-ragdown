/** Who wrote a document and in which conversation, as its frontmatter records them. */
export interface Provenance {
  createdBy: string;
  session?: string;
}

/**
 * `text` with `created_by` (and `session`) in its frontmatter, which is added when there is none.
 * A text that already says who created it is returned as it is: the claim it carries is the
 * writer's own, and a second one would only contradict it.
 */
export function stampProvenance(text: string, { createdBy, session }: Provenance): string {
  const stamp = [
    `created_by: ${createdBy}`,
    ...(session ? [`session: ${JSON.stringify(session)}`] : []),
  ];
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const end =
    lines[0]?.trim() === "---"
      ? lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line))
      : -1;
  if (end === -1) {
    return ["---", ...stamp, "---", text].join(newline);
  }
  if (lines.slice(1, end).some((line) => /^created_by:/.test(line))) {
    return text;
  }
  return [...lines.slice(0, end), ...stamp, ...lines.slice(end)].join(newline);
}
