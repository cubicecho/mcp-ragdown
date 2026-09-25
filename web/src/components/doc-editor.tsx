import { useBlocker } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { StickyHeaderContentFooter } from "@/components/header-content-footer";
import { LeaveDialog } from "@/components/leave-dialog";
import { MarkdownPreview } from "@/components/markdown-preview";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { TriangleAlert } from "@/components/ui/icons";
import { SegmentedButton, SegmentedGroup } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError, type Doc } from "@/lib/api";
import { withinFolder } from "@/lib/folders";
import { splitFrontmatter } from "@/lib/markdown";
import { useSaveDoc, useUploadDoc } from "@/lib/queries";

/** CodeMirror is most of the editor's weight: it loads the first time someone presses Edit. */
const MarkdownEditor = lazy(() => import("@/components/markdown-editor"));

type View = "write" | "preview";

/**
 * Edit one note's Markdown in place. Saves are made against the version that was opened (its
 * `hash`), so a change made on disk meanwhile — in Obsidian, by an agent, by `git pull` — is a
 * conflict to decide, never something a save quietly throws away. Unsaved changes hold back
 * leaving, whether by a link, Close, or closing the tab.
 */
export function DocEditor({
  path,
  title,
  doc,
  known,
  onClose,
}: {
  path: string;
  title: string;
  doc: Doc;
  known: ReadonlySet<string>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(doc.text);
  // What the file holds as far as this editor knows: the text and hash it last opened or saved.
  const [saved, setSaved] = useState({ text: doc.text, hash: doc.hash });
  const [view, setView] = useState<View>("write");
  const [conflict, setConflict] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const save = useSaveDoc();
  const overwrite = useUploadDoc();
  const toast = useToast();
  const dirty = draft !== saved.text;
  const busy = save.isPending || overwrite.isPending;

  // Read by the blocker and the save shortcut, which outlive the render they were made in.
  const state = useRef({ dirty, draft, saved, busy });
  state.current = { dirty, draft, saved, busy };

  const blocker = useBlocker({
    shouldBlockFn: () => state.current.dirty,
    enableBeforeUnload: () => state.current.dirty,
    withResolver: true,
  });

  const onSave = useCallback(() => {
    const { dirty, draft, saved, busy } = state.current;
    if (!dirty || busy) return;
    save.mutate(
      { path, text: draft, base_hash: saved.hash },
      {
        onSuccess: (result) => {
          setSaved({ text: draft, hash: result.hash ?? saved.hash });
          setConflict(null);
          toast("Saved", "success");
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === "changed") setConflict(error.message);
          else toast(error instanceof Error ? error.message : String(error), "error");
        },
      },
    );
  }, [path, save, toast]);

  const keepMine = () => {
    const text = state.current.draft;
    overwrite.mutate(
      { path, text, overwrite: true },
      {
        onSuccess: (result) => {
          setSaved({ text, hash: result.hash ?? "" });
          setConflict(null);
          toast("Saved over the version on disk", "success");
        },
        onError: (error) => toast(error instanceof Error ? error.message : String(error), "error"),
      },
    );
  };

  const body = useMemo(() => splitFrontmatter(draft).body, [draft]);
  const notes = useMemo(
    () => [...known].filter((each) => each !== path).map((each) => withinFolder(each)),
    [known, path],
  );

  return (
    <>
      <StickyHeaderContentFooter
        width="prose"
        header={
          <PageHeader
            title={title}
            breadcrumbs={
              <p className="break-all font-mono text-muted-foreground text-xs">
                {withinFolder(path)}
              </p>
            }
            description={busy ? "Saving…" : dirty ? "Unsaved changes" : "No unsaved changes"}
            action={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <SegmentedGroup
                  aria-label="Editor view"
                  variant="framed"
                  value={view}
                  onValueChange={(next) => setView(next as View)}
                >
                  <SegmentedButton value="write">Write</SegmentedButton>
                  <SegmentedButton value="preview">Preview</SegmentedButton>
                </SegmentedGroup>
                <Button
                  variant="outline"
                  onClick={() => (dirty ? setConfirmClose(true) : onClose())}
                >
                  Close
                </Button>
                <Button disabled={!dirty || busy} onClick={onSave}>
                  Save
                </Button>
              </div>
            }
            content={
              conflict ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
                >
                  <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
                  <p className="min-w-0 flex-1">
                    {conflict}. Saving yours replaces it; discarding reopens the file as it is now.
                  </p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="xs" onClick={onClose}>
                      Discard mine
                    </Button>
                    <Button variant="destructive" size="xs" disabled={busy} onClick={keepMine}>
                      Save mine anyway
                    </Button>
                  </div>
                </div>
              ) : undefined
            }
          />
        }
        contentClassName="pb-10"
        content={
          // Kept mounted under Preview: CodeMirror's undo history and cursor survive the switch.
          <>
            <div hidden={view !== "write"}>
              <Suspense
                fallback={
                  <div className="flex flex-col gap-3" aria-busy>
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-5/6" />
                  </div>
                }
              >
                <MarkdownEditor
                  value={doc.text}
                  onChange={setDraft}
                  onSave={onSave}
                  label={`Markdown of ${withinFolder(path)}`}
                  notes={notes}
                />
              </Suspense>
            </div>
            {view === "preview" ? (
              <MarkdownPreview content={body} path={path} known={known} />
            ) : null}
          </>
        }
      />
      <LeaveDialog
        description="Your edits to this note have not been saved, and leaving throws them away."
        open={blocker.status === "blocked" || confirmClose}
        onStay={() => {
          setConfirmClose(false);
          blocker.reset?.();
        }}
        onLeave={() => {
          if (confirmClose) {
            setConfirmClose(false);
            onClose();
          } else blocker.proceed?.();
        }}
      />
    </>
  );
}
