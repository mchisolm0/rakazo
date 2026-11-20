// `pnpm verify:stack <command>`: a disposable Rakazo, started from this checkout, for driving a
// change the way a user would. See .agents/skills/verify-rakazo/SKILL.md.
//
//   up [--pg <server url>]    start one: its own Postgres, ports, data dir, and offline providers
//   doctor [--run <id>]       read-only check that the run is up and is the one it claims to be
//   drive <script> [--run <id>] [--headed]
//                             run a drive script in Chromium and keep its evidence
//   sql "<query>" [--run <id>]
//                             read-only query against the run's database, printed as JSON
//   down [--run <id>]         stop the run and delete its database and data, keeping evidence
//
// `up` hands the stack to a detached supervisor (`serve`), which owns the database, `pnpm dev`,
// and their teardown, so a later command or a crashed shell never strands either.
import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserContext, expect, Page } from "@playwright/test";
import { pollUntil } from "@rakazo/core";
import { createPool } from "@rakazo/db";
import { spawnPnpm } from "../../../../scripts/pnpm.mjs";
import {
  argument,
  benchmarkEnvironment,
  repositoryRoot as root,
} from "../performance/performance-stack.js";
import { startPostgres } from "./postgres.js";

const REPORTS = path.join(root, "verify-report");
const ACCOUNT = { email: "verify@rakazo.test", password: "verify-password-1234", name: "Verify" };
const RUNTIME_LOGIN = { user: "rakazo_verify", password: "rakazo-verify-runtime" };
// First start compiles the Prisma client and runs every migration before the servers listen.
const READY_TIMEOUT_MS = 300_000;

export type RunState = {
  id: string;
  dir: string;
  supervisorPid: number;
  devPid?: number;
  head: string;
  webUrl: string;
  apiUrl: string;
  /** Owner login; the servers connect as the runtime login, so row-level security applies. */
  migrationUrl: string;
  database: { kind: "container" } | { kind: "server"; serverUrl: string };
  account: typeof ACCOUNT;
  status: "starting" | "ready" | "failed" | "stopped";
  error?: string;
};

/** What a drive script's default export receives. */
export type Drive = {
  page: Page;
  context: BrowserContext;
  expect: typeof expect;
  run: RunState;
  /** This drive's evidence folder. */
  dir: string;
  /** Saves `<name>.png` and `<name>.aria.txt` of the page as it is now. */
  capture: (name: string) => Promise<void>;
  /** Signs in the account `up` created, then opens the app. */
  signIn: () => Promise<void>;
  /** Creates a new account through the sign-up form, as a person would. */
  signUp: () => Promise<{ email: string; password: string }>;
  /** Mail the server's email emulator has captured. */
  emails: () => Promise<unknown[]>;
};

const statePath = (dir: string) => path.join(dir, "state.json");
const readState = (dir: string): RunState => JSON.parse(readFileSync(statePath(dir), "utf8"));
// Written whole and renamed, so a reader never sees half a file.
async function writeState(state: RunState) {
  const temporary = `${statePath(state.dir)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, statePath(state.dir));
}

function alive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `--run <id>`, or the newest run whose supervisor is still alive. */
function selectRun(): RunState {
  const id = argument("--run");
  if (id) return readState(path.join(REPORTS, id));
  const runs = existsSync(REPORTS)
    ? readdirSync(REPORTS)
        .map((name) => path.join(REPORTS, name))
        .filter((dir) => existsSync(statePath(dir)))
        .sort((a, b) => statSync(statePath(b)).mtimeMs - statSync(statePath(a)).mtimeMs)
        .map(readState)
    : [];
  const live = runs.find((run) => alive(run.supervisorPid));
  if (!live) throw new Error("No running verify stack. Start one with `pnpm verify:stack up`.");
  return live;
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(),
      );
    });
  });
}

async function answers(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function query<T>(url: string, sql: string, values: unknown[] = []): Promise<T[]> {
  const pool = createPool(url);
  try {
    return (await pool.query(sql, values)).rows as T[];
  } finally {
    await pool.end();
  }
}

function withDatabase(url: string, name: string, login?: { user: string; password: string }) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  if (login) {
    parsed.username = login.user;
    parsed.password = login.password;
  }
  return parsed.href;
}

const databaseName = (url: string) => new URL(url).pathname.slice(1);

async function up() {
  const id = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${Math.random().toString(16).slice(2, 6)}`;
  const dir = path.join(REPORTS, id);
  await mkdir(dir, { recursive: true });
  const log = openSync(path.join(dir, "stack.log"), "a");
  const args = [...process.execArgv, process.argv[1]!, "serve", id];
  const pg = argument("--pg") ?? process.env.VERIFY_PG_URL;
  if (pg) args.push("--pg", pg);
  const supervisor = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
  });
  supervisor.unref();
  console.log(`Starting run ${id} (logs in ${path.relative(root, dir)})`);
  const state = await pollUntil(
    () => {
      if (existsSync(statePath(dir))) {
        const current = readState(dir);
        if (current.status !== "starting") return current;
      }
      if (!alive(supervisor.pid)) return { status: "failed", error: "supervisor exited" } as const;
      return undefined;
    },
    { intervalMs: 1_000, timeoutMs: READY_TIMEOUT_MS + 30_000, waitingFor: "the stack to start" },
  );
  if (state.status !== "ready") {
    const tail = readFileSync(path.join(dir, "stack.log"), "utf8").split("\n").slice(-40);
    throw new Error(`Run ${id} did not start: ${state.error}\n${tail.join("\n")}`);
  }
  console.log(
    [
      `Ready: ${state.webUrl}`,
      `Sign in as ${ACCOUNT.email} / ${ACCOUNT.password}`,
      `Run id ${id}. Stop it with: pnpm verify:stack down --run ${id}`,
    ].join("\n"),
  );
}

