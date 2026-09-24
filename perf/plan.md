# Performance campaign: micromark (perf-autoresearch)

## Repo

micromark monorepo, 23 npm workspaces, npm (no lockfile, `ignore-scripts`). Sources live in each
package's `dev/`; `micromark-build` (babel: unassert, undebug, inline constants) writes the
production files (`index.js`, `lib/`) next to them. The production files are **gitignored**, not
committed. Packages resolve `development` → `dev/`, default → production build.

Gates and the artifact each one consumes:

| gate | cost | artifact |
|---|---|---|
| `npm run build` (tsc, type-coverage, micromark-build, rollup, gzip-size) | 5.7 s | writes prod files and `micromark.min.js` |
| `test-api-dev` (node:test, 1944 tests) | 1.3 s | `dev/` (development condition) |
| `test-api-prod` | 1.4 s | prod build; **stale unless `build` ran first** (canary: passed with a broken `dev/`) |
| `format` (remark, prettier, xo --fix) | 8 s | sources; rewrites files |
| `test-coverage` (`c8 --100` over test-api-dev) | 1.7 s | `dev/` |
| `npm test` = build + format + coverage | 8.4 s | all of the above |
| `perf/guard.mts` | 3 s | its own copy of the working tree, prod-built |

CI (`main.yml`) runs `npm test` on Node LTS and latest, Ubuntu and Windows, plus a canary job that
runs downstream suites (gfm, directive, mdx, remark, react-markdown, mdast-util-from-markdown).

Size: `rollup -c` bundles `packages/micromark/index.js` into `micromark.min.js`; the build prints
`gzip-size` (14.7 kB, 14,687 B). **No size budget is enforced** anywhere (no size-limit, no CI
check), but the readme sells micromark as "small", so every change carries its gzip/brotli delta.

Existing benchmark: `test/perf.js`, standalone `Date.now()` timings of pathological inputs and
`readme x1000`, one version per process. Kept as external cross-check.

Metric maintainers accept: time. Merged perf PRs #140 (`now` without Object.assign, ~11%), #170
(push+reverse instead of unshift), #171 (SpliceBuffer gap buffer for subtokenize), #185
(resolveAllLabelEnd without repeated splice). Titles use "Refactor to improve … performance". All
four are small, local refactors in hot loops, with a benchmark number in the body.

## Harness

`perf/` from the node-ts runtime, run with plain `node` (Node 24 strips types; no `tsx` added).
Adaptations in `perf/harness.mts`:

- `src = packages`. Each revision (and the working tree, keyed by a content hash) is unpacked under
  `node_modules/.perf-trees/<key>-<slot>/` (out of reach of tsc, xo, prettier, remark).
- Each tree gets its own `node_modules`: symlinks for all workspace packages into the tree, and
  real copies of `micromark-extension-gfm*`, `mdast-util-from-markdown`, `mdast-util-gfm*`, so
  every micromark import resolves inside the tree (verified with `import.meta.resolve`).
- Each tree is built with `micromark-build` in workspace order; the harness measures the
  **production build**, which is what users load by default.
- `.prettierignore`, `.remarkignore`, `xo.config.js` ignore `perf/` (harness commit only, not in PRs).

Cases (`perf/cases.mts`), bodies 17 to 63 ms: `spec-html`, `spec-tokens` (652 CommonMark
examples), `readme-html`, `pathological-html` (test/perf.js inputs at 1e3), `chat-mdast-gfm`
(chat app path: fromMarkdown + gfm over 30 seeded chat docs), `chat-tokens-gfm`, `chat-html-gfm`,
`chat-html-commonmark`, `stream-mdast-gfm` (45 growing prefixes of one 5 kB doc). No GFM test
suite exists under `test/`; GFM coverage comes from the seeded chat documents.

Canaries: busy loop in `sanitizeUri` moved only the HTML cases (chat-html-gfm +6.4%,
chat-html-commonmark +5.8%, token/mdast cases flat). Behaviour canary without rebuild: guard
FAILED, test-api-dev 395 fails, test-api-prod passed (stale build) → always build before prod tests.

One A/B run: ~44 s (25 iters, 1 child per order).

## Calibration (identical code both sides, 3 runs, first cold run discarded)

