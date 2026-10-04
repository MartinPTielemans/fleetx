import { cn } from "../lib/utils";

/** A unified diff, coloured the way T3's diff panel colours additions and deletions. */
export function Diff({ text }: { text: string }) {
  if (text.trim() === "") return <div className="px-4 py-3 text-muted-foreground text-xs">No textual changes (binary files or modes only).</div>;
  return (
    <div className="max-h-[32rem] overflow-auto bg-code">
      <pre className="min-w-fit py-2 font-mono text-[0.6875rem] leading-[1.125rem]">
        {text.split("\n").map((line, i) => {
          const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")
            ? "meta"
            : line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+")
                ? "add"
                : line.startsWith("-")
                  ? "del"
                  : "ctx";
          return (
            <div
              key={i}
              className={cn(
                "px-4 whitespace-pre",
                kind === "add" && "bg-diff-addition/10 text-success-foreground",
                kind === "del" && "bg-diff-deletion/10 text-destructive-foreground",
                kind === "hunk" && "text-info-foreground",
                kind === "meta" && "font-semibold text-muted-foreground",
              )}
            >
              {line === "" ? " " : line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
