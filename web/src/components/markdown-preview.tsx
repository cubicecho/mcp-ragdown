import { Link } from "@tanstack/react-router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { resolveDocLink } from "@/lib/markdown";
import { cn } from "@/lib/utils";

/**
 * Markdown as a styled preview, after mcp-skills-manager's: a class per element rather than the
 * typography plugin, so it reads in both themes. Raw HTML is not rendered.
 *
 * A relative link to another indexed file opens it here. A relative image cannot load — the
 * server serves Markdown, not the folder — so it is drawn as its alt text instead of a broken icon.
 */
export function MarkdownPreview({
  content,
  path,
  known,
  className,
}: {
  content: string;
  /** The file being shown, which relative links resolve against. */
  path: string;
  /** Paths the index holds; a link to one of them stays in the app. */
  known: ReadonlySet<string>;
  className?: string;
}) {
  if (!content.trim()) {
    return <p className="text-muted-foreground text-sm italic">This file is empty.</p>;
  }
  return (
    <div className={cn("min-w-0 text-sm leading-relaxed [overflow-wrap:anywhere]", className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ node, ...props }) => (
            <h1 className="mt-8 mb-3 font-semibold text-2xl first:mt-0" {...props} />
          ),
          h2: ({ node, ...props }) => (
            <h2 className="mt-8 mb-2 border-b pb-1 font-semibold text-xl first:mt-0" {...props} />
          ),
          h3: ({ node, ...props }) => (
            <h3 className="mt-6 mb-2 font-semibold text-lg first:mt-0" {...props} />
          ),
          h4: ({ node, ...props }) => (
            <h4 className="mt-4 mb-2 font-semibold first:mt-0" {...props} />
          ),
          p: ({ node, ...props }) => <p className="my-3 first:mt-0" {...props} />,
          ul: ({ node, ...props }) => <ul className="my-3 list-disc pl-6" {...props} />,
          ol: ({ node, ...props }) => <ol className="my-3 list-decimal pl-6" {...props} />,
          li: ({ node, ...props }) => <li className="my-1" {...props} />,
          a: ({ node, href = "", children, ...props }) => {
            const className = "text-primary underline underline-offset-4";
            const target = resolveDocLink(path, href);
            if (target !== undefined && known.has(target)) {
              return (
                <Link to="/" search={{ doc: target }} className={className}>
                  {children}
                </Link>
              );
            }
            const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
            return (
              <a
                href={href}
                className={className}
                {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                {...props}
              >
                {children}
              </a>
            );
          },
          img: ({ node, src, alt, ...props }) =>
            typeof src === "string" && /^(https?:|data:)/.test(src) ? (
              <img src={src} alt={alt} className="my-3 max-w-full rounded-md" {...props} />
            ) : (
              <span className="rounded border border-dashed px-1.5 py-0.5 text-muted-foreground text-xs">
                image: {alt || src}
              </span>
            ),
          blockquote: ({ node, ...props }) => (
            <blockquote className="my-3 border-l-2 pl-4 text-muted-foreground" {...props} />
          ),
          code: ({ node, className: codeClass, ...props }) =>
            /language-/.test(codeClass ?? "") ? (
              <code className={cn("font-mono text-[0.85em]", codeClass)} {...props} />
            ) : (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]" {...props} />
            ),
          pre: ({ node, ...props }) => (
            <pre
              className="my-3 overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs [overflow-wrap:normal]"
              {...props}
            />
          ),
          table: ({ node, ...props }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm" {...props} />
            </div>
          ),
          th: ({ node, ...props }) => (
            <th className="border px-3 py-1.5 text-left font-medium" {...props} />
          ),
          td: ({ node, ...props }) => <td className="border px-3 py-1.5" {...props} />,
          hr: ({ node, ...props }) => <hr className="my-6" {...props} />,
          input: ({ node, ...props }) => <input className="mr-1.5 align-middle" {...props} />,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
