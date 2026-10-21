#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import readline from "node:readline";

const HELP = `cctrim: find out why Claude Code burns through your usage

Usage: cctrim [options]

  --days <n>       Look back n days (default 7)
  --project <str>  Only sessions whose project path contains <str>
  --top <n>        Rows per table (default 8)
  --shipped        Add usage per commit from local git (default window 56 days)
  --json           Machine-readable output
  --dir <path>     Claude config dir (default $CLAUDE_CONFIG_DIR or ~/.claude)
  -h, --help       Show this help

Everything is read from local transcripts. Nothing leaves your machine.`;

function parseArgs(argv) {
  const o = { days: 7, top: 8, json: false, shipped: false, project: null, dir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { console.log(HELP); process.exit(0); }
    else if (a === "--json") o.json = true;
    else if (a === "--shipped") o.shipped = true;
    else if (a === "--days") { o.days = Number(argv[++i]); o.daysSet = true; }
    else if (a === "--top") o.top = Number(argv[++i]);
    else if (a === "--project") o.project = argv[++i];
    else if (a === "--dir") o.dir = argv[++i];
    else { console.error(`Unknown option: ${a}\n\n${HELP}`); process.exit(1); }
  }
  if (o.shipped && !o.daysSet) o.days = 56;
  if (!(o.days > 0) || !(o.top > 0)) { console.error("--days and --top must be positive numbers"); process.exit(1); }
  return o;
}

const HOOK_CAP = 10000;
const BANDS = [
  { label: "under 50k", max: 50e3 },
  { label: "50k-150k", max: 150e3 },
  { label: "150k-300k", max: 300e3 },
  { label: "300k-600k", max: 600e3 },
  { label: "600k+", max: Infinity },
];

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function readMeta(file) {
  try { return JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch { return {}; }
}

function touchedPaths(b, cwd) {
  const i = b.input || {};
  const abs = (p) => {
    if (typeof p !== "string" || !p || p.includes("$")) return null;
    if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
    return path.isAbsolute(p) ? path.normalize(p) : cwd ? path.resolve(cwd, p) : null;
  };
  if (b.name === "Bash") {
    const m = typeof i.command === "string" && i.command.match(/(?:^|&&|;|\|\|)\s*(?:cd|git\s+-C)\s+(["']?)([^\s"'&;|]+)\1/);
    const p = abs(m ? m[2] : null);
    return p ? { path: p } : abs(cwd) ? { path: abs(cwd), fromCwd: true } : null;
  }
  const p = abs(i.file_path || i.notebook_path || i.path);
  return p ? { path: p } : null;
}

async function scanFile(file, sinceIso, weekly) {
  const isSub = file.includes(`${path.sep}subagents${path.sep}`);
  const s = {
    file, isSub, agentType: isSub ? readMeta(file).agentType || "unknown" : null,
    turns: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0, maxCtx: 0, firstCtx: null,
    first: null, last: null, compactions: 0, models: {}, cwd: null, hookSpills: [], bigResults: [], daily: {}, touches: new Map(), cwdTouches: new Map(),
  };
  const seen = new Set();
  const toolNames = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const ts = j.timestamp || "";
    if (ts && ts < sinceIso) continue;
    if (!s.cwd && j.cwd) s.cwd = j.cwd;
    if (j.type === "system" && j.subtype === "compact_boundary") { s.compactions++; continue; }
    if (j.type === "attachment" && j.attachment?.type === "hook_additional_context") {
      for (const c of [].concat(j.attachment.content || [])) {
        const m = typeof c === "string" && c.match(/Output too large \(([^)]+)\)[\s\S]*?Preview \(first [^)]*\):\n([^\n]*)/);
        if (m) s.hookSpills.push({ size: m[1], firstLine: m[2].slice(0, 80), ts });
      }
      continue;
    }
    const content = j.message?.content;
    if (j.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== "tool_use") continue;
        toolNames.set(b.id, b.name);
        if (!weekly) continue;
        const t = touchedPaths(b, j.cwd || s.cwd);
        if (t) { const m = t.fromCwd ? s.cwdTouches : s.touches; m.set(t.path, (m.get(t.path) || 0) + 1); }
      }
    }
    if (j.type === "user" && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== "tool_result") continue;
        const len = typeof b.content === "string" ? b.content.length
          : Array.isArray(b.content) ? b.content.reduce((a, x) => a + (x?.type === "text" ? (x.text || "").length : 0), 0) : 0;
        if (len > 100e3) s.bigResults.push({ tool: toolNames.get(b.tool_use_id) || "unknown", chars: len });
      }
    }
    if (j.type !== "assistant") continue;
    const u = j.message?.usage;
    const id = j.message?.id;
    if (!u || (id && seen.has(id))) continue;
    if (id) seen.add(id);
    const model = j.message.model || "unknown";
    if (model === "<synthetic>") continue;
    const cr = u.cache_read_input_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0;
    const inp = u.input_tokens || 0;
    const ctx = cr + cw + inp;
    s.turns++;
    s.cacheRead += cr; s.cacheWrite += cw; s.input += inp; s.output += u.output_tokens || 0;
    s.maxCtx = Math.max(s.maxCtx, ctx);
    if (s.firstCtx === null) s.firstCtx = ctx;
    s.models[model] = (s.models[model] || 0) + 1;
    s.first ||= ts; s.last = ts || s.last;
    if (weekly && ts) {
      const d = (s.daily[dayStart(Date.parse(ts))] ||= { cacheRead: 0, total: 0 });
      d.cacheRead += cr; d.total += ctx + (u.output_tokens || 0);
    }
    const band = BANDS.findIndex((b) => ctx < b.max);
    (s.bands ||= BANDS.map(() => ({ turns: 0, cacheRead: 0 })))[band].turns++;
    s.bands[band].cacheRead += cr;
  }
  return s;
}

