#!/usr/bin/env node
/**
 * qa/vocab-lint.mjs — two static checks over the UI source (plan §2.2, §2.8):
 *
 *  1. Retired words: on-screen text must not say Castellan / Raider / Siege room / Guardian
 *     (the copy deck says Owner / Operator / Op room / Guard). Checked in JSX text, string literals
 *     rendered as JSX children, and user-visible attributes (title, aria-label, placeholder, alt,
 *     label). Identifiers, imports, data fields and comments are ignored.
 *  2. Colour literals: components/pixel, components/scene and components/grid use tokens only:
 *     no hex colours (#abc, #a1b2c3) and no rgb()/rgba() in strings or class names.
 *
 * Usage: node qa/vocab-lint.mjs [--json] [paths…]   (default: app/ components/). Exit 1 on findings.
 * Uses the project's TypeScript to parse TSX, so JSX text is told apart from code.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(import.meta.url)("typescript");

const RETIRED = /\b(Castellan|Raider|Siege room|Guardian)s?\b/;
const VISIBLE_ATTRS = new Set(["title", "aria-label", "aria-description", "placeholder", "alt", "label", "aria-valuetext"]);
const COLOR_DIRS = ["components/pixel", "components/scene", "components/grid"];
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/;
const RGB = /(?<![a-zA-Z])rgba?\(/;

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const targets = argv.filter((a) => !a.startsWith("--"));
const roots = (targets.length ? targets : ["app", "components"]).map((p) => path.resolve(ROOT, p));

function walk(p, out = []) {
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st) return out;
  if (st.isFile()) {
    if (/\.(tsx?|jsx?)$/.test(p) && !/\.test\.|\.test-util\./.test(p)) out.push(p);
    return out;
  }
  for (const name of readdirSync(p)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    walk(path.join(p, name), out);
  }
  return out;
}

const findings = [];
const rel = (f) => path.relative(ROOT, f);
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
const snippet = (s) => s.replace(/\s+/g, " ").trim().slice(0, 90);

/** Is this node rendered as text: a JSX child, or the value of a visible attribute? */
function visibleContext(node) {
  let n = node;
  // climb through ?:, &&, ||, ??, parentheses, template spans and JSX expression containers
  for (let p = n.parent; p; n = p, p = p.parent) {
    if (ts.isJsxExpression(p)) {
      const host = p.parent;
      if (ts.isJsxElement(host) || ts.isJsxFragment(host)) return "jsx child";
      if (ts.isJsxAttribute(host)) return VISIBLE_ATTRS.has(host.name.getText()) ? `${host.name.getText()}=` : null;
      return null;
    }
    if (ts.isConditionalExpression(p) && n !== p.condition) continue;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind) && n === p.right) continue;
    if (ts.isParenthesizedExpression(p) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p)) continue;
    return null;
  }
  return null;
}

function checkWords(file, sf) {
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const m = node.getText().match(RETIRED);
      if (m) findings.push({ rule: "retired-word", file: rel(file), line: lineOf(sf, node.getStart()), word: m[1], text: snippet(node.getText()) });
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) && VISIBLE_ATTRS.has(node.name.getText())) {
      const m = node.initializer.text.match(RETIRED);
      if (m) findings.push({ rule: "retired-word", file: rel(file), line: lineOf(sf, node.getStart()), word: m[1], text: `${node.name.getText()}="${snippet(node.initializer.text)}"` });
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const text = node.text ?? "";
      const m = text.match(RETIRED);
      if (m) {
        const owner = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node : node.parent?.parent ?? node.parent;
        const ctx = visibleContext(owner);
        if (ctx) findings.push({ rule: "retired-word", file: rel(file), line: lineOf(sf, node.getStart()), word: m[1], text: `${ctx} "${snippet(text)}"` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function checkColors(file, sf) {
  const visit = (node) => {
    let text = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text = node.text;
    else if (ts.isJsxText(node)) text = node.getText();
    if (text) {
      // Report each hit on its own source line (a CSS template literal spans many lines).
      const raw = node.getText();
      const start = node.getStart();
      const byLine = new Map();
      for (const m of raw.matchAll(new RegExp(`${HEX.source}|${RGB.source}`, "g"))) {
        const line = lineOf(sf, start + m.index);
        const end = raw.indexOf("\n", m.index);
        const lineText = raw.slice(raw.lastIndexOf("\n", m.index) + 1, end === -1 ? undefined : end);
        const prev = byLine.get(line) ?? { hits: [], text: lineText };
        prev.hits.push(m[0]);
        byLine.set(line, prev);
      }
      for (const [line, hit] of byLine)
        findings.push({ rule: "color-literal", file: rel(file), line, word: `${hit.hits.length}× ${[...new Set(hit.hits)].join(" ")}`, text: snippet(hit.text) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const files = roots.flatMap((r) => walk(r));
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  if (kind !== ts.ScriptKind.TS) checkWords(file, sf);
  const r = rel(file).split(path.sep).join("/");
  if (COLOR_DIRS.some((d) => `/${r}`.includes(`/${d}/`))) checkColors(file, sf);
}

if (asJson) console.log(JSON.stringify({ files: files.length, findings }, null, 2));
else {
  for (const f of findings) console.log(`${f.file}:${f.line}  ${f.rule}  ${f.word}  ${f.text}`);
  const words = findings.filter((f) => f.rule === "retired-word").length;
  const colors = findings.length - words;
  console.log(`vocab-lint: ${files.length} files · ${words} retired word(s) · ${colors} colour literal(s) in ${COLOR_DIRS.join(", ")}`);
}
process.exit(findings.length ? 1 : 0);
