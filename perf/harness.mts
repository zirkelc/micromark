/**
 * Shared helpers for the micromark autoresearch harness: configuration, revision
 * materialisation, case loading and deterministic data helpers.
 *
 * micromark specifics:
 *
 * - Packages ship a production build (`index.js`, `lib/`) generated from `dev/` by
 *   `micromark-build` (unassert, undebug, inlined constants). The build is gitignored, so every
 *   materialised tree, including the working tree, is copied and built on its own. The harness
 *   always measures the production build, which is what users get without the `development`
 *   condition.
 * - Workspace packages import each other by name. Each tree gets its own `node_modules` with a
 *   symlink per workspace package into the tree, and real copies of the GFM and mdast packages
 *   that import micromark packages by name, so nothing resolves back to the working tree.
 * - Trees live under `node_modules/.perf-trees/`, out of reach of `tsc`, `xo`, `prettier` and
 *   `remark`. Node still resolves the remaining dependencies from the repo root `node_modules`.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** One benchmark workload. */
export interface PerfCase {
  /** Stable name, used as the key in reports and in the guard file. */
  name: string;
  /** Timed body. Must be deterministic and side-effect free across calls. */
  run: () => void;
  /** Serializable sample of observable behaviour, hashed by the guard. */
  collect: () => unknown;
  /** Optional: create and return one retained instance, measured by the memory harness. */
  alloc?: () => unknown;
  /** Optional: build the case's inputs just before it runs. */
  setup?: () => void;
  /** Optional: release what `setup` built. */
  teardown?: () => void;
}

/** A cases module exports this function. It receives the module namespace of the entry point. */
export type BuildCases = (lib: any) => Array<PerfCase>;

/** Pseudo revision that means "the working tree as it is on disk". */
export const WORKTREE = "WORKTREE";

export interface HarnessConfig {
  /** Absolute repo root. */
  root: string;
  /** Entry point, relative to a materialised tree. The harness writes it into every tree. */
  entry: string;
  /** Paths archived per revision, relative to the repo root. */
  src: Array<string>;
  /** Cases module, relative to the repo root. */
  cases: string;
}

const CONFIG_FILE = "perf.config.json";

/** Packages from the repo root `node_modules` that import micromark packages by name. */
const COPIED_DEPENDENCY = /^(micromark-extension-gfm|mdast-util-from-markdown$|mdast-util-gfm)/;

/**
 * Reads `perf.config.json` next to the harness scripts, then applies CLI flags on top.
 * Returns the resolved config and the remaining positional arguments.
 */
export function loadConfig(
  harnessDir: string,
  argv: Array<string>,
  extraOptions: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {}
): { config: HarnessConfig; positionals: Array<string>; values: Record<string, any> } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      entry: { type: "string" },
      src: { type: "string", multiple: true },
      cases: { type: "string" },
      ...extraOptions,
    },
  });

  const configPath = path.join(harnessDir, CONFIG_FILE);
  const fileConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};

  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: harnessDir }).toString().trim();
  const entry = (values.entry as string | undefined) ?? fileConfig.entry;
  const src = (values.src as Array<string> | undefined) ?? fileConfig.src;
  const cases = (values.cases as string | undefined) ?? fileConfig.cases ?? path.relative(root, path.join(harnessDir, "cases.mts"));

  if (!entry || !src?.length) {
    throw new Error(`Set "entry" and "src" in ${configPath} or pass --entry and --src.`);
  }
  return { config: { root, entry, src, cases }, positionals, values };
}

/**
 * Packs the `src` paths of `rev` as a tar buffer and returns it with a content key. For the working
 * tree, the key is a hash of every tracked or untracked, non-ignored file, so an edit gives a new
 * tree and an unchanged working tree reuses its build.
 */
function pack(config: HarnessConfig, rev: string): { key: string; tar: Buffer } {
  if (rev !== WORKTREE) {
    const sha = execFileSync("git", ["rev-parse", `${rev}^{commit}`], { cwd: config.root }).toString().trim();
    const tar = execFileSync("git", ["archive", "--format=tar", sha, "--", ...config.src], {
      cwd: config.root,
      maxBuffer: 1 << 30,
    });
    return { key: sha, tar };
  }

  const files = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard", "--", ...config.src], {
    cwd: config.root,
    maxBuffer: 1 << 30,
  })
    .toString()
    .split("\0")
    .filter((f) => f && fs.existsSync(path.join(config.root, f)))
    .sort();
  const hash = createHash("sha1");
  for (const f of files) {
    hash.update(f);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(config.root, f)));
    hash.update("\0");
  }
  const tar = execFileSync("tar", ["-c", "--null", "-T", "-"], {
    cwd: config.root,
    input: files.join("\0"),
    maxBuffer: 1 << 30,
  });
  return { key: `wt-${hash.digest("hex").slice(0, 16)}`, tar };
}

