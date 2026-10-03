/**
 * Copied from `registry/web/ui/table.tsx` by `scripts/rn2web`.
 * Do not edit — edit the source and re-run `npm run compile`.
 *
 * This is level 4 of the plan: the item has a hand-written web half, so nothing was generated. The
 * same passes still ran over it, and for a file already written against the DOM they find nothing
 * to do beyond pointing its sibling imports at the web tree. That is deliberate — running one
 * pipeline over the whole output tree is what guarantees a hand-written half and a compiled one
 * speak the same prop vocabulary, instead of the two drifting where nobody is looking.
 */

"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Whether a `TableHead` sits in the header row group, so it can default its `scope` to the
 * direction it actually labels. Upstream sets no `scope` and leaves the browser to infer one,
 * which the header row gets right and a row header in the body — the first cell of each row,
 * as a `th` — is left to each screen reader's heuristics. Saying it costs one attribute.
 */
const InTableHeader = React.createContext(false);

/**
 * Upstream's container is `overflow-x-auto` and nothing else, which makes a table wider than its
 * column a region only a mouse wheel can move: axe reports it as `scrollable-region-focusable`,
 * and a keyboard user cannot read the columns past the edge. The container takes a tab stop —
 * the fix that rule asks for, and the one `HeaderContentFooter`'s scrolling body makes — but only
 * while it actually overflows, so a table that fits is not a stray stop in every page's tab order.
 */
function useOverflowsX() {
  const ref = React.useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = React.useState(false);
  React.useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => setOverflows(node.scrollWidth > node.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // The container keeps its width when a column grows, so the table is watched as well.
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, []);
  return [ref, overflows] as const;
}

function Table({ className, ...props }: React.ComponentProps<"table">) {
  const [ref, overflows] = useOverflowsX();
  return (
    <div
      ref={ref}
      data-slot="table-container"
      tabIndex={overflows ? 0 : undefined}
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

// Every border below names `border-border` beside its width. Upstream leans on the app's base
// layer to colour a bare `border-b`, and the cubeui stylesheet sets no such rule, so without it
// the rules between rows are `currentColor` — black lines in a light theme.
function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <InTableHeader.Provider value={true}>
      <thead
        data-slot="table-header"
        className={cn("[&_tr]:border-border [&_tr]:border-b", className)}
        {...props}
      />
    </InTableHeader.Provider>
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-border border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-border border-b transition-colors hover:bg-muted has-aria-expanded:bg-muted data-[state=selected]:bg-selection/15",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, scope, ...props }: React.ComponentProps<"th">) {
  const inHeader = React.useContext(InTableHeader);
  return (
    <th
      data-slot="table-head"
      scope={scope ?? (inHeader ? "col" : "row")}
      className={cn(
        "h-10 whitespace-nowrap px-2 text-left align-middle font-medium text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "whitespace-nowrap p-2 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
