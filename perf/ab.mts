/**
 * Paired A/B timing of two git revisions.
 *
 *   node --import tsx perf/ab.mts [revA=HEAD] [revB=WORKTREE] [--iters 25] [--repeats 1]
 *
 * Both revisions are imported into one process and timed in strict alternation. A and B run back to
 * back inside one iteration, so they share the same machine state: the delta is the median of their
 * per-iteration ratios, which keeps the pairing that makes this method work. The absolute
 * milliseconds are the per-side minima. Module instances carry a stable load-order bias, so every
 * measurement runs in child processes for both load orders, combined with a geometric mean.
 * Negative delta = revB is faster.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type PerfCase, WORKTREE, loadCases, loadConfig, materialise, timeNs } from "./harness.mts";

interface Row {
  name: string;
  /** Minimum ns per case body for the module loaded first. */
  first: number;
  /** Minimum ns per case body for the module loaded second. */
  second: number;
  /** Median over iterations of (second / first), each pair timed back to back. */
  ratio: number;
  /** Ratio at the 25th and 75th percentile: how stable this case's delta is. */
  p25: number;
  p75: number;
}

const HARNESS_DIR = import.meta.dirname;
const { config, positionals, values } = loadConfig(HARNESS_DIR, process.argv.slice(2), {
  iters: { type: "string" },
  warmup: { type: "string" },
  "target-ms": { type: "string" },
  repeats: { type: "string" },
  child: { type: "boolean" },
});

/** Tune ITERS and REPEATS in step 4, against this machine and the session's time budget. */
const ITERS = Number(values.iters ?? 25);
const WARMUP = Number(values.warmup ?? 3);
const TARGET_NS = Number(values["target-ms"] ?? 1.5) * 1_000_000;
const REPEATS = Number(values.repeats ?? 1);

/** Children are spawned with `--expose-gc`; a missing flag degrades to a no-op. */
const gc: () => void = (globalThis as { gc?: () => void }).gc ?? (() => {});

