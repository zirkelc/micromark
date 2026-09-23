/**
 * Machine-readiness probe. Run it before you calibrate and before every confirmation run.
 *
 *   node --import tsx perf/jitter.mts [--repeats 40]
 *
 * Times the same pure CPU loop many times and reports the spread. The loop cannot become faster
 * than its true cost, so the spread is what the machine adds: other load, frequency changes, or a
 * scheduler that moves the process between cores of different speed (Apple silicon, big.LITTLE).
 * When p50 sits far above the minimum, the two sides of an A/B run sample different machine states
 * and per-case deltas become unusable.
 *
 * The probe decides, not the load average: the average lags by design and says nothing about which
 * core the process gets. Exit code 1 means "too busy", so this can gate a script.
 */
import * as os from "node:os";
import { parseArgs } from "node:util";

const { values } = parseArgs({ args: process.argv.slice(2), options: { repeats: { type: "string" } } });
const REPEATS = Number(values.repeats ?? 40);

const times: Array<number> = [];
for (let r = 0; r < REPEATS; r++) {
  const start = process.hrtime.bigint();
  let x = 0;
  for (let i = 0; i < 20_000_000; i++) x = (x + i * 7) % 1_000_003;
  times.push(Number(process.hrtime.bigint() - start) / 1_000_000);
}
times.sort((a, b) => a - b);

const min = times[0];
const p50 = times[times.length >> 1];
const max = times[times.length - 1];
const spread = (p50 / min - 1) * 100;
const [load1] = os.loadavg();

console.log(`cores ${os.cpus().length}, load average (1 min) ${load1.toFixed(2)}`);
console.log(`cpu loop: min ${min.toFixed(1)} ms, p50 ${p50.toFixed(1)} ms, max ${max.toFixed(1)} ms`);
console.log(`p50 is ${spread.toFixed(1)}% above min`);

if (spread > 5) {
  console.log("BUSY: calibrate and measure later, or expect per-case noise of 10% and more.");
  process.exit(1);
}
console.log("OK: the machine is quiet enough to calibrate.");
