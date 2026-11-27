// SPDX-License-Identifier: GPL-3.0-only
// Prism Facets — usage data sources, normalised into one view model.
//
//  codexhostSource(): codexhost's own machine-wide usage statistics
//    (`codexhost/usage/statistics/get`, every Harness, priced) and Codex
//    account quota, through CH Web's authenticated same-origin gateway
//    POST <base>/api/ch/v1/rpc. Only available inside CH Web.
//  logSource(api): the plugin backend's read-only scan of Codex rollout logs.
//    Fallback for Codex Desktop, whose pages cannot reach the Host RPC.

export const RANGES = ["today", "7d", "30d", "90d", "all"];
export const ALL = "__all__";
export const NO_PROJECT = "__none__";
const TOKENS_PER_BOOK = 202_000; // ≈ one copy of 《三体》
const HEATMAP_DAYS = 26 * 7 + 6;
const DAY_MS = 86_400_000;

const HARNESS_NAMES = {
  "codex-usage": "Codex",
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity CLI",
  "deepseek-harness": "DeepSeek Harness",
  "cursor-cli": "Cursor CLI",
  "kimi-code": "Kimi Code",
  "qwen-code": "Qwen Code",
  "kiro-cli": "Kiro CLI",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  codebuddy: "CodeBuddy",
  workbuddy: "WorkBuddy",
  qoder: "Qoder",
  "qoder-cn": "Qoder CN",
  devin: "Devin",
  grok: "Grok",
  hermes: "Hermes",
  pi: "Pi",
  omp: "OMP",
  zcode: "ZCode",
};