Machine probe: min 56.9 ms, p50 57.2 ms, max 72.6 ms (0.6% above min)

TOTAL deltas: +0.04%, +0.02%, -0.08%  → noise floor 0.08%
GEOMEAN deltas: -0.07%, +0.09%, +0.07% → noise floor 0.09%

Per-case noise = largest |median delta| over the 3 runs:

| case | noise | bar (2x, min 1%) |
|---|---|---|
| spec-html | 1.60% | 3.2% |
| spec-tokens | 0.47% | 1.0% |
| readme-html | 1.84% | 3.7% |
| pathological-html | 0.82% | 1.6% |
| chat-mdast-gfm | 0.71% | 1.4% |
| chat-tokens-gfm | 1.30% | 2.6% |
| chat-html-gfm | 0.52% | 1.0% |
| chat-html-commonmark | 1.23% | 2.5% |
| stream-mdast-gfm | 0.79% | 1.6% |

**Keep bar: one summary clears 1% (floor x2 is far below the 1% minimum), the other does not
regress beyond 0.1%, confirmed by a second run.** Per-case rule: targeted case clears its bar in
both runs, summaries do not regress.

Budget: 10 experiments x 2.5 x 44 s ≈ 20 min of measurement.

## Baseline (ms, per-side minimum, calibration run 1)

| case | ms |
|---|---|
| spec-html | 21.4 |
| spec-tokens | 17.4 |
| readme-html | 21.4 |
| pathological-html | 43.2 |
| chat-mdast-gfm | 43.2 |
| chat-tokens-gfm | 27.9 |
| chat-html-gfm | 35.9 |
| chat-html-commonmark | 24.6 |
| stream-mdast-gfm | 63.0 |
| TOTAL | 298.1 |

gzip `micromark.min.js`: 14,687 B.

Profile (all cases, 8 s): self time `subtokenize` 9.7%, `go` 5.0%, chunked `splice` 4.7%,
`compile` 4.2%, `resolveAllAttention` 3.9%, `subcontent` 3.0%, `resolveAll` 2.5%,
`syntaxExtension` 2.3%. Line ticks: `subtokenize` `Object.assign(jumps, subcontent())` 2765,
`index in jumps` 1372 (integer-keyed plain object → dictionary elements). `splice` callers:
`constructs` (combineExtensions, per parse) 127 ms, `subtokenize` write-back 112 ms, `push` 90 ms.

## Candidates

1. subtokenize: `jumps` as a `Map` filled directly by `subcontent`, no `Object.assign` of an
   integer-keyed object and no `in` on dictionary elements (~5% of samples on those two lines).
2. chunked `splice`: small path passes `items` by spread instead of `Array.from` + `unshift`
   (4.7% self across all callers).
3. subtokenize write-back: replace `splice(eventsArray, 0, Infinity, events.slice(0))` with a
   cheaper copy, or skip it when nothing changed.
4. combineExtensions `constructs()`: skip the splice when nothing goes before (runs per parse).
5. resolveAllAttention: hoist the closer's marker out of the backward scan; avoid `sliceSerialize`
   string allocation per candidate opener.
6. SpliceBuffer `get`/`length` overhead in the subtokenize loop.

## Decision items (behaviour changes, not attempted)

- **compile: one handler context per tokenizer instead of per event.** `compile` allocates a
  fresh `{...context, sliceSerialize}` for every handled event. Caching one per tokenizer context
  would remove that allocation, but a third-party HTML extension that writes to `this` would then
  see state leak between events. No handler in core or GFM writes to `this`. A maintainer would
  need to decide whether `this` is documented as fresh per call.
- **resolveAllAttention: bound the backward scan (CommonMark "openers bottom").** Every closer walks
  back to index 0 when no opener matches (`a**b` + `c*` x n is quadratic). A per-marker lower bound
  is the reference implementation's fix. It is a larger, algorithmic change and was out of scope for a 10-experiment
  budget.

## Recalibration (after experiment 2)

