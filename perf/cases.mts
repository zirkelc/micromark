/**
 * Cases for the micromark harness. `lib` is the tree's entry: the production build of `micromark`
 * plus `gfm`, `gfmHtml`, `fromMarkdown` and `gfmFromMarkdown`, all resolved inside the same tree.
 *
 * The workloads mirror the repo's own inputs (CommonMark spec examples as in `test/commonmark.js`,
 * the readme and the pathological inputs of `test/perf.js`) plus chat-sized GFM documents parsed
 * the way `mdast-util-from-markdown` does it, including the re-parse of a streamed document.
 */
import type { PerfCase } from "./harness.mts";
import { CHAT, PATHOLOGICAL, README, SPEC, STREAM } from "./fixtures.mts";

const DANGEROUS = { allowDangerousHtml: true, allowDangerousProtocol: true };

export function buildCases(lib: any): Array<PerfCase> {
  const cases: Array<PerfCase> = [];

  /** The tokenizer alone, exactly as `mdast-util-from-markdown` drives it. */
  const tokenize = (doc: string, extensions?: Array<unknown>) =>
    lib.postprocess(lib.parse({ extensions }).document().write(lib.preprocess()(doc, undefined, true)));

  /** Compact, serializable form of an event list: kind, token type, start and end offsets. */
  const events = (list: Array<any>) =>
    list.map((e) => `${e[0] === "enter" ? ">" : "<"}${e[1].type}:${e[1].start.offset}-${e[1].end.offset}`).join(" ");

  const mdast = (doc: string) =>
    lib.fromMarkdown(doc, { extensions: [lib.gfm()], mdastExtensions: [lib.gfmFromMarkdown()] });

  cases.push({
    name: "spec-html",
    run: () => {
      for (const doc of SPEC) lib.micromark(doc, DANGEROUS);
    },
    collect: () => SPEC.map((doc) => lib.micromark(doc, DANGEROUS)),
  });

  cases.push({
    name: "spec-tokens",
    run: () => {
      for (const doc of SPEC) tokenize(doc);
    },
    collect: () => SPEC.map((doc) => events(tokenize(doc))),
  });

  cases.push({
    name: "readme-html",
    run: () => {
      lib.micromark(README);
    },
    collect: () => lib.micromark(README),
  });

  cases.push({
    name: "pathological-html",
    run: () => {
      for (const doc of PATHOLOGICAL) lib.micromark(doc);
    },
    collect: () => PATHOLOGICAL.map((doc) => lib.micromark(doc)),
  });

  cases.push({
    name: "chat-mdast-gfm",
    run: () => {
      for (const doc of CHAT) mdast(doc);
    },
    collect: () => CHAT.map((doc) => mdast(doc)),
  });

  {
    const extensions = [lib.gfm()];
    cases.push({
      name: "chat-tokens-gfm",
      run: () => {
        for (const doc of CHAT) tokenize(doc, extensions);
      },
      collect: () => CHAT.map((doc) => events(tokenize(doc, extensions))),
    });
  }

  {
    const options = { extensions: [lib.gfm()], htmlExtensions: [lib.gfmHtml()] };
    cases.push({
      name: "chat-html-gfm",
      run: () => {
        for (const doc of CHAT) lib.micromark(doc, options);
      },
      collect: () => CHAT.map((doc) => lib.micromark(doc, options)),
    });
  }

  cases.push({
    name: "chat-html-commonmark",
    run: () => {
      for (const doc of CHAT) lib.micromark(doc);
    },
    collect: () => CHAT.map((doc) => lib.micromark(doc)),
  });

  cases.push({
    name: "stream-mdast-gfm",
    run: () => {
      for (const doc of STREAM) mdast(doc);
    },
    collect: () => STREAM.map((doc) => mdast(doc)),
  });

  return cases;
}