function quantile(sorted: Array<number>, q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Runs inside a child process: times the two entries loaded in the given order. */
async function measure(entryFirst: string, entrySecond: string): Promise<Array<Row>> {
  const casesFirst = await loadCases(config, entryFirst, "first");
  const casesSecond = await loadCases(config, entrySecond, "second");
  const rows: Array<Row> = [];

  for (let i = 0; i < casesFirst.length; i++) {
    const a: PerfCase = casesFirst[i];
    const b: PerfCase = casesSecond[i];
    if (a.name !== b.name) throw new Error(`Case order differs: ${a.name} vs ${b.name}`);
    a.setup?.();
    b.setup?.();

    /** JIT warm-up on the raw bodies, then size each timed run to about TARGET_NS. Slow bodies
     * are already long enough after a few probes, so stop early instead of running ten of them. */
    let probe = Number.POSITIVE_INFINITY;
    for (let w = 0; w < 10 && !(w >= 3 && probe > 20_000_000); w++) {
      probe = Math.min(probe, timeNs(a.run));
      b.run();
    }
    const reps = Math.max(1, Math.round(TARGET_NS / probe));
    const runA = () => {
      for (let r = 0; r < reps; r++) a.run();
    };
    const runB = () => {
      for (let r = 0; r < reps; r++) b.run();
    };

    for (let w = 0; w < WARMUP; w++) {
      runA();
      runB();
    }

    /** A collection triggered by one side's garbage must not land in the other side's timing, so
     * collect before every timed body. Never inside one. */
    const timeA = () => (gc(), timeNs(runA));
    const timeB = () => (gc(), timeNs(runB));

    let minA = Number.POSITIVE_INFINITY;
    let minB = Number.POSITIVE_INFINITY;
    const ratios: Array<number> = [];
    for (let iter = 0; iter < ITERS; iter++) {
      let tA: number;
      let tB: number;
      if (iter % 2 === 0) {
        tA = timeA();
        tB = timeB();
      } else {
        tB = timeB();
        tA = timeA();
      }
      minA = Math.min(minA, tA);
      minB = Math.min(minB, tB);
      ratios.push(tB / tA);
    }
    ratios.sort((x, y) => x - y);
    a.teardown?.();
    b.teardown?.();
    rows.push({
      name: a.name,
      first: minA / reps,
      second: minB / reps,
      ratio: quantile(ratios, 0.5),
      p25: quantile(ratios, 0.25),
      p75: quantile(ratios, 0.75),
    });
  }
  return rows;
}

function child(entryFirst: string, entrySecond: string): Array<Row> {
  const self = fileURLToPath(import.meta.url);
  const passthrough = ["--iters", String(ITERS), "--warmup", String(WARMUP), "--target-ms", String(TARGET_NS / 1_000_000)];
  const res = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      "--expose-gc",
      self,
      "--child",
      ...passthrough,
      "--entry",
      config.entry,
      "--cases",
      config.cases,
      ...config.src.flatMap((s) => ["--src", s]),
      entryFirst,
      entrySecond,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
  );
  if (res.status !== 0) throw new Error(`child failed:\n${res.stderr}`);
  const lines = res.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

/** Combines repeated children of the same load order: minima for the absolute numbers, geometric
 * mean for the ratios, widest band for the dispersion. */
function combine(runs: Array<Array<Row>>): Array<Row> {
  const geo = (xs: Array<number>) => Math.exp(xs.reduce((sum, x) => sum + Math.log(x), 0) / xs.length);
  return runs[0].map((row, i) => ({
    name: row.name,
    first: Math.min(...runs.map((r) => r[i].first)),
    second: Math.min(...runs.map((r) => r[i].second)),
    ratio: geo(runs.map((r) => r[i].ratio)),
    p25: Math.min(...runs.map((r) => r[i].p25)),
    p75: Math.max(...runs.map((r) => r[i].p75)),
  }));
}

if (values.child) {
  const rows = await measure(positionals[0], positionals[1]);
  console.log(JSON.stringify(rows));
} else {
  const revA = positionals[0] ?? "HEAD";
  const revB = positionals[1] ?? WORKTREE;
  const entryA = materialise(config, revA, "a");
  const entryB = materialise(config, revB, "b");

  /** orderAB: A loaded first. orderBA: B loaded first. */
  const orderAB = combine(Array.from({ length: REPEATS }, () => child(entryA, entryB)));
  const orderBA = combine(Array.from({ length: REPEATS }, () => child(entryB, entryA)));

  const ms = (ns: number) => (ns / 1_000_000).toFixed(4).padStart(10);
  const pct = (ratio: number) => `${((ratio - 1) * 100).toFixed(2).padStart(7)}%`;
  const speedup = (ratio: number) => `${(1 / ratio).toFixed(2).padStart(6)}x`;

  console.log(
    `A = ${revA}, B = ${revB} (min ms of ${ITERS} iters; delta = median of paired ratios; ${REPEATS} children x 2 load orders)`
  );
  console.log(`${"case".padEnd(26)}${"A".padStart(10)}${"B".padStart(10)}${"delta".padStart(9)}${"band".padStart(17)}${"speed".padStart(8)}`);

  let sumA = 0;
  let sumB = 0;
  let logSum = 0;
  for (let i = 0; i < orderAB.length; i++) {
    const ab = orderAB[i];
    const ba = orderBA[i];
    /** orderAB measured B/A, orderBA measured A/B: the geometric mean cancels the load-order bias. */
    const ratio = Math.sqrt(ab.ratio / ba.ratio);
    /** Widest interquartile band of the two orders, expressed as a delta range. */
    const lo = (Math.min(ab.p25, 1 / ba.p75) - 1) * 100;
    const hi = (Math.max(ab.p75, 1 / ba.p25) - 1) * 100;
    /**
     * Two markers, two different questions, both about this run and not about the change. `?`: the
     * band contains 0%, so the iterations disagree about the direction and this run does not
     * confirm the row. `~`: the band is wide against the size of the median, which is the signature
     * of an in-process artefact or of a case too short to time. Both are hints to confirm (second
     * run, or `solo.mts`), never a reason to discard on their own.
     */
    const straddles = lo < 0 && hi > 0;
    const medianPct = (ratio - 1) * 100;
    /** `?` wins when both apply: a band around zero is wide against its own median almost by
     * definition, so printing both would mark nearly every noise row. `~` alone is the signal that
     * matters: a median that looks confident carried by iterations that do not agree. */
    const wide = !straddles && hi - lo > 2 * Math.abs(medianPct);
    const marker = straddles ? "?" : wide ? "~" : " ";
    logSum += Math.log(ratio);
    const a = (ab.first + ba.second) / 2;
    sumA += a;
    sumB += a * ratio;
    const band = `${lo >= 0 ? "+" : ""}${lo.toFixed(1)}..${hi >= 0 ? "+" : ""}${hi.toFixed(1)}%${marker}`;
    console.log(`${ab.name.padEnd(26)}${ms(a)}${ms(a * ratio)} ${pct(ratio)}${band.padStart(17)}${speedup(ratio)}`);
  }

  /** TOTAL weights each case by its time, GEOMEAN weights every case equally. Gate on both: a
   * disagreement means the effect is concentrated in one case and needs a per-case look. */
  const totalRatio = sumB / sumA;
  const geo = Math.exp(logSum / orderAB.length);
  console.log(`${"TOTAL".padEnd(26)}${ms(sumA)}${ms(sumA * totalRatio)} ${pct(totalRatio)}${"".padStart(17)}${speedup(totalRatio)}`);
  console.log(`${"GEOMEAN".padEnd(46)} ${pct(geo)}${"".padStart(17)}${speedup(geo)}`);
  console.log(
    `(band = interquartile range of per-iteration deltas; "?" = this run does not confirm the direction; "~" = band wide against its median; either: confirm with a second run or solo.mts)`
  );
}