The machine got busier after the first calibration (Chrome at 40 to 80% CPU). An identical-code
control with the original settings gave TOTAL -1.27%, GEOMEAN -1.20%. Settings tightened:
`--repeats 2 --iters 30`, probe gate p50 < 1.5% above min (wrapper waits for it). Two controls:
TOTAL +0.73%, +0.01%; GEOMEAN +0.41%, +0.36% → floor ~0.75%, **keep bar raised to 1.5%**. One run
now takes ~90 s plus the wait for a quiet probe. Experiments 1 and 2 were re-measured once with the
new settings and still clear it (-3.40%/-3.36% and -2.16%/-2.70%).

## Experiment notes

1. **subtokenize jumps as Map** (keep). `jumps` was a plain object with integer keys, filled with
   `Object.assign` from each `subcontent` result and probed with `in` on every event. V8 keeps
   such objects in dictionary elements. A `Map` filled directly by `subcontent` removes the
   intermediate object and the copy. -2.4 to -3.4% total over three runs, all cases move.
   Complexity: none added, `subcontent` is module-private.
2. **chunked splice spreads items** (keep). The small path copied `items` with `Array.from`, then
   `unshift`ed two arguments (O(n) shift) before the spread call. `list.splice(start, remove,
   ...items)` does the same call without the copy. Every splice caller benefits; per-parse
   `combineExtensions` most, so `spec-tokens` (652 tiny docs) gains -7.6 to -7.9%. Size -4 B gzip.
3. **subtokenize skips write-back when unchanged** (discard). -0.63%/-0.15%: the final
   no-edit pass is short on chat-sized docs. Not a near miss.

4. **handleMapOfConstructs reuses `map[code]`** (near miss, -0.94%/-0.80%). Skips a fresh array
   and two spreads per construct attempt when `map.null` is empty.
5. **chunked push uses native `push`** (discard, -0.74% in the only valid run; first run had a
   busy probe). Also needed a new test for c8 --100.
6. **compile context spread first** (keep). `{sliceSerialize, ...context}` → `{...context,
   sliceSerialize}`. With the spread first, V8 clones the object on its fast path; with a property
   first it copies generically. The same own keys and values; only `Object.keys(this)` order differs.
   Only HTML cases move (-1 to -4%), token/mdast cases flat, like the canary. Size 0 B gzip.
7. **bundle 4 + restore pops events** (discard, -0.81%/-0.59%): the pop loop adds nothing.
8. **prepareList by index range** (discard, neutral; -2 B gzip only).
9. **jumps as pre-sized array** (discard, +3.9%/+3.4%): `Array.from({length})` per call costs
   more than the faster lookup saves.

## Final summary

Kept (3 of 9): `d59afaf` subtokenize jumps as Map, `c9f2bdb` chunked splice spreads items,
`ac0bd52` compile context spread first. Discarded 6 (one near miss: 4). Stopped at 9 on request.

Cumulative A/B, `1a5384a` (pre-loop) vs `ac0bd52`, two runs, probe 1.0% / 0.7%:

| case | run 1 | run 2 |
|---|---|---|
| spec-html | -6.42% | -8.19% |
| spec-tokens | -5.73% | -7.53% |
| readme-html | -8.51% | -7.61% |
| pathological-html | -7.40% | -6.65% |
| chat-mdast-gfm (chat app) | -4.24% | -4.06% |
| chat-tokens-gfm | -5.10% | -4.88% |
| chat-html-gfm | -7.14% | -6.70% |
| chat-html-commonmark | -7.97% | -6.89% |
| stream-mdast-gfm (chat app, streaming) | -4.09% | -4.80% |
| **TOTAL** | **-5.94%** | **-5.95%** |
| **GEOMEAN** | **-6.30%** | **-6.38%** |

Speed-up about 1.06x total. The chat app path gains less (-4%) because ~30% of its time is in
`mdast-util-from-markdown` and the GFM extensions, outside this repo.

Size (`micromark.min.js`): min 52,872 → 52,843 (-29 B), gzip 14,687 → 14,674 (-13 B), brotli
13,125 → 13,123 (-2 B).

External cross-check (`test/perf.js` workloads, standalone, one process per revision, min of 5
cold runs): readme x1000 -7.3%, tons of definitions -13.9%, strong -4.7%. Three pathological inputs
looked slower cold (+6 to +16%); re-measured warm (7 timings after warm-up, 3 rounds, all four
commits) they are flat: base vs final 291/292, 299/315, 308/295 ms (strong/emphasis?), 82/79,
83/82, 84/79 ms (unclosed links). The cold numbers were single-shot noise. Standalone numbers
compare two processes, so they confirm direction, not size.

