import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import type { Quiescence } from "../hosts/contracts";

/** Host-only executor for fixed suite commands. Never expose argv to the reviewer.
 * Cooperative POSIX process groups, not a sandbox against hostile test programs.
 * The preload records detached Node children (including ttyd and Playwright) before
 * the spawning JS returns; ordinary descendants remain in an owned group. */
export interface ReviewCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  log: string;
}
export interface ReviewCommandResult {
  status: "passed" | "finding" | "not-verified";
  evidence: string;
  quiescence: Quiescence;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const MAX_LOG = 4 * 1024 * 1024;

export async function runReviewCommand(command: ReviewCommand, signal: AbortSignal): Promise<ReviewCommandResult> {
  const quiet = (evidence: string): Quiescence => ({ state: "verified", evidence: [evidence] });
  if (!["darwin", "linux"].includes(process.platform)) return { status: "not-verified", evidence: "Fixed review suites require POSIX process groups (macOS/Linux).", quiescence: quiet("No process launched.") };
  if (signal.aborted) return { status: "not-verified", evidence: "Review cancelled before test launch.", quiescence: quiet("No process launched.") };
  fs.mkdirSync(path.dirname(command.log), { recursive: true });
  const journal = command.log + ".children.jsonl", preload = command.log + ".preload.cjs";
  fs.writeFileSync(journal, "");
  fs.writeFileSync(preload, `// Host-created process accounting; never loaded from the repository.\nconst fs=require('node:fs'),cp=require('node:child_process');\nconst original=cp.ChildProcess.prototype.spawn;\ncp.ChildProcess.prototype.spawn=function(options){const r=original.call(this,options);if(this.pid)fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify({pid:this.pid,detached:!!options.detached,at:Date.now()})+'\\n');return r;};\nfor(const name of ['spawnSync','execSync','execFileSync']){const f=cp[name];cp[name]=function(...args){if(args.some(x=>x&&typeof x==='object'&&!Array.isArray(x)&&x.detached))throw Error('Detached synchronous processes are not supported by review suites');return f.apply(this,args);};}\nrequire('node:module').syncBuiltinESMExports();\n`);
  const fd = fs.openSync(command.log, "w", 0o600);
  let written = 0, overflow = false, closed = false, code: number | null = null, error: string | undefined, logError: string | undefined;
  let stopped: boolean = false, timedOut = false;
  const stop = () => { stopped = true; };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => { timedOut = stopped = true; }, command.timeoutMs);
  const start = Date.now();
  const child = spawn(command.executable, command.args, { cwd: command.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...command.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } });
  child.on("error", e => { error = e.message; });
  child.on("close", c => { code = c; closed = true; });
  const output = (data: Buffer) => {
    if (logError) return;
    try {
      const remaining = MAX_LOG - written;
      if (remaining > 0) { const chunk = data.subarray(0, remaining); fs.writeSync(fd, chunk); written += chunk.length; }
      if (data.length > remaining) overflow = stopped = true;
    } catch (e) {
      logError = `Test log write failed: ${e instanceof Error ? e.message : String(e)}`;
      stopped = true; // Join children before returning; never throw from a pipe event.
    }
  };
  child.stdout.on("data", output); child.stderr.on("data", output);
  const groups = new Map<number, number>();
  if (child.pid) groups.set(child.pid, start);
  let accountingError: string | undefined, leaked = false;
  // A group ID is accepted only from our directly spawned handle or the preload's
  // synchronous child ledger. These suites are trusted code, not hostile tenants.
  const liveGroups = () => {
    const text = fs.readFileSync(journal, "utf8");
    if (text.length > 2 * 1024 * 1024) throw new Error("Child accounting limit exceeded");
    for (const line of text.split("\n").filter(Boolean)) {
      const item = JSON.parse(line);
      if (!Number.isSafeInteger(item.pid) || item.pid <= 1 || typeof item.detached !== "boolean" || item.at < start - 1000 || item.at > Date.now() + 1000) throw new Error("Invalid child process accounting");
      if (item.detached) groups.set(item.pid, item.at);
    }
    const rows = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat=,lstart="], { encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
    const live = new Set<number>(), reused = new Set<number>();
    for (const row of rows.trim().split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(row);
      if (!match) throw new Error("Unsupported process accounting output");
      const [, pid, pgid, state, birth] = match, group = Number(pgid);
      if (!groups.has(group)) continue;
      // Do not signal an unrelated process after PID/group-ID reuse. lstart is
      // second-resolution; this cooperative check is not a hostile-race fence.
      if (!Number.isFinite(Date.parse(birth))) throw new Error("Unsupported process birth-time accounting");
      if (pid === pgid && Math.abs(Date.parse(birth) - groups.get(group)!) > 2000) reused.add(group);
      if (!state.startsWith("Z")) live.add(group);
    }
    for (const id of reused) live.delete(id);
    return live;
  };
  const kill = (targets: Set<number>, sig: NodeJS.Signals) => {
    for (const pgid of targets) try { process.kill(-pgid, sig); } catch (e: any) { if (e.code !== "ESRCH") throw e; }
  };
  try {
    while (!closed && !stopped) await delay(25);
    let live = liveGroups();
    // Normal children may finish their own pipe-close cleanup just after the
    // root exits. Join that short tail before diagnosing a leaked writer.
    const grace = Date.now() + 250;
    while (!stopped && closed && live.size && Date.now() < grace) { await delay(25); live = liveGroups(); }
    leaked = !stopped && closed && live.size > 0;
    if (live.size || !closed) {
      kill(live, "SIGTERM");
      const until = Date.now() + 500;
      while (Date.now() < until && (!closed || live.size)) { await delay(25); live = liveGroups(); }
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && (!closed || live.size)) { kill(live, "SIGKILL"); await delay(25); live = liveGroups(); }
    }
    if (!closed || live.size) accountingError = "Test processes did not establish quiescence after TERM/KILL";
  } catch (e) {
    accountingError = e instanceof Error ? e.message : String(e);
    // Best effort only; an accounting failure is never verified quiescence.
    try { if (child.pid && !closed) child.kill("SIGKILL"); } catch { /* retained unknown state; do not signal unvalidated groups */ }
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", stop);
    // Do not close a descriptor that a still-running pipe handler could write.
    child.stdout.off("data", output); child.stderr.off("data", output);
    fs.fsyncSync(fd); fs.closeSync(fd);
  }
  if (accountingError) return { status: "not-verified", evidence: `${accountingError}; retained log ${command.log}`, quiescence: { state: "unknown", reason: accountingError } };
  const reason = logError ?? error ?? (timedOut ? "Test deadline elapsed" : overflow ? "Test output exceeded 4 MiB" : signal.aborted ? "Test cancelled" : leaked ? "Suite left surviving subprocesses; terminated and joined" : `Test exited ${code}`);
  return { status: error || stopped ? "not-verified" : code === 0 && !leaked ? "passed" : "finding", evidence: `${reason}; log ${command.log}`,
    quiescence: quiet("Direct child closed and every registered POSIX process group has no live writers; detached Node children were accounted by the host preload.") };
}