const DAY = 864e5;
const WEEK = 7 * DAY;
const REWORK_WINDOW = 3 * DAY;

const dayStart = (ms) => ms - (ms % DAY);
const monday = (ms) => dayStart(ms) - ((new Date(ms).getUTCDay() + 6) % 7) * DAY;

function retentionDays(dir) {
  try { return Number(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).cleanupPeriodDays) || 30; } catch { return 30; }
}

function weekLabel(mon) {
  const thu = new Date(mon + 3 * DAY);
  const y = thu.getUTCFullYear();
  return `${y}-W${String(Math.ceil(((thu - Date.UTC(y, 0, 1)) / DAY + 1) / 7)).padStart(2, "0")}`;
}

// Repos found in transcripts may be clones nobody vetted, so config that can run a program is switched off.
const GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.sshCommand=false", "-c", "diff.external=", "-c", "protocol.allow=never"];
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };

function git(cwd, args) {
  try {
    return execFileSync("git", [...GIT_SAFE, "-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 }).trim();
  } catch { return null; }
}

function readCommits(root, sinceMs) {
  const out = git(root, ["log", "--branches", "--no-merges", "--no-renames", `--since=${new Date(sinceMs).toISOString()}`, "--format=%x1e%H%x09%at%x09%ae%x09%s", "--name-only", "--no-ext-diff", "--no-textconv"]);
  if (out === null) return null;
  return out.split("\x1e").filter(Boolean).map((chunk) => {
    const [head, ...files] = chunk.split("\n");
    const [hash, at, email, subject = ""] = head.split("\t");
    return { hash, at: Number(at) * 1000, email: (email || "").toLowerCase(), subject, files: files.filter(Boolean) };
  });
}

const GENERATED = /(^|\/)(node_modules|vendor|dist|build)\/|\.min\.[^/]+$|\.map$|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Podfile\.lock|Package\.resolved|pubspec\.lock|mix\.lock)$/;
const SERIES_GAP = 30 * 60e3;

// A series of commits by one author, each within 30 minutes of the last and sharing a file, is one change unit.
function markRework(commits, mine) {
  for (const c of commits) c.files = c.files.filter((f) => !GENERATED.test(f));
  const byAuthor = new Map();
  for (const c of commits) (byAuthor.get(c.email) || byAuthor.set(c.email, []).get(c.email)).push(c);
  for (const list of byAuthor.values()) {
    let unit = null;
    for (const c of list.sort((x, y) => x.at - y.at)) {
      if (unit && c.at - unit.end <= SERIES_GAP && c.files.some((f) => unit.files.has(f))) unit.end = c.at;
      else unit = { end: c.at, files: new Set(), commits: [] };
      for (const f of c.files) unit.files.add(f);
      unit.commits.push(c);
      c.unit = unit;
    }
  }
  const touches = new Map();
  for (const c of commits) for (const f of c.files) (touches.get(f) || touches.set(f, []).get(f)).push(c);
  const units = [...new Set(mine.map((c) => c.unit))];
  for (const u of units) {
    u.revert = u.commits.some((c) => /^Revert/.test(c.subject));
    u.reworked = [...u.files].some((f) => touches.get(f).some((d) => d.unit !== u && d.at > u.end && d.at - u.end <= REWORK_WINDOW));
  }
  return units;
}

function findTop(dir, cache) {
  const seen = [];
  let top = null;
  for (let d = dir; ; d = path.dirname(d)) {
    if (cache.has(d)) { top = cache.get(d); break; }
    seen.push(d);
    if (fs.existsSync(path.join(d, ".git"))) { top = d; break; }
    if (path.dirname(d) === d) break;
  }
  for (const d of seen) cache.set(d, top);
  return top;
}

function ignoredPaths(top, paths) {
  let out;
  try {
    out = execFileSync("git", [...GIT_SAFE, "-C", top, "check-ignore", "--stdin", "-z"], { input: paths.join("\0"), encoding: "utf8", env: GIT_ENV, stdio: ["pipe", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch (e) { out = e.status === 1 ? "" : null; }
  return out === null ? null : new Set(out.split("\0").filter(Boolean));
}

// Each session's usage goes to the git repos its tool calls touched, split by touch count.
// Bash working directories only count for sessions with no other repo touches.
// A directory counts when a new file in it would be tracked.
function attribute(sessions) {
  const topCache = new Map();
  const probes = new Map();
  const touchTop = new Map();
  for (const s of sessions) for (const p of [...s.touches.keys(), ...s.cwdTouches.keys()]) {
    if (touchTop.has(p)) continue;
    let isDir = false;
    try { isDir = fs.statSync(p).isDirectory(); } catch {}
    const top = p.includes(`${path.sep}.git${path.sep}`) ? null : findTop(isDir ? p : path.dirname(p), topCache);
    const probe = isDir ? path.join(p, ".cctrim-probe") : p;
    touchTop.set(p, top && { top, probe });
    if (top) (probes.get(top) || probes.set(top, new Set()).get(top)).add(probe);
  }
  const common = new Map();
  const ignored = new Map();
  for (const [top, set] of probes) {
    const [t, c] = (git(top, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]) || "").split("\n");
    if (!c) continue;
    common.set(top, { common: c, root: path.basename(c) === ".git" ? path.dirname(c) : t });
    ignored.set(top, ignoredPaths(top, [...set]) || new Set(set));
  }
  const weigh = (touches) => {
    const w = {};
    for (const [p, n] of touches) {
      const t = touchTop.get(p);
      if (!t || !common.has(t.top) || ignored.get(t.top).has(t.probe)) continue;
      const k = common.get(t.top).common;
      w[k] = (w[k] || 0) + n;
    }
    return w;
  };
  for (const s of sessions) {
    let w = weigh(s.touches);
    if (!Object.keys(w).length) w = weigh(s.cwdTouches);
    const sum = Object.values(w).reduce((a, n) => a + n, 0);
    s.repoShares = sum ? Object.entries(w).map(([k, n]) => [k, n / sum]) : [];
  }
  return new Map([...common.values()].map((v) => [v.common, v.root]));
}

function shippedUnits(sessions, sinceMs, coverageMs) {
  const roots = attribute(sessions);
  const repos = {};
  const unattributed = { sessions: 0, cacheRead: 0 };
  for (const s of sessions) {
    const days = Object.entries(s.daily).filter(([d]) => Number(d) >= coverageMs);
    if (!days.length) continue;
    if (!s.repoShares.length) {
      unattributed.sessions++;
      for (const [, v] of days) unattributed.cacheRead += v.cacheRead;
      continue;
    }
    for (const [common, share] of s.repoShares) {
      const r = (repos[common] ||= { root: roots.get(common), cacheRead: 0, total: 0, weeks: {} });
      for (const [d, v] of days) {
        const e = (r.weeks[monday(Number(d))] ||= { cacheRead: 0, total: 0 });
        r.cacheRead += v.cacheRead * share; r.total += v.total * share;
        e.cacheRead += v.cacheRead * share; e.total += v.total * share;
      }
    }
  }

  const skipped = { projects: 0, cacheRead: 0, noUser: 0 };
  const projects = [];
  const weeks = {};
  const counted = new Set();
  for (const r of Object.values(repos).sort((a, b) => b.cacheRead - a.cacheRead)) {
    const email = (git(r.root, ["config", "user.email"]) || "").toLowerCase();
    const commits = email ? readCommits(r.root, coverageMs) : null;
    if (!commits) { skipped.projects++; skipped.cacheRead += r.cacheRead; if (!email) skipped.noUser++; continue; }
    const mine = commits.filter((c) => c.email === email && c.at >= coverageMs && !counted.has(c.hash));
    for (const c of mine) counted.add(c.hash);
    const units = markRework(commits, mine);
    const week = (w) => (weeks[w] ||= { cacheRead: 0, total: 0, commits: 0 });
    for (const [w, v] of Object.entries(r.weeks)) { week(w).cacheRead += v.cacheRead; week(w).total += v.total; }
    for (const c of mine) week(monday(c.at)).commits++;
    projects.push({
      project: short(r.root), commits: mine.length, cacheRead: Math.round(r.cacheRead), total: Math.round(r.total), units: units.length,
      reworked: units.filter((u) => u.reworked).length, reverts: units.filter((u) => u.revert).length,
      rework: units.filter((u) => u.reworked || u.revert).length,
    });
  }
  projects.sort((a, b) => b.cacheRead - a.cacheRead);

  const sum = (k) => projects.reduce((a, p) => a + p[k], 0);
  const commits = sum("commits");
  const perCommit = (n, c) => (c ? Math.round(n / c) : null);
  const overall = {
    projects: projects.length, commits, cacheRead: sum("cacheRead"), total: sum("total"),
    cacheReadPerCommit: perCommit(sum("cacheRead"), commits), totalPerCommit: perCommit(sum("total"), commits),
    units: sum("units"), reworked: sum("reworked"), reverts: sum("reverts"), reworkShare: sum("units") ? pct(sum("rework"), sum("units")) : null,
  };
  unattributed.cacheRead = Math.round(unattributed.cacheRead);
  unattributed.share = pct(unattributed.cacheRead, unattributed.cacheRead + overall.cacheRead + skipped.cacheRead);
  skipped.cacheRead = Math.round(skipped.cacheRead);

  const now = Date.now();
  const full = Object.entries(weeks)
    .map(([m, v]) => ({ week: weekLabel(Number(m)), start: Number(m), cacheRead: Math.round(v.cacheRead), total: Math.round(v.total), commits: v.commits }))
    .filter((w) => w.start >= coverageMs && w.start + WEEK <= now)
    .sort((a, b) => a.start - b.start);
  let comparison = null;
  if (full.length >= 4) {
    const ranked = [...full].sort((a, b) => b.cacheRead - a.cacheRead);
    const half = Math.floor(ranked.length / 2);
    const bucket = (ws) => {
      const c = ws.reduce((a, w) => a + w.commits, 0);
      const cr = ws.reduce((a, w) => a + w.cacheRead, 0);
      return { weeks: ws.length, commits: c, cacheRead: cr, cacheReadPerWeek: Math.round(cr / ws.length), commitsPerWeek: +(c / ws.length).toFixed(1), cacheReadPerCommit: perCommit(cr, c) };
    };
    comparison = { heavier: bucket(ranked.slice(0, half)), lighter: bucket(ranked.slice(-half)) };
  }

  return {
    since: new Date(coverageMs).toISOString(), transcriptsLimitWindow: coverageMs - sinceMs > DAY,
    overall, projects, unattributed, skipped,
    weeks: full.map(({ start, ...w }) => w), comparison,
  };
}

function fileChars(p) {
  try { return fs.readFileSync(p, "utf8").length; } catch { return null; }
}

function measureOverhead(dir, cwds) {
  const files = [];
  const add = (p, label) => { const c = fileChars(p); if (c) files.push({ label, path: p, chars: c, tokens: Math.round(c / 4) }); };
  add(path.join(dir, "CLAUDE.md"), "global CLAUDE.md");
  try {
    for (const f of fs.readdirSync(path.join(dir, "rules"))) if (f.endsWith(".md")) add(path.join(dir, "rules", f), `rules/${f}`);
  } catch {}
  for (const cwd of cwds) {
    add(path.join(cwd, "CLAUDE.md"), `${short(cwd)}/CLAUDE.md`);
    add(path.join(cwd, ".claude", "CLAUDE.md"), `${short(cwd)}/.claude/CLAUDE.md`);
    const mem = path.join(dir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), "memory", "MEMORY.md");
    add(mem, `${short(cwd)} auto-memory MEMORY.md`);
  }
  return files;
}

const home = os.homedir();
const short = (p) => (p && p.startsWith(home) ? "~" + p.slice(home.length) : p || "?");
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
const topModel = (m) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] || "?";
const days = (s) => (s.first && s.last ? Math.max(1, Math.ceil((Date.parse(s.last) - Date.parse(s.first)) / 864e5)) : 1);

function analyse(sessions, opts) {
  const total = sessions.reduce((a, s) => a + s.cacheRead, 0);
  const turns = sessions.reduce((a, s) => a + s.turns, 0);
  const main = sessions.filter((s) => !s.isSub);
  const subs = sessions.filter((s) => s.isSub);
  const subRead = subs.reduce((a, s) => a + s.cacheRead, 0);

  const bands = BANDS.map((b, i) => {
    const cr = sessions.reduce((a, s) => a + (s.bands?.[i].cacheRead || 0), 0);
    const t = sessions.reduce((a, s) => a + (s.bands?.[i].turns || 0), 0);
    return { label: b.label, turns: t, share: pct(cr, total) };
  });
  const over300 = bands[3].share + bands[4].share;

  const longSessions = main
    .filter((s) => s.turns >= 300 || days(s) > 2 || s.cacheRead / Math.max(s.turns, 1) > 250e3)
    .sort((a, b) => b.cacheRead - a.cacheRead);

  const byType = {};
  for (const s of subs) {
    const t = (byType[s.agentType] ||= { agentType: s.agentType, runs: 0, turns: 0, cacheRead: 0, maxCtx: 0, models: {} });
    t.runs++; t.turns += s.turns; t.cacheRead += s.cacheRead; t.maxCtx = Math.max(t.maxCtx, s.maxCtx);
    for (const [m, n] of Object.entries(s.models)) t.models[m] = (t.models[m] || 0) + n;
  }
  const agentTypes = Object.values(byType).sort((a, b) => b.cacheRead - a.cacheRead);
  const runaways = subs.filter((s) => s.turns > 150 || s.maxCtx > 400e3).sort((a, b) => b.cacheRead - a.cacheRead);

  const modelTurns = {};
  for (const s of sessions) for (const [m, n] of Object.entries(s.models)) {
    const r = (modelTurns[m] ||= { model: m, mainTurns: 0, subTurns: 0 });
    s.isSub ? (r.subTurns += n) : (r.mainTurns += n);
  }
  const subTurns = subs.reduce((a, s) => a + s.turns, 0);
  const subOpusTurns = Object.values(modelTurns).filter((r) => /opus/i.test(r.model)).reduce((a, r) => a + r.subTurns, 0);

  const baseline = median(main.filter((s) => s.firstCtx).map((s) => s.firstCtx));
  const cwdRead = {};
  for (const s of main) if (s.cwd) cwdRead[s.cwd] = (cwdRead[s.cwd] || 0) + s.cacheRead;
  const topCwds = Object.entries(cwdRead).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);
  const overheadFiles = measureOverhead(opts.dir, topCwds).sort((a, b) => b.chars - a.chars);

  const spills = {};
  for (const s of sessions) for (const h of s.hookSpills) {
    const k = h.firstLine;
    const e = (spills[k] ||= { firstLine: k, size: h.size, sessions: 0, lastSeen: "" });
    e.sessions++;
    if (h.ts > e.lastSeen) { e.lastSeen = h.ts; e.size = h.size; }
  }
  const hookSpills = Object.values(spills).sort((a, b) => b.sessions - a.sessions);

  const bloat = {};
  for (const s of sessions) for (const r of s.bigResults) {
    const b = (bloat[r.tool] ||= { tool: r.tool, count: 0, maxChars: 0 });
    b.count++; b.maxChars = Math.max(b.maxChars, r.chars);
  }
  const toolBloat = Object.values(bloat).sort((a, b) => b.count - a.count);

  const projects = {};
  for (const s of sessions) {
    const k = s.cwd ? short(s.cwd) : "?";
    projects[k] = (projects[k] || 0) + s.cacheRead;
  }

  const recs = [];
  if (over300 >= 25) recs.push(`${over300}% of your usage comes from turns with more than 300k tokens in context. Run /clear when you switch tasks and /compact once a session passes ~200k. Don't let one session carry days of unrelated work.`);
  if (longSessions.length) recs.push(`${longSessions.length} session(s) ran very long (300+ turns, more than 2 days, or 250k+ average context). The biggest re-read ${fmt(longSessions[0].cacheRead)} tokens over ${longSessions[0].turns} turns. Start fresh sessions per task.`);
  if (pct(subRead, total) >= 40) recs.push(`Subagents account for ${pct(subRead, total)}% of usage. Give each one a single bounded deliverable with a done-condition, and split anything that looks like more than ~100 turns. Add this to your CLAUDE.md so Claude briefs them that way.`);
  if (runaways.length) recs.push(`${runaways.length} subagent run(s) went past 150 turns or 400k context, led by "${runaways[0].agentType}" (${runaways[0].turns} turns, ${fmt(runaways[0].maxCtx)} peak). Split that work across several fresh agents, passing summaries between them.`);
  if (subTurns >= 100 && pct(subOpusTurns, subTurns) >= 70) recs.push(`${pct(subOpusTurns, subTurns)}% of subagent turns ran on Opus. Set \`model: sonnet\` in the frontmatter of implementation, docs, test and scraping agents, and keep Opus for planning and review.`);
  if (baseline > 40e3) recs.push(`A fresh session already starts at ~${fmt(baseline)} tokens, and that gets re-read on every turn. The biggest files you control are listed under Fixed overhead. Trim them and move rarely needed detail into skills or files that are read on demand.`);
  if (hookSpills.length) recs.push(`${hookSpills.length} hook output(s) exceeded the ${HOOK_CAP.toLocaleString()}-character additionalContext cap. Claude Code saves them to a file and only shows a 2KB preview, so most of that context never reaches the model. Shrink the hook output to under ${HOOK_CAP.toLocaleString()} characters.`);
  if (toolBloat.length) recs.push(`${toolBloat.reduce((a, b) => a + b.count, 0)} tool results were over 100k characters (top: ${toolBloat[0].tool}). Each stays in context and gets re-read on every later turn. Use head/tail and narrower reads, or delegate the search to a subagent.`);

  return {
    window: { days: opts.days, project: opts.project },
    totals: { sessions: main.length, subagentRuns: subs.length, turns, cacheRead: total, cacheWrite: sessions.reduce((a, s) => a + s.cacheWrite, 0), output: sessions.reduce((a, s) => a + s.output, 0), subagentShare: pct(subRead, total) },
    projects: Object.entries(projects).sort((a, b) => b[1] - a[1]).map(([project, cr]) => ({ project, share: pct(cr, total) })),
    bands,
    longSessions: longSessions.map((s) => ({ project: short(s.cwd), turns: s.turns, days: days(s), cacheRead: s.cacheRead, avgCtx: Math.round(s.cacheRead / s.turns), maxCtx: s.maxCtx, compactions: s.compactions, model: topModel(s.models), file: s.file })),
    agentTypes: agentTypes.map((t) => ({ ...t, share: pct(t.cacheRead, total), model: topModel(t.models), models: undefined })),
    runaways: runaways.map((s) => ({ agentType: s.agentType, turns: s.turns, maxCtx: s.maxCtx, cacheRead: s.cacheRead, model: topModel(s.models), file: s.file })),
    models: Object.values(modelTurns).sort((a, b) => b.mainTurns + b.subTurns - a.mainTurns - a.subTurns),
    overhead: { baselineTokens: baseline, files: overheadFiles.map((f) => ({ ...f, path: short(f.path) })) },
    hookSpills,
    toolBloat,
    recommendations: recs,
    shipped: opts.shippedData,
  };
}

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c(1), dim = c(2), yellow = c(33), cyan = c(36);

function table(rows, cols) {
  const w = cols.map((col) => Math.max(col.h.length, ...rows.map((r) => String(col.f(r)).length)));
  const line = (cells) => "  " + cells.map((x, i) => (cols[i].right ? String(x).padStart(w[i]) : String(x).padEnd(w[i]))).join("  ");
  return [dim(line(cols.map((x) => x.h))), ...rows.map((r) => line(cols.map((col) => col.f(r))))].join("\n");
}

function renderShipped(s, top, out, h) {
  const per = (n) => (n === null ? "-" : fmt(n));
  const o = s.overall;
  h("Shipped units: your commits in the repos you used Claude Code in");
  if (s.transcriptsLimitWindow) out.push(dim(`  Transcripts only reach back to ${s.since.slice(0, 10)}, so usage and commits are both counted from then.`));
  const un = s.unattributed;
  const unLine = `${un.sessions.toLocaleString()} session(s) touched no files in a git repo: ${fmt(un.cacheRead)} cache-read tokens (${un.share}%) unattributed and not counted.`;
  if (!o.projects) {
    out.push(yellow(`  No git repos to measure. ${unLine}`));
    return;
  }
  out.push(`  ${o.commits.toLocaleString()} commits across ${o.projects} repos: ${per(o.cacheReadPerCommit)} cache-read and ${per(o.totalPerCommit)} total tokens per commit`);
  out.push(dim("  Each session's usage goes to the repos whose files its tool calls touched, split by touch count. Per-commit figures use attributed usage only."));
  if (un.sessions) out.push(dim(`  ${unLine}`));
  if (s.skipped.projects) out.push(dim(`  Skipped ${s.skipped.projects} repo(s) with no git user or readable log, ${fmt(s.skipped.cacheRead)} cache-read tokens not counted.`));
  if (!o.commits) out.push(yellow("  No commits by your git user in these repos, so there's nothing to divide by."));
  out.push(table(s.projects.slice(0, top), [
    { h: "project", f: (p) => p.project }, { h: "commits", f: (p) => p.commits, right: true },
    { h: "cache-read", f: (p) => fmt(p.cacheRead), right: true }, { h: "per commit", f: (p) => per(p.commits ? Math.round(p.cacheRead / p.commits) : null), right: true },
    { h: "total/commit", f: (p) => per(p.commits ? Math.round(p.total / p.commits) : null), right: true }, { h: "rework", f: (p) => (p.units ? pct(p.rework, p.units) + "%" : "-"), right: true },
  ]));

  out.push("", bold("  Heavier vs lighter weeks"));
  if (!s.comparison) out.push(dim(`  Needs at least 4 complete weeks of transcripts, found ${s.weeks.length}. Try a longer --days, or keep transcripts longer with cleanupPeriodDays.`));
  else {
    const { heavier, lighter } = s.comparison;
    out.push(table([{ name: "heavier", ...heavier }, { name: "lighter", ...lighter }], [
      { h: "weeks", f: (b) => `${b.name} (n=${b.weeks})` }, { h: "cache-read/week", f: (b) => fmt(b.cacheReadPerWeek), right: true },
      { h: "commits/week", f: (b) => b.commitsPerWeek, right: true }, { h: "per commit", f: (b) => per(b.cacheReadPerCommit), right: true },
    ]));
    out.push(dim(`  Complete ISO weeks, split at the median by cache reads${s.weeks.length % 2 ? "; the middle week is left out" : ""}.`));
  }

  if (o.commits) out.push("", `  Rework: ${o.reworkShare}% of ${o.units.toLocaleString()} change units (${o.reworked} had a file changed again within 3 days, ${o.reverts} with reverts)`);
  if (o.commits) out.push(dim("  A rough proxy. A change unit is one commit, or a series by the same author within 30 minutes touching the same files. Lockfiles, build output, vendored and minified files are ignored."));
}

function render(r, top) {
  const out = [];
  const h = (t) => out.push("", bold(cyan(t)));
  out.push(bold(`cctrim: last ${r.window.days} days${r.window.project ? `, projects matching "${r.window.project}"` : ""}`));
  out.push(`  ${r.totals.sessions} sessions, ${r.totals.subagentRuns} subagent runs, ${r.totals.turns.toLocaleString()} model turns`);
  out.push(`  ${fmt(r.totals.cacheRead)} cache-read tokens, ${fmt(r.totals.cacheWrite)} cache writes, ${fmt(r.totals.output)} output`);
  out.push(dim("  Cache reads are the context Claude re-reads on every turn. They dominate usage, so this report ranks by them."));

  h("Where it goes, by context size per turn");
  out.push(table(r.bands, [{ h: "context", f: (b) => b.label }, { h: "turns", f: (b) => b.turns.toLocaleString(), right: true }, { h: "share of usage", f: (b) => b.share + "%", right: true }]));

  h("By project");
  out.push(table(r.projects.slice(0, top), [{ h: "project", f: (p) => p.project }, { h: "share", f: (p) => p.share + "%", right: true }]));

  if (r.longSessions.length) {
    h("Sessions that ran too long");
    out.push(table(r.longSessions.slice(0, top), [
      { h: "project", f: (s) => s.project }, { h: "turns", f: (s) => s.turns, right: true }, { h: "days", f: (s) => s.days, right: true },
      { h: "avg ctx", f: (s) => fmt(s.avgCtx), right: true }, { h: "peak", f: (s) => fmt(s.maxCtx), right: true },
      { h: "re-read", f: (s) => fmt(s.cacheRead), right: true }, { h: "compacts", f: (s) => s.compactions, right: true },
    ]));
  }

  h(`Subagents: ${r.totals.subagentShare}% of usage`);
  if (r.agentTypes.length) {
    out.push(table(r.agentTypes.slice(0, top), [
      { h: "agent type", f: (t) => t.agentType }, { h: "runs", f: (t) => t.runs, right: true }, { h: "turns", f: (t) => t.turns, right: true },
      { h: "peak ctx", f: (t) => fmt(t.maxCtx), right: true }, { h: "share", f: (t) => t.share + "%", right: true }, { h: "model", f: (t) => t.model },
    ]));
  } else out.push(dim("  No subagent runs in this window."));
  if (r.runaways.length) {
    out.push("", yellow(`  Runaway runs (over 150 turns or 400k context): ${r.runaways.length}`));
    out.push(table(r.runaways.slice(0, top), [
      { h: "agent type", f: (s) => s.agentType }, { h: "turns", f: (s) => s.turns, right: true },
      { h: "peak ctx", f: (s) => fmt(s.maxCtx), right: true }, { h: "re-read", f: (s) => fmt(s.cacheRead), right: true }, { h: "model", f: (s) => s.model },
    ]));
  }

  h("Models (turns)");
  out.push(table(r.models.slice(0, top), [{ h: "model", f: (m) => m.model }, { h: "main", f: (m) => m.mainTurns.toLocaleString(), right: true }, { h: "subagents", f: (m) => m.subTurns.toLocaleString(), right: true }]));

  h(`Fixed overhead: a fresh session starts at ~${fmt(r.overhead.baselineTokens)} tokens`);
  out.push(dim("  System prompt, tool definitions, skills, CLAUDE.md, rules, memory and hook output. Files you control:"));
  if (r.overhead.files.length) out.push(table(r.overhead.files.slice(0, top), [{ h: "file", f: (f) => f.label }, { h: "≈tokens", f: (f) => fmt(f.tokens), right: true }]));
  else out.push(dim("  None found."));

  h("Hook output over the 10,000-character cap");
  if (r.hookSpills.length) {
    out.push(yellow("  These were cut to a 2KB preview, so the model never saw most of it:"));
    out.push(table(r.hookSpills, [{ h: "output starts with", f: (s) => s.firstLine }, { h: "size", f: (s) => s.size, right: true }, { h: "sessions", f: (s) => s.sessions, right: true }, { h: "last seen", f: (s) => s.lastSeen.slice(0, 10) }]));
  } else out.push(dim("  None. Good."));

  if (r.toolBloat.length) {
    h("Tool results over 100k characters");
    out.push(table(r.toolBloat.slice(0, top), [{ h: "tool", f: (b) => b.tool }, { h: "count", f: (b) => b.count, right: true }, { h: "largest", f: (b) => fmt(b.maxChars) + " chars", right: true }]));
  }

  if (r.shipped) renderShipped(r.shipped, top, out, h);

  h("What to change");
  if (r.recommendations.length) r.recommendations.forEach((x, i) => out.push(`  ${i + 1}. ${x}`));
  else out.push("  Nothing stands out. Your usage looks lean.");
  out.push("", dim("  Built by Jean Galea. Help cutting your team's AI costs: https://agentvania.com"), "");
  return out.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.join(opts.dir, "projects");
  if (!fs.existsSync(root)) { console.error(`No transcripts found at ${root}`); process.exit(1); }
  const since = Date.now() - opts.days * 864e5;
  const sinceIso = new Date(since).toISOString();
  const files = walk(root).filter((f) => { try { return fs.statSync(f).mtimeMs >= since; } catch { return false; } });
  if (!opts.json && process.stderr.isTTY) process.stderr.write(`Scanning ${files.length} transcripts...\r`);
  const sessions = [];
  let earliest = Infinity;
  for (const f of files) {
    const s = await scanFile(f, sinceIso, opts.shipped);
    for (const d of Object.keys(s.daily)) earliest = Math.min(earliest, Number(d));
    if (s.turns && (!opts.project || (s.cwd || f).includes(opts.project))) sessions.push(s);
  }
  if (!opts.json && process.stderr.isTTY) process.stderr.write(" ".repeat(40) + "\r");
  if (!sessions.length) { console.error(`No Claude Code activity in the last ${opts.days} days${opts.project ? ` matching "${opts.project}"` : ""}.`); process.exit(1); }
  if (opts.shipped) opts.shippedData = shippedUnits(sessions, since, dayStart(Math.max(since, earliest, Date.now() - retentionDays(opts.dir) * 864e5)));
  const report = analyse(sessions, opts);
  console.log(opts.json ? JSON.stringify(report, null, 2) : render(report, opts.top));
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