Instrument caveat: noise rose mid-campaign (Chrome load); bar raised from 1% to 1.5% after
recalibration, and every keep was confirmed with the stricter settings.

Left worth trying: attention openers-bottom bound (decision item), the per-event compile context
(decision item), a sorted-queue for subtokenize jumps (needs an ordering invariant), caching
`combineExtensions(defaultConstructs)` for extension-less parses (helps `micromark()` without
extensions, not the chat app path).

## Continuation (experiments 10 to 16, budget extended by the user)

10. **store() copies the stack with `slice`** (discard, neutral: V8 already fast-paths
    `Array.from` on packed arrays).
11. **resolveAllText merges data in one pass** (keep, asymptotic). Suite neutral (text blocks in
    the suite are short), but one long paragraph with many data breaks goes 278 → 51 ms (5.2x), and
    `test/perf.js` "unclosed links" 80 → 34 ms, "unclosed links (2)" 80 → 25 ms. Same pattern as
    merged #185. gzip +8 B.
12. **attention resolver on a SpliceBuffer** (discard): linear on long paragraphs, but `get()` on
    the walk-back made normal docs 4 to 5% slower.
13. **parse() without extensions copies pre-normalized defaults** (keep). Combining the default
    constructs walks ~40 integer-keyed maps with `for...in` on every parse. Entries are now
    normalized once at module load and copied into fresh objects. spec-html -15%, spec-tokens -18%
    (confirmed bands); larger docs flat (it is a fixed per-parse cost). **gzip +87 B.**
14. **compile() uses default handlers directly without extensions** (near miss: spec-html -4.9/-4.6
    but band straddles 0 in both runs).
15. **attention resolver splices in a working array** (keep, asymptotic). Walked events move into
    `left`, matches splice near its end, the unwalked tail never shifts; plain array reads. Suite
    neutral (within floor). 16k emphasis pairs 760 → 100 ms (7.5x). **gzip +47 B.**
16. **code-text resolver merges in one pass** (keep, asymptotic). Code span with 32k lines
    537 → 90 ms (6x). gzip +19 B.

"Keep (asymptotic)" means: suite neutral within the noise floor, large effect on a targeted input
measured standalone in two runs (far above cross-run drift), output identical on targeted long
inputs (HTML, GFM HTML, token events). The suite was not changed to show these effects.

Scaling scan after experiment 16 (time for 4x input): all in-repo shapes 3.3x to 5.2x (linear).
Remaining superlinear: GFM strikethrough 7.8x (other repo), and the attention walk-back on
`a**b` x n (openers-bottom decision item).

### Final numbers (1a5384a vs b9bef83, two runs)

| case | run 1 | run 2 |
|---|---|---|
| spec-html | -19.56% | -21.05% |
| spec-tokens | -21.65% | -22.24% |
| readme-html | -6.14% | -7.60% |
| pathological-html | -6.64% | -8.60% |
| chat-mdast-gfm (chat app) | -4.09% | -4.05% |
| chat-tokens-gfm | -4.20% | -4.26% |
| chat-html-gfm | -5.80% | -6.80% |
| chat-html-commonmark | -6.40% | -6.82% |
| stream-mdast-gfm (chat app) | -3.76% | -2.94% |
| **TOTAL** | **-7.04%** | **-7.50%** |
| **GEOMEAN** | **-8.94%** | **-9.64%** |

`test/perf.js` workloads, warm (min of 5 after warm-up), two rounds, pre-loop → final: unclosed
links 83/80 → 34/34 ms, unclosed links (2) 79/80 → 24/26 ms, tons of definitions 124/130 →
103/105 ms, strong 299/301 → 293/293 ms, strong/emphasis? 282/306 → 283/294 ms (flat), base flat.

Size `micromark.min.js`: min 52,872 → 53,267 (+395 B), gzip 14,687 → 14,835 (+148 B, +1.0%),
brotli 13,125 → 13,277 (+152 B). By change: exp 13 +87, exp 15 +47, exp 16 +19, exp 11 +8;
exps 1, 2, 6 together -13.
