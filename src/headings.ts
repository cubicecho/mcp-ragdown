/**
 * The lines of the section under a heading, 1-based and inclusive: from the heading to the line
 * before the next heading at its level or above. `A#B` names `B` under `A`; only the last part is
 * matched. Undefined when no heading matches, and the caller reads the whole document.
 */
export function headingRange(
  lines: string[],
  anchor: string,
): { start: number; end: number } | undefined {
  const wanted = (anchor.split("#").at(-1) ?? "").trim().toLowerCase();
  let fence: string | null = null;
  let start: number | undefined;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading?.[1] || !heading[2]) {
      continue;
    }
    if (start === undefined) {
      if (heading[2].trim().toLowerCase() === wanted) {
        start = i + 1;
        level = heading[1].length;
      }
    } else if (heading[1].length <= level) {
      return { start, end: i };
    }
  }
  return start === undefined ? undefined : { start, end: lines.length };
}
