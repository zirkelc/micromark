/**
 * Plain input data for the cases, in a module of its own so both revisions share one copy.
 *
 * Never import the library under test here. Everything is either read from files that the
 * campaign does not touch, or generated from a fixed seed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { rng } from "./harness.mts";

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, "..");

/** The CommonMark spec examples, as used by `test/commonmark.js`. */
export const SPEC: Array<string> = (require("commonmark.json") as { commonmark: Array<{ markdown: string }> }).commonmark.map(
  (d) => d.markdown
);

/** The repo readme, as used by `test/perf.js`. */
export const README: string = fs.readFileSync(path.join(ROOT, "readme.md"), "utf8");

/** Scaled-down workloads of `test/perf.js`. */
export const PATHOLOGICAL: Array<string> = [
  "xxxx".repeat(1_000),
  "a**b".repeat(1_000),
  `a**b${"c*".repeat(1_000)}`,
  "[a](b".repeat(1_000),
  "[a](<b".repeat(1_000),
  "[a]: u\n".repeat(1_000),
];

const WORDS = (
  "the a to of and in is it for on that with as this be are you can use by or an at from not your " +
  "data model token parse stream value render output input function request response server client " +
  "cache index query schema table field record event message error result config option state " +
  "update create delete handle return async await promise array object string number boolean " +
  "markdown chat user agent context tool call reply summary example note step list item"
).split(" ");

const LANGS = ["ts", "js", "json", "sh", "python", ""];

/**
 * Builds chat-sized Markdown documents like the ones an LLM streams into a chat UI: paragraphs
 * with inline emphasis, code, links and autolinks, headings, lists (nested, ordered, tasks),
 * fenced code, GFM tables, block quotes and thematic breaks.
 */
function chatDocuments(seed: number, count: number): Array<string> {
  const rand = rng(seed);
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T,>(xs: Array<T>): T => xs[Math.floor(rand() * xs.length)];
  const word = () => pick(WORDS);

  const inline = (): string => {
    const r = rand();
    if (r < 0.08) return `**${word()} ${word()}**`;
    if (r < 0.14) return `*${word()}*`;
    if (r < 0.2) return `_${word()}_`;
    if (r < 0.28) return `\`${word()}.${word()}()\``;
    if (r < 0.32) return `[${word()} ${word()}](https://example.com/${word()}/${word()}?id=${int(1, 999)})`;
    if (r < 0.34) return `https://www.example.org/${word()}-${word()}`;
    if (r < 0.35) return `www.${word()}.com`;
    if (r < 0.36) return `${word()}@example.com`;
    if (r < 0.38) return `~~${word()}~~`;
    if (r < 0.39) return "&amp;";
    if (r < 0.4) return `\\*${word()}\\*`;
    return word();
  };
  const sentence = () => {
    const parts = Array.from({ length: int(4, 16) }, inline);
    const s = parts.join(" ");
    return `${s[0].toUpperCase()}${s.slice(1)}${pick([".", ".", ".", ":", "?", "!"])}`;
  };
  const paragraph = () => {
    const lines = Array.from({ length: int(1, 4) }, sentence);
    return lines.join(rand() < 0.3 ? "\n" : " ");
  };
  const list = (depth: number): string => {
    const ordered = rand() < 0.35;
    const task = !ordered && rand() < 0.2;
    const indent = "  ".repeat(depth) + (ordered && depth > 0 ? " " : "");
    const items: Array<string> = [];
    const n = int(2, 6);
    for (let i = 0; i < n; i++) {
      const marker = ordered ? `${i + 1}.` : "-";
      const box = task ? (rand() < 0.5 ? "[ ] " : "[x] ") : "";
      items.push(`${indent}${marker} ${box}${sentence()}`);
      if (depth < 2 && rand() < 0.2) items.push(list(depth + 1));
    }
    return items.join("\n");
  };
  const code = () => {
    const lines = Array.from(
      { length: int(2, 12) },
      () => `${"  ".repeat(int(0, 3))}const ${word()} = ${word()}(${word()}, ${int(0, 100)}); // ${word()} *${word()}*`
    );
    return `\`\`\`${pick(LANGS)}\n${lines.join("\n")}\n\`\`\``;
  };
  const table = () => {
    const cols = int(2, 5);
    const row = () => `| ${Array.from({ length: cols }, () => (rand() < 0.5 ? inline() : word())).join(" | ")} |`;
    const align = `| ${Array.from({ length: cols }, () => pick(["---", ":---", "---:", ":---:"])).join(" | ")} |`;
    return [row(), align, ...Array.from({ length: int(2, 8) }, row)].join("\n");
  };
  const block = (): string => {
    const r = rand();
    if (r < 0.4) return paragraph();
    if (r < 0.52) return `${"#".repeat(int(1, 4))} ${sentence()}`;
    if (r < 0.7) return list(0);
    if (r < 0.8) return code();
    if (r < 0.9) return table();
    if (r < 0.96) return `> ${paragraph()}`;
    return "---";
  };

  return Array.from({ length: count }, () => Array.from({ length: int(3, 12) }, block).join("\n\n") + "\n");
}

/** 30 chat-sized documents, 0.4 to 6 kB each. */
export const CHAT: Array<string> = chatDocuments(20_260_923, 30);

/** One medium chat document, cut into growing prefixes the way a chat UI re-parses streamed output. */
export const STREAM: Array<string> = (() => {
  const doc = chatDocuments(7, 40).sort((a, b) => b.length - a.length)[0];
  const prefixes: Array<string> = [];
  for (let end = 40; end < doc.length; end += 120) prefixes.push(doc.slice(0, end));
  prefixes.push(doc);
  return prefixes;
})();
