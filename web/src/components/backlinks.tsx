import { Link } from "@tanstack/react-router";
import { Section } from "@/components/section";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { withinFolder } from "@/lib/folders";
import { useBacklinks } from "@/lib/queries";

/**
 * The documents that link to this one, under its preview, each with the lines the links are on. Nothing
 * at all while loading, on an error, or when nothing links here: it is a footnote, not a feature
 * that needs its own empty state.
 */
export function Backlinks({ folder, path }: { folder: string; path: string }) {
  const backlinks = useBacklinks(path);
  const linking = backlinks.data?.backlinks ?? [];
  if (linking.length === 0) return null;
  return (
    <Section
      className="mt-10 border-border border-t pt-6"
      title="Linked from"
      description={`${linking.length} ${linking.length === 1 ? "document links" : "documents link"} here`}
      content={
        <ItemGroup className="-mx-3 gap-1">
          {linking.map((doc) => (
            <Item key={doc.path} asChild size="sm" className="px-3 py-2">
              <Link
                to="/f/$folder"
                params={{ folder }}
                search={(prev) => ({ ...prev, doc: withinFolder(doc.path) })}
              >
                <ItemContent className="min-w-0 gap-1">
                  <ItemTitle className="w-full truncate">
                    {doc.title}{" "}
                    <span className="font-mono font-normal text-muted-foreground text-xs">
                      {withinFolder(doc.path)}
                    </span>
                  </ItemTitle>
                  {doc.lines.map((line) => (
                    <ItemDescription key={line.line} className="line-clamp-2 text-xs">
                      <span className="me-2 font-mono text-muted-foreground/70">{line.line}</span>
                      {line.text}
                    </ItemDescription>
                  ))}
                </ItemContent>
              </Link>
            </Item>
          ))}
        </ItemGroup>
      }
    />
  );
}