async function serve(id: string) {
  const dir = path.join(REPORTS, id);
  const serverUrl = argument("--pg");
  const [webPort, apiPort, supervisorPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  const dataDir = path.join(dir, "data");
  const stops: Array<() => Promise<unknown>> = [];
  let dev: ChildProcess | undefined;
  let state: RunState | undefined;
  let stopping = false;
  const stopped = new AbortController();

  const teardown = async (status: RunState["status"], error?: string) => {
    if (stopping) return;
    stopping = true;
    if (dev?.pid) {
      // pnpm and turbo give each server a process group of its own, so signal every process.
      const tree = [dev.pid, ...descendants(dev.pid)];
      signal(tree, "SIGTERM");
      await pollUntil(() => !tree.some(alive), {
        intervalMs: 250,
        timeoutMs: 15_000,
        onTimeout: () => false,
      });
      signal(tree.filter(alive), "SIGKILL");
    }
    for (const stop of stops.reverse()) {
      await stop().catch((cause) => console.error("teardown step failed", cause));
    }
    await rm(dataDir, { recursive: true, force: true });
    await rm(path.join(dir, ".rakazo-dev-branches"), { recursive: true, force: true });
    if (state) await writeState({ ...state, status, ...(error ? { error } : {}) });
    stopped.abort();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void teardown("stopped"));
  }

  try {
    let migrationUrl: string;
    if (serverUrl) {
      const name = `rakazo_verify_${id.replace(/\W/g, "_").toLowerCase()}`;
      await query(serverUrl, `CREATE DATABASE "${name}"`);
      // dev.mjs gives a branch with unmerged migrations its own copy, named after this one.
      stops.push(async () => {
        const rows = await query<{ datname: string }>(
          serverUrl,
          "SELECT datname FROM pg_database WHERE datname LIKE $1",
          [`${name}%`],
        );
        for (const row of rows) {
          await query(serverUrl, `DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
        }
      });
      migrationUrl = withDatabase(serverUrl, name);
    } else {
      // Always its own container: a CI_POSTGRES_URL server can be shared with other runs.
      delete process.env.CI_POSTGRES_URL;
      const container = await startPostgres();
      stops.push(() => container.stop());
      migrationUrl = container.getConnectionUri();
    }
    const runtimeUrl = withDatabase(migrationUrl, databaseName(migrationUrl), RUNTIME_LOGIN);
    const webUrl = `http://127.0.0.1:${webPort}`;
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    state = {
      id,
      dir,
      supervisorPid: process.pid,
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      webUrl,
      apiUrl,
      migrationUrl,
      database: serverUrl ? { kind: "server", serverUrl } : { kind: "container" },
      account: ACCOUNT,
      status: "starting",
    };
    await writeState(state);

    const env: NodeJS.ProcessEnv = {
      ...benchmarkEnvironment({ databaseUrl: runtimeUrl, webPort, apiPort, dataDir }),
      DATABASE_MIGRATION_URL: migrationUrl,
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      // Only this environment: a worktree's copied .env can hold real provider keys.
      RAKAZO_ENV_FILE: "none",
      RAKAZO_DEV_RUN_WITH: "",
      RAKAZO_DEV_TAILNET: "",
      API_HOST: "127.0.0.1",
      SUPERVISOR_PORT: String(supervisorPort),
      SANDBOX_SUPERVISOR_URL: `http://127.0.0.1:${supervisorPort}`,
      EMAIL_EMULATOR: "true",
      PAYMENT_WALLET_PROVIDER: "emulator",
      VITE_DEFAULT_UI_LOCALE: "en",
    };
    const devLog = openSync(path.join(dir, "dev.log"), "a");
    dev = spawnPnpm(["dev"], { cwd: root, env, stdio: ["ignore", devLog, devLog] });
    state = { ...state, devPid: dev.pid };
    await writeState(state);
    dev.once("exit", (code, signal) => {
      void teardown("failed", `pnpm dev exited (${signal ?? code}); see dev.log`);
    });

    await pollUntil(
      async () => stopping || ((await answers(`${apiUrl}/health`)) && (await answers(webUrl))),
      {
        intervalMs: 1_000,
        timeoutMs: READY_TIMEOUT_MS,
        waitingFor: "the API and web servers",
      },
    );
    if (stopping) return;
    // Through the web server, as the browser signs up, so the proxy and auth are proven too.
    const signup = await fetch(`${webUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: webUrl },
      body: JSON.stringify(ACCOUNT),
    });
    if (!signup.ok)
      throw new Error(`Seeding ${ACCOUNT.email} failed: ${signup.status} ${await signup.text()}`);
    state = { ...state, status: "ready" };
    await writeState(state);
    console.log(`ready at ${webUrl}`);
  } catch (error) {
    console.error(error);
    await teardown("failed", error instanceof Error ? error.message : String(error));
  }
  if (!stopped.signal.aborted) {
    await new Promise((resolve) => stopped.signal.addEventListener("abort", resolve));
  }
  process.exit(0);
}

async function doctor() {
  const run = selectRun();
  const results: Array<[string, boolean, string?]> = [];
  const check = (name: string, ok: boolean, detail?: string) => results.push([name, ok, detail]);

  check("run is ready", run.status === "ready", run.status);
  check("supervisor is alive", alive(run.supervisorPid), `pid ${run.supervisorPid}`);
  check("pnpm dev is alive", alive(run.devPid), `pid ${run.devPid}`);
  const ours = new Set(descendants(run.supervisorPid).map(String));
  for (const [label, url] of [
    ["web", run.webUrl],
    ["api", run.apiUrl],
  ] as const) {
    const port = new URL(url).port;
    const listeners = lsof(port);
    check(
      `${label} port ${port} belongs to this run`,
      listeners.length > 0 && listeners.every((pid) => ours.has(pid)),
      listeners.length ? `listening pids ${listeners.join(",")}` : "nothing listening",
    );
  }
  check("api /health answers", await answers(`${run.apiUrl}/health`));
  check("web proxies auth to the api", await answers(`${run.webUrl}/api/auth/ok`));

  const expected = readdirSync(path.join(root, "packages/db/prisma/migrations"), {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory()).length;
  // dev.mjs moves a branch with unmerged migrations to a copy named after this run's database.
  const databases = await query<{ datname: string }>(
    run.migrationUrl,
    "SELECT datname FROM pg_database WHERE datname LIKE $1",
    [`${databaseName(run.migrationUrl)}%`],
  );
  const applied = await Promise.all(
    databases.map(async ({ datname }) => {
      const [row] = await query<{ count: string }>(
        withDatabase(run.migrationUrl, datname),
        "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
      ).catch(() => [{ count: "0" }]);
      return Number(row?.count ?? 0);
    }),
  );
  check(
    "every migration in this checkout applied",
    applied.includes(expected),
    `${applied.join(",")} of ${expected}`,
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  console.log(
    `run ${run.id}  ${run.webUrl}  started at ${run.head.slice(0, 9)}, HEAD ${head.slice(0, 9)}`,
  );
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  }
  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
}

/** Every process started under `pid`, read from `ps`. */
function descendants(pid: number) {
  const children = new Map<number, number[]>();
  for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).split(
    "\n",
  )) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child && parent) children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const queue = [pid];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function signal(pids: number[], name: NodeJS.Signals) {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // Already gone.
    }
  }
}

function lsof(port: string) {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function drive(script: string | undefined) {
  if (!script)
    throw new Error("Usage: pnpm verify:stack drive <script.ts> [--run <id>] [--headed]");
  const run = selectRun();
  if (run.status !== "ready") throw new Error(`Run ${run.id} is ${run.status}, not ready`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const dir = path.join(
    run.dir,
    "drives",
    `${path.basename(script).replace(/\.[^.]+$/, "")}-${stamp}`,
  );
  await mkdir(dir, { recursive: true });
  // Only drives need a browser.
  const playwright = await import("@playwright/test");
  const { default: journey } = (await import(pathToFileURL(path.resolve(script)).href)) as {
    default: (drive: Drive) => Promise<void>;
  };
  const browser = await playwright.chromium.launch({
    headless: !process.argv.includes("--headed"),
  });
  const context = await browser.newContext({
    baseURL: run.webUrl,
    viewport: { width: 1440, height: 900 },
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const consoleLines: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      consoleLines.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleLines.push(`pageerror: ${error.message}`));
  const capture = async (name: string) => {
    await page.screenshot({
      path: path.join(dir, `${name}.png`),
      animations: "disabled",
      caret: "hide",
    });
    await writeFile(path.join(dir, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
  };
  const origin = { origin: run.webUrl };
  let failure: unknown;
  try {
    await journey({
      page,
      context,
      expect: playwright.expect,
      run,
      dir,
      capture,
      async signIn() {
        const response = await context.request.post("/api/auth/sign-in/email", {
          data: { email: run.account.email, password: run.account.password },
          headers: origin,
        });
        if (!response.ok())
          throw new Error(`sign-in ${response.status()}: ${await response.text()}`);
        await page.goto("/app");
      },
      async signUp() {
        const email = `verify-${Date.now()}@rakazo.test`;
        const password = "verify-password-1234";
        await page.goto("/sign-up");
        const continueWithEmail = page.getByRole("button", { name: "Continue with email" });
        const name = page.getByPlaceholder("Your name");
        await playwright.expect(name.or(continueWithEmail)).toBeVisible();
        if (await continueWithEmail.isVisible()) await continueWithEmail.click();
        await name.fill("Verify User");
        await page.getByPlaceholder("Your email address").fill(email);
        await page.getByPlaceholder("Password").fill(password);
        await page.getByRole("button", { name: "Create account" }).click();
        return { email, password };
      },
      async emails() {
        return (await context.request.get(`${run.apiUrl}/api/dev/emails`)).json();
      },
    });
  } catch (error) {
    failure = error;
  }
  await capture("final").catch((error) => consoleLines.push(`final capture failed: ${error}`));
  await context.tracing.stop({ path: path.join(dir, "trace.zip") });
  await writeFile(path.join(dir, "console.txt"), `${consoleLines.join("\n")}\n`);
  await browser.close();
  console.log(`Evidence: ${path.relative(root, dir)}`);
  if (failure) throw failure;
}

async function sql(text: string | undefined) {
  if (!text) throw new Error('Usage: pnpm verify:stack sql "<query>" [--run <id>]');
  const run = selectRun();
  const url = new URL(run.migrationUrl);
  url.searchParams.set("options", "-c default_transaction_read_only=on");
  console.log(JSON.stringify(await query(url.href, text), null, 2));
}

async function down() {
  const run = selectRun();
  if (alive(run.supervisorPid)) process.kill(run.supervisorPid, "SIGTERM");
  await pollUntil(() => !alive(run.supervisorPid), {
    intervalMs: 500,
    timeoutMs: 60_000,
    waitingFor: `run ${run.id} to stop`,
  });
  console.log(`Stopped run ${run.id}. Evidence kept in ${path.relative(root, run.dir)}`);
}

const [command, target] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  up,
  serve: () => serve(target!),
  doctor,
  drive: () => drive(target),
  sql: () => sql(target),
  down,
};
const selected = command ? commands[command] : undefined;
if (!selected) {
  console.error(
    "Usage: pnpm verify:stack <up|doctor|drive|sql|down> (see .agents/skills/verify-rakazo)",
  );
  process.exit(2);
}
selected().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
