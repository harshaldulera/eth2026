import { DOCS_INTRO, DOCS_TITLE, DOC_SECTIONS, type DocBlock } from "./content";

const cell = (s: string) => s.replace(/\|/g, "\\|");

function block(b: DocBlock): string {
  switch (b.kind) {
    case "p":
      return b.text;
    case "note":
      return `> ${b.tone === "warn" ? "Note: " : ""}${b.text}`;
    case "list":
      return b.items.map((i) => `- ${i}`).join("\n");
    case "steps":
      return b.items.map((i, n) => `${n + 1}. ${i}`).join("\n");
    case "code":
      return `\`\`\`${b.lang ?? ""}\n${b.text}\n\`\`\``;
    case "table":
      return [`| ${b.head.map(cell).join(" | ")} |`, `| ${b.head.map(() => "---").join(" | ")} |`, ...b.rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
  }
}

/** docs/API.md: the /docs page as Markdown. */
export function docsMarkdown(): string {
  const parts = [`# Siege: ${DOCS_TITLE}`, DOCS_INTRO];
  for (const s of DOC_SECTIONS) {
    parts.push(`## ${s.tag}: ${s.title}`, ...s.blocks.map(block));
  }
  return `${parts.join("\n\n")}\n`;
}
