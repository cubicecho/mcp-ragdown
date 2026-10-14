import { CardLayout } from "@/components/card-layout";
import { ConfirmButton } from "@/components/confirm-button";
import { DescriptionList, PropertyRow } from "@/components/description-list";
import { EmptyState } from "@/components/page";
import { QueryError } from "@/components/query-state";
import { Section } from "@/components/section";
import { Alert } from "@/components/ui/alert";
import { Code } from "@/components/ui/code";
import { CircleCheck, FileText, Search, Trash2 } from "@/components/ui/icons";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { QueryLogSummary, UsageGap } from "@/lib/api";
import { formatAgo, formatCount } from "@/lib/format";
import { useClearQueryLog, useQueryLog } from "@/lib/queries";

type Summary = QueryLogSummary["summary"];

/**
 * What the query log says about search on real queries: the questions nothing answered, how often
 * the hook injects, and which documents agents read after a search showed them. The log is opt-in
 * and stays on the server, so with it off this says how to turn it on.
 */
export function UsageSection() {
  const log = useQueryLog();
  const clear = useClearQueryLog();
  const toast = useToast();
  const summary = log.data?.summary;
  const empty = summary !== undefined && summary.searches === 0 && summary.reads.total === 0;

  return (
    <Section
      description="How agents, the hook and this page searched, from the query log in the server's data directory. Nothing in it leaves the server."
      actionSlot={
        summary && !empty ? (
          <ConfirmButton
            label="Clear log"
            variant="outline"
            size="sm"
            tooltip={false}
            disabled={clear.isPending}
            title="Clear the query log?"
            description="Every logged search and read is deleted. Logging carries on if it is on."
            confirmLabel="Clear"
            onConfirm={() =>
              clear.mutate(undefined, {
                onSuccess: () => toast("Cleared the query log", "positive"),
                onError: (error) => toast(`Could not clear the query log: ${error.message}`),
              })
            }
            iconSlot={<Trash2 />}
            content="Clear log"
          />
        ) : null
      }
      contentSlot={
        log.isError ? (
          <QueryError error={log.error} onRetry={log.refetch} what="the query log" />
        ) : (
          <div className="flex flex-col gap-4">
            {log.data && !log.data.enabled ? (
              <Alert
                variant="info"
                title="The query log is off"
                description={
                  <>
                    Turn on <em>Log searches</em> under Server, or set{" "}
                    <Code>RAGDOWN_QUERY_LOG=true</Code>.{" "}
                    {empty ? "" : "What it logged before is below."}
                  </>
                }
              />
            ) : null}
            <OverviewCard summary={summary} loading={log.isPending} />
            <GapsCard
              gaps={summary?.gaps}
              searched={(summary?.searches ?? 0) > 0}
              loading={log.isPending}
            />
            <DocumentsCard documents={summary?.documents} loading={log.isPending} />
          </div>
        )
      }
    />
  );
}

const percent = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";

function OverviewCard({ summary, loading }: { summary: Summary | undefined; loading: boolean }) {
  return (
    <CardLayout
      title="Overview"
      description={
        summary?.since ? (
          <>
            Since{" "}
            <time dateTime={summary.since} title={new Date(summary.since).toLocaleString()}>
              {formatAgo(Date.parse(summary.since))}
            </time>
          </>
        ) : undefined
      }
      loading={loading}
      contentSlot={
        summary ? (
          <DescriptionList
            contentSlot={[
              <PropertyRow
                key="searches"
                label="Searches"
                value={summary.searches.toLocaleString()}
                hint={`${formatCount(summary.gaps.length, "query", "queries")} with no good hit`}
              />,
              <PropertyRow
                key="hook"
                label="Hook injected"
                value={percent(summary.hook.injected, summary.hook.calls)}
                hint={
                  summary.hook.calls > 0
                    ? `${summary.hook.injected} of ${formatCount(summary.hook.calls, "prompt")}, ${summary.hook.chunks_per_call} sections each on average; ${summary.hook.skipped} too short or a command`
                    : "No ragdown_context calls logged"
                }
              />,
              <PropertyRow
                key="reads"
                label="Read after a search"
                value={percent(summary.reads.after_search, summary.reads.total)}
                hint={
                  summary.reads.total > 0
                    ? `${summary.reads.after_search} of ${formatCount(summary.reads.total, "read")} were of a document a search showed in the 10 minutes before`
                    : "No ragdown_read_doc calls logged"
                }
              />,
            ]}
          />
        ) : null
      }
    />
  );
}

const ENDPOINTS: Record<UsageGap["endpoint"], string> = {
  ragdown_recall: "Recall",
  ragdown_context: "Hook",
  "/api/search": "Web",
};

function GapsCard({
  gaps,
  searched,
  loading,
}: {
  gaps: UsageGap[] | undefined;
  searched: boolean;
  loading: boolean;
}) {
  return (
    <CardLayout
      title="Gaps"
      description="Searches whose best hit scored under the minimum score: a document to write, or one search cannot find."
      loading={loading}
      emptySlot={
        searched ? (
          <EmptyState compact icon={CircleCheck} title="Every search found something" />
        ) : (
          <EmptyState compact icon={Search} title="No searches logged" />
        )
      }
      contentSlot={
        gaps && gaps.length > 0 ? (
          <Table>
            <TableCaption className="sr-only">Searches with no good hit</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead className="w-full">Query</TableHead>
                <TableHead className="hidden sm:table-cell">From</TableHead>
                <TableHead className="text-right">Best</TableHead>
                <TableHead className="text-right">Times</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {gaps.map((gap) => (
                <TableRow key={`${gap.query}\n${gap.last}`}>
                  <TableCell className="max-w-0 truncate" title={gap.query}>
                    {gap.query}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {ENDPOINTS[gap.endpoint]} ·{" "}
                    {gap.scope === "*" ? "every folder" : gap.scope || "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {gap.best === null ? "None" : gap.best.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{gap.count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null
      }
    />
  );
}

function DocumentsCard({
  documents,
  loading,
}: {
  documents: Summary["documents"] | undefined;
  loading: boolean;
}) {
  return (
    <CardLayout
      title="Most read"
      description="The documents agents read most with ragdown_read_doc, and how often a search showed each."
      loading={loading}
      emptySlot={<EmptyState compact icon={FileText} title="No reads logged" />}
      contentSlot={
        documents && documents.length > 0 ? (
          <Table>
            <TableCaption className="sr-only">Documents read most</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead className="text-right">Reads</TableHead>
                <TableHead className="text-right">Shown</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((document) => (
                <TableRow key={document.path}>
                  <TableCell className="max-w-0 truncate">
                    <Code>{document.path}</Code>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{document.reads}</TableCell>
                  <TableCell className="text-right tabular-nums">{document.returned}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null
      }
    />
  );
}