/**
 * Unpacks `src` paths of `rev` into `node_modules/.perf-trees/<key>-<slot>`, wires the tree's own
 * `node_modules`, builds the production files, and returns the absolute entry path in that tree.
 * One directory per slot means that comparing a revision with itself still loads two separate
 * module instances.
 */
export function materialise(config: HarnessConfig, rev: string, slot: string): string {
  const { key, tar } = pack(config, rev);
  const treesDir = path.join(config.root, "node_modules", ".perf-trees");
  const dir = path.join(treesDir, `${key}-${slot}`);

  if (!fs.existsSync(dir)) {
    const tmp = `${dir}.tmp-${process.pid}`;
    fs.mkdirSync(tmp, { recursive: true });
    execFileSync("tar", ["-x", "-C", tmp], { input: tar });
    wireNodeModules(config, tmp);
    build(config, tmp);
    fs.writeFileSync(
      path.join(tmp, config.entry),
      [
        "export * from './packages/micromark/index.js'",
        "export {gfm, gfmHtml} from 'micromark-extension-gfm'",
        "export {fromMarkdown} from 'mdast-util-from-markdown'",
        "export {gfmFromMarkdown} from 'mdast-util-gfm'",
        "",
      ].join("\n")
    );
    fs.renameSync(tmp, dir);
  }
  return path.join(dir, config.entry);
}

/** Links every workspace package into the tree's `node_modules` and copies the dependents of them. */
function wireNodeModules(config: HarnessConfig, treeDir: string): void {
  const modules = path.join(treeDir, "node_modules");
  fs.mkdirSync(modules, { recursive: true });
  for (const name of fs.readdirSync(path.join(treeDir, "packages"))) {
    fs.symlinkSync(path.join("..", "packages", name), path.join(modules, name), "dir");
  }
  const rootModules = path.join(config.root, "node_modules");
  for (const name of fs.readdirSync(rootModules)) {
    if (!COPIED_DEPENDENCY.test(name)) continue;
    fs.cpSync(path.join(rootModules, name), path.join(modules, name), { recursive: true, dereference: true });
  }
}

/**
 * Runs the repo's production build (`micromark-build`) in every package of the tree that has one,
 * in the workspace order of the root manifest: inlining constants reads the built files of
 * dependencies, so they must exist first.
 */
function build(config: HarnessConfig, treeDir: string): void {
  const tool = path.join(config.root, "packages", "micromark-build", "index.js");
  const workspaces: Array<string> = JSON.parse(fs.readFileSync(path.join(config.root, "package.json"), "utf8")).workspaces;
  for (const workspace of workspaces) {
    const pkgDir = path.join(treeDir, workspace);
    if (!fs.existsSync(pkgDir)) continue;
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    if (manifest.scripts?.build !== "micromark-build") continue;
    execFileSync(process.execPath, [tool], { cwd: pkgDir, stdio: "ignore" });
  }
}

/**
 * Imports the entry module and builds the cases against it.
 *
 * `slot` gives this side its own instance of the cases module. Without it both revisions share one
 * instance, so every case function sees two hidden-class families and can report a large, stable
 * delta for code that neither revision touched.
 */
export async function loadCases(config: HarnessConfig, entryPath: string, slot?: string): Promise<Array<PerfCase>> {
  const lib = await import(pathToFileURL(entryPath).href);
  const casesUrl = pathToFileURL(path.join(config.root, config.cases)).href;
  const casesModule = await import(slot ? `${casesUrl}?slot=${slot}` : casesUrl);
  const build: BuildCases | undefined = casesModule.buildCases;
  if (typeof build !== "function") throw new Error(`${config.cases} must export buildCases(lib).`);
  return build(lib);
}

/** mulberry32 PRNG, for seeded and reproducible benchmark inputs. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** FNV-1a 32-bit hash of a string. */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Wall-clock duration of `fn` in nanoseconds. */
export function timeNs(fn: () => void): number {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start);
}
