/**
 * Standalone timing of one case against one revision, in a process of its own.
 *
 *   node --import tsx --expose-gc perf/solo.mts <rev|WORKTREE> <case> [--iters 25]
 *
 * The A/B harness loads two revisions into one process, which is what makes it precise, but the
 * library's own objects are then polymorphic in shared code. That can produce a stable, repeatable
 * delta on a case whose code neither revision changed. Before you report, act on, or discard for a
 * per-case regression, run it here for both revisions: one revision per process, nothing shared.
 */
import { WORKTREE, loadCases, loadConfig, materialise } from "./harness.mts";

const HARNESS_DIR = import.meta.dirname;
const { config, positionals, values } = loadConfig(HARNESS_DIR, process.argv.slice(2), {
  iters: { type: "string" },
});
const ITERS = Number(values.iters ?? 25);
const rev = positionals[0] ?? WORKTREE;
const name = positionals[1];
if (!name) throw new Error("Usage: solo.mts <rev|WORKTREE> <case>");

const gc: () => void = (globalThis as { gc?: () => void }).gc ?? (() => {});
const cases = await loadCases(config, materialise(config, rev, "solo"), "solo");
const perfCase = cases.find((c) => c.name === name);
if (!perfCase) throw new Error(`No case ${name}. Known: ${cases.map((c) => c.name).join(", ")}`);

perfCase.setup?.();
for (let w = 0; w < 5; w++) perfCase.run();

let min = Number.POSITIVE_INFINITY;
for (let i = 0; i < ITERS; i++) {
  gc();
  const start = process.hrtime.bigint();
  perfCase.run();
  min = Math.min(min, Number(process.hrtime.bigint() - start) / 1_000_000);
}
perfCase.teardown?.();

console.log(`${name} @ ${rev}: min ${min.toFixed(2)} ms of ${ITERS} iterations`);
