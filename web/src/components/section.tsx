import type { ReactNode } from "react";
import * as React from "react";
import { cn } from "@/lib/utils";

type SectionProps = {
  /** The body: the fields, the rows, whatever the heading is over. */
  content?: ReactNode | undefined;
  /** The overline. A short noun phrase — "Pomodoro", "Danger zone", "Notifications". */
  title?: ReactNode | undefined;
  /** One line under the title, in sentence case, on what the group is for. */
  description?: ReactNode | undefined;
  /** The heading row's far end: an add button, a count, a switch that disables the group. */
  action?: ReactNode | undefined;
  /** A hairline under the heading. Off by default; on, the group reads as one block. */
  divider?: boolean | undefined;
  /**
   * The title's heading rank. `2` by default, because a page's `PageHeader` owns the one `h1` and
   * these are the sections under it. A section nested in a section is `3`; a section in a dialog
   * whose title is the `h2` is `3` as well. Pick it by where the section sits, never by how big
   * the text should look — the text is the same size at every level.
   */
  level?: 1 | 2 | 3 | 4 | 5 | 6 | undefined;
  /**
   * `card` draws the group on a card: the border, background and shadow `Card` has, with the
   * padding inside it. `none` (the default) is a label and a gap and nothing else.
   */
  surface?: "none" | "card" | undefined;
  className?: string | undefined;
  titleClassName?: string | undefined;
  contentClassName?: string | undefined;
};

/**
 * A heading over a group of fields or rows — one source for both platforms.
 *
 * It is here because three projects wrote it separately and got *almost* the same: `text-xs
 * font-semibold uppercase` and a muted foreground in all three, then `tracking-wider` in one and
 * `tracking-wide` in another, and a `border-b pb-1` in the third. Nobody copied anybody — they each
 * typed the same five tokens from memory, which is why the sixth is different. The fourth copy was
 * a React Native one, which is why this is no longer a web-only item.
 *
 * The surface is a prop, not a wrapper. Some apps put every section on a card and some put none
 * on one, and the version that said "wrap it yourself" is the one that got rewritten locally with
 * the card inside, the title in a card header, and a `role="region"` that nobody else had.
 *
 * The semantics, both platforms:
 *
 * - The title is a heading of rank `level`. On device that is `role="heading"`, which VoiceOver and
 *   TalkBack both navigate by. On the web it is `role="heading"` + `aria-level` on the title's
 *   `<span>` rather than an `<h2>`: the rank is a prop, and the compiler writes the tag once, so a
 *   rank known only at runtime keeps its ARIA — which is the same heading to assistive technology.
 * - The root is a `<section>` on the web (`webAs`), named by its title through `aria-labelledby`,
 *   which is what makes it a `region` landmark. An untitled section has no name and so is not a
 *   landmark, which is correct: a landmark nobody can name is noise in the landmark list.
 *
 * No state, no data, no `children` — the body is `content`, like every other shell here.
 */
export function Section({
  content,
  title,
  description,
  action,
  divider = false,
  level = 2,
  surface = "none",
  className,
  titleClassName,
  contentClassName,
}: SectionProps) {
  const titleId = React.useId();
  const hasHeading = Boolean(title || description || action);

  return (
    <section
      data-slot="section"
      {...(title ? { "aria-labelledby": titleId } : {})}
      className={cn(
        "cube-rn-view",
        "min-w-0 gap-3",
        surface === "card" &&
          "rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm",
        className,
      )}
    >
      {hasHeading ? (
        <div
          data-slot="section-heading"
          className={cn(
            "cube-rn-view",
            "min-w-0 flex-row items-center gap-2",
            divider && "border-b border-border pb-1",
          )}
        >
          <div className="cube-rn-view min-w-0 flex-1">
            {title ? (
              <span
                data-slot="section-title"
                id={titleId}
                role="heading"
                aria-level={level}
                className={cn(
                  "cube-rn-text",
                  "truncate font-semibold text-muted-foreground text-xs uppercase tracking-wider",
                  titleClassName,
                )}
              >
                {title}
              </span>
            ) : null}
            {description ? (
              <p
                data-slot="section-description"
                className="cube-rn-text mt-1 text-muted-foreground text-sm"
              >
                {description}
              </p>
            ) : null}
          </div>
          {action ? (
            <div data-slot="section-action" className="cube-rn-view shrink-0">
              {action}
            </div>
          ) : null}
        </div>
      ) : null}

      {content ? (
        <div
          data-slot="section-content"
          className={cn("cube-rn-view", "min-w-0 gap-4", contentClassName)}
        >
          {content}
        </div>
      ) : null}
    </section>
  );
}
