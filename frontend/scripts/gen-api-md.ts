/**
 * Writes docs/API.md from lib/docs/content.ts (the same content the /docs page renders).
 *   npx tsx scripts/gen-api-md.ts          rewrite ../docs/API.md
 * lib/docs/content.test.ts fails when the checked-in file is stale.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { docsMarkdown } from "../lib/docs/markdown";

const out = path.resolve(process.cwd(), "../docs/API.md");
writeFileSync(out, docsMarkdown());
console.log(`wrote ${out}`);