export function harnessLabel(id) {
  if (HARNESS_NAMES[id]) return HARNESS_NAMES[id];
  return String(id)
    .replace(/-(usage|harness)$/u, "")
    .split(/[-_]/u)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Folder names for project paths; parent/name when two folders share a name. */
export function projectOptions(paths) {
  const base = (p) => String(p).split(/[\\/]+/u).filter(Boolean).at(-1) ?? String(p);
  const parent = (p) => String(p).split(/[\\/]+/u).filter(Boolean).at(-2);
  const counts = new Map();
  for (const p of paths) if (p !== null) counts.set(base(p), (counts.get(base(p)) ?? 0) + 1);
  return paths.map((p) =>
    p === null
      ? { value: NO_PROJECT, label: null, title: "" }
      : { value: p, label: counts.get(base(p)) > 1 && parent(p) ? `${parent(p)}/${base(p)}` : base(p), title: p },
  );
}

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function heatFrom(dayTotals) {
  const days = [];
  const today = Date.now();
  for (let i = HEATMAP_DAYS; i >= 0; i -= 1) {
    const day = dayKey(today - i * DAY_MS);
    days.push([day, dayTotals.get(day) ?? 0]);
  }
  return days;
}

// ------------------------------------------------------------- codexhost ---

function rpcUrl() {
  return new URL("api/ch/v1/rpc", document.baseURI).href;
}

async function rpc(method, params) {
  const response = await fetch(rpcUrl(), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.error) {
    const error = new Error(body?.error?.message ?? `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body.result;
}

// Shared per document: the new-session panel, page and widget reuse answers.
const memo = new Map();
const PENDING_REUSE_MS = 15_000;
function cached(key, ttlMs, load, refresh) {
  const hit = memo.get(key);
  const reusable = hit && (hit.pending ? Date.now() - hit.at < PENDING_REUSE_MS : !refresh && Date.now() - hit.at < ttlMs);
  if (reusable) return hit.promise;
  const entry = { at: Date.now(), pending: true, promise: null };
  const promise = load();
  entry.promise = promise;
  memo.set(key, entry);
  promise.then(
    () => {
      if (memo.get(key) === entry) {
        entry.at = Date.now();
        entry.pending = false;
      }
    },
    () => {
      if (memo.get(key) === entry) memo.delete(key);
    },
  );
  return promise;
}

const tokensOf = (x) => (x.inputTokens ?? 0) + (x.outputTokens ?? 0);
const hitRate = (x) => (x.cacheHitInputTokens ? x.cacheHitCachedInputTokens / x.cacheHitInputTokens : null);

async function codexhostQuota(refresh) {
  const accounts = await cached("accounts", 60_000, () => rpc("codexhost/account/list", {}), refresh);
  const list = accounts?.accounts ?? [];
  const out = [];
  for (const account of list) {
    const result = await cached(`quota:${account.accountId}`, 60_000, () => rpc("codexhost/account/usage/inspect", { accountId: account.accountId }), refresh).catch(() => null);
    const u = result?.usage;
    const windows = [];
    if (u?.planFiveHourUsedPercent !== undefined)
      windows.push({ kind: "fiveHour", used: u.planFiveHourUsedPercent, resetsAt: u.planFiveHourResetsAtUnix ? u.planFiveHourResetsAtUnix * 1000 : null });
    if (u?.planSevenDayUsedPercent !== undefined)
      windows.push({ kind: "sevenDay", used: u.planSevenDayUsedPercent, resetsAt: u.planSevenDayResetsAtUnix ? u.planSevenDayResetsAtUnix * 1000 : null });
    out.push({
      title: account.label || account.email || "Codex",
      plan: account.planType ?? null,
      updatedAt: result?.observedAt ? Date.parse(result.observedAt) : null,
      windows,
    });
  }
  return { kind: "accounts", accounts: list.length, limits: out };
}

export function codexhostSource() {
  return {
    id: "codexhost",
    ranges: RANGES,
    async load({ range, harness, project, refresh }) {
      const filters = {};
      if (harness && harness !== ALL) filters.harness = harness;
      if (project && project !== ALL) filters.project = project === NO_PROJECT ? null : project;
      let timeZone;
      try {
        timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        timeZone = undefined;
      }
      const params = { range, ...(timeZone ? { timeZone } : {}), ...filters };
      const key = (p) => `stats:${JSON.stringify(p)}`;
      const allParams = { ...params, range: "all" };
      const [main, all] = await Promise.all([
        cached(key(params), 15_000, () => rpc("codexhost/usage/statistics/get", params), refresh),
        range === "all" ? null : cached(key(allParams), 60_000, () => rpc("codexhost/usage/statistics/get", allParams), refresh),
      ]);
      return normalizeCodexhost(main, all ?? main);
    },
    loadQuota({ refresh } = {}) {
      return codexhostQuota(refresh);
    },
  };
}

function normalizeCodexhost(main, all) {
  const labels = new Map((main.modelLabels ?? []).map((m) => [m.model, m.label]));
  const modelLabel = (m) => (m === null ? null : labels.get(m) ?? m);
  const t = main.totals;
  const tokens = tokensOf(t);
  const active = new Set(main.daily.filter((d) => d.requests > 0).map((d) => d.date));
  const models = main.byModel
    .map((m) => ({ id: m.model, label: modelLabel(m.model), tokens: tokensOf(m), requests: m.requests, cacheRate: hitRate(m), cost: m.costUsd }))
    .sort((a, b) => b.tokens - a.tokens);
  const heat = new Map();
  for (const d of all.daily) heat.set(d.date, (heat.get(d.date) ?? 0) + tokensOf(d));
  const uncachedInput = Math.max(0, t.inputTokens - t.cachedInputTokens - t.cacheWriteInputTokens);
  return {
    source: "codexhost",
    reading: main.reading,
    ready: true,
    filters: main.filters,
    harnesses: main.options.harnesses.map((id) => ({ value: id, label: harnessLabel(id) })),
    projects: projectOptions(main.options.projects),
    cards: [
      { key: "cost", value: { usd: t.costUsd }, sub: t.unpricedRequests ? { unpriced: t.unpricedRequests } : null },
      { key: "requests", value: { int: t.requests } },
      { key: "tokenTotal", value: { compact: tokens, exact: tokens }, sub: { split: [["input", uncachedInput], ["output", t.outputTokens], ["cache", t.cachedInputTokens + t.cacheWriteInputTokens]] } },
      { key: "activeDays", value: { int: active.size } },
      { key: "cacheRate", value: { pct: hitRate(t) } },
      { key: "topModel", value: { text: models[0]?.label ?? null } },
    ],
    tokens,
    books: Math.round(tokens / TOKENS_PER_BOOK),
    heat: heatFrom(heat),
    models: models.map((m) => ({ ...m, share: tokens ? m.tokens / tokens : 0 })),
    harnessRows: main.byHarness
      .map((h) => ({ id: h.harness, label: harnessLabel(h.harness), tokens: tokensOf(h), requests: h.requests, cacheRate: hitRate(h), cost: h.costUsd }))
      .sort((a, b) => b.tokens - a.tokens)
      .map((h) => ({ ...h, share: tokens ? h.tokens / tokens : 0 })),
  };
}

// ------------------------------------------------------------ Codex logs ---

export function logSource(api) {
  return {
    id: "logs",
    ranges: RANGES,
    async load({ range, project, refresh }) {
      const r = await api.backend.invoke("usage.summary", {
        range,
        project: project && project !== ALL ? project : "all",
        refresh: Boolean(refresh),
      });
      if (!r.ready) return { source: "logs", ready: false, status: r.status };
      const o = r.overview;
      const heat = new Map(r.heatmap);
      return {
        source: "logs",
        ready: true,
        status: r.status,
        reading: { complete: r.status.state !== "scanning", read: r.status.done, sources: r.status.total },
        harnesses: [],
        projects: projectOptions(r.projects.map((p) => p.cwd)),
        cards: [
          { key: "sessions", value: { int: o.sessions }, sub: o.subSessions ? { subSessions: o.subSessions } : null },
          { key: "messages", value: { int: o.messages } },
          { key: "tokenTotal", value: { compact: o.tokens, exact: o.tokens }, sub: o.tokens ? { mainSub: [o.mainTokens, o.subTokens] } : null },
          { key: "activeDays", value: { int: o.activeDays } },
          { key: "cacheRate", value: { pct: o.cacheRate } },
          { key: "topModel", value: { text: o.topModel } },
        ],
        tokens: o.tokens,
        books: Math.round(o.tokens / TOKENS_PER_BOOK),
        heat: heatFrom(heat),
        models: r.models.map((m) => ({ id: m.model, label: m.model, tokens: m.tokens, requests: null, sessions: m.sessions, cacheRate: m.cacheRate, cost: null, share: m.share })),
        harnessRows: null,
        quota: {
          kind: "logs",
          limits: r.quota.map((l) => ({
            title: l.id,
            plan: l.plan,
            updatedAt: l.updatedAt,
            windows: [l.primary, l.secondary].filter(Boolean).map((w) => ({ kind: "window", minutes: w.windowMinutes, used: w.used, resetsAt: w.resetsAt, exhaustAt: w.exhaustAt, stale: w.stale })),
          })),
        },
      };
    },
  };
}

/** CH Web first (codexhost statistics); Codex logs on Desktop or if the gateway is missing. */
export function autoSource(api, { web }) {
  const logs = logSource(api);
  if (!web) return logs;
  const host = codexhostSource();
  let useLogs = false;
  return {
    get id() {
      return useLogs ? "logs" : "codexhost";
    },
    ranges: RANGES,
    async load(query) {
      if (!useLogs) {
        try {
          return await host.load(query);
        } catch (error) {
          // 401/403 are real errors in CH Web; 404/503 mean an older Host without the gateway.
          if (error.status !== 404 && error.status !== 503) throw error;
          useLogs = true;
        }
      }
      return logs.load(query);
    },
    loadQuota(query) {
      return useLogs ? null : host.loadQuota(query);
    },
  };
}
