// SPDX-License-Identifier: GPL-3.0-only
// Prism Facets — usage statistics view, shared by the settings page, the
// widget and the CH Web new-session panel. Data comes from a source in
// shared/usage-sources.mjs (codexhost statistics in CH Web, Codex logs on
// Desktop), normalised into one model.

import { h } from "./dom.mjs";
import { ALL, NO_PROJECT, autoSource } from "./usage-sources.mjs";

const POLL_MS = 1500;
const MAX_POLLS = 40;

// Remounts (especially the CH Web home panel) reuse the last matching model
// while its source refreshes in the background. Quota is account-wide, not
// filter-specific, so it has one cache entry per host/source.
const dataCache = new Map();
const quotaCache = new Map();

export function formatCompact(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const fix = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$|(\.\d*?)0+$/u, "$1");
  if (abs >= 1e9) return `${fix(n / 1e9)}B`;
  if (abs >= 1e6) return `${fix(n / 1e6)}M`;
  if (abs >= 1e4) return `${fix(n / 1e3)}K`;
  return Math.round(n).toLocaleString("en-US");
}

const int = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—");
const pct = (r, digits = 1) => (r === null || r === undefined ? "—" : `${(r * 100).toFixed(digits)}%`);
const usd = (n) => (Number.isFinite(n) ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");

function relTime(ms, t) {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return t("justNow");
  if (min < 60) return t("minutesAgo").replace("{n}", min);
  const hours = Math.round(min / 60);
  if (hours < 48) return t("hoursAgo").replace("{n}", hours);
  return t("daysAgo").replace("{n}", Math.round(hours / 24));
}

function fmtDate(ms, locale) {
  try {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function windowLabel(w, t) {
  if (w.kind === "fiveHour") return t("fiveHourWindow");
  if (w.kind === "sevenDay") return t("sevenDayWindow");
  const minutes = w.minutes;
  if (!minutes) return t("quotaWindow");
  if (minutes === 10080) return t("weekly");
  if (minutes % 1440 === 0) return t("nDays").replace("{n}", minutes / 1440);
  if (minutes % 60 === 0) return t("nHours").replace("{n}", minutes / 60);
  return t("nMinutes").replace("{n}", minutes);
}

/**
 * Mount the usage view into `container`.
 * `api` needs `backend.invoke`, `locale` and `hostTarget` ("web" | "desktop").
 * opts.compact: denser (widget); opts.home: new-session panel styling;
 * opts.onClose: adds a hide button.
 */
export function mountUsageView(container, api, getT, opts = {}) {
  const source = opts.source ?? autoSource(api, { web: api.hostTarget === "web" });
  const cacheScope = opts.source ? source.id : api.hostTarget;
  let tab = "overview";
  let range = "30d";
  let harness = ALL;
  let project = ALL;
  const query = (refresh = false) => ({ range, harness, project, refresh });
  const queryKey = (q) => JSON.stringify([cacheScope, q.range, q.harness, q.project]);
  let activeKey = queryKey(query());
  let data = dataCache.get(activeKey) ?? null;
  let error = null;
  let loading = false;
  let quotaData = quotaCache.get(cacheScope) ?? data?.quota ?? null;
  let quotaError = null;
  let quotaLoading = false;
  let quotaRequestId = 0;
  let timer = 0;
  let polls = 0;
  let disposed = false;
  let requestId = 0;
  const t = (k) => getT()(k);

  async function load(refresh = false, poll = false) {
    clearTimeout(timer);
    if (!poll) polls = 0;
    const q = query(refresh);
    const key = queryKey(q);
    if (key !== activeKey) {
      data = null;
      error = null;
    }
    activeKey = key;
    data = dataCache.get(key) ?? data;
    const id = ++requestId;
    loading = true;
    render();
    try {
      const result = await source.load(q);
      if (disposed || id !== requestId) return;
      data = result;
      dataCache.set(key, result);
      error = null;
      if (result.source === "logs") {
        // A Host quota request still in flight belongs to the old source.
        quotaRequestId += 1;
        quotaLoading = false;
        quotaData = result.quota ?? null;
        if (result.quota) quotaCache.set(cacheScope, result.quota);
        else quotaCache.delete(cacheScope);
        quotaError = null;
      }
    } catch (e) {
      if (disposed || id !== requestId) return;
      error = e;
      if (source.id === "logs") {
        quotaRequestId += 1;
        quotaLoading = false;
        quotaError = e;
      }
    }
    loading = false;
    render();
    const pending = data && (!data.ready || data.reading?.complete === false);
    if (!error && pending && polls < MAX_POLLS) {
      polls += 1;
      timer = setTimeout(() => load(true, true), POLL_MS);
    }
  }

  async function loadQuota(refresh = false) {
    // Desktop's log summary already includes quota. Reuse it instead of
    // starting another scan; the normal statistics load will update it.
    if (source.id === "logs" || !source.loadQuota) {
      quotaRequestId += 1;
      quotaData = data?.quota ?? quotaCache.get(cacheScope) ?? null;
      if (error) quotaError = error;
      quotaLoading = false;
      render();
      return;
    }
    const id = ++quotaRequestId;
    quotaLoading = true;
    render();
    try {
      const result = await source.loadQuota(query(refresh));
      if (disposed || id !== quotaRequestId) return;
      if (result?.kind === "accounts" && source.id === "logs") return;
      quotaData = result;
      if (result) quotaCache.set(cacheScope, result);
      else quotaCache.delete(cacheScope);
      quotaError = null;
    } catch (e) {
      if (disposed || id !== quotaRequestId) return;
      quotaError = e;
    }
    quotaLoading = false;
    render();
  }

  // ---- toolbar ---------------------------------------------------------------
  function select(label, value, options, onPick, allLabel) {
    const el = h(
      "select",
      { class: "pu-select", "aria-label": label, title: label, onChange: (e) => onPick(e.target.value) },
      h("option", { value: ALL }, allLabel),
      options.map((o) => h("option", { value: o.value, title: o.title ?? o.label ?? "" }, o.label ?? t("noProject"))),
    );
    if (value !== ALL && !options.some((o) => o.value === value)) el.append(h("option", { value }, value === NO_PROJECT ? t("noProject") : value));
    el.value = value;
    return el;
  }

  function toolbar() {
    const tabs = [["overview", t("usageOverview")], ["models", t("usageModels")]];
    if (data?.harnessRows) tabs.push(["harness", t("usageHarness")]);
    tabs.push(["quota", t("usageQuota")]);
    const ranges = [
      ["today", t("rangeToday")],
      ["7d", t("range7")],
      ["30d", t("range30")],
      ["90d", t("range90")],
      ["all", t("rangeAll")],
    ];
    const harnesses = data?.harnesses ?? [];
    return h(
      "div",
      { class: "pu-toolbar" },
      h(
        "div",
        { class: "pu-pills", role: "tablist" },
        tabs.map(([id, label]) =>
          h("button", { type: "button", role: "tab", class: tab === id ? "is-on" : "", "aria-selected": tab === id ? "true" : "false", onClick: () => { tab = id; if (id === "quota") loadQuota(); else render(); } }, label),
        ),
      ),
      h("span", { class: "pu-spacer" }),
      h("button", { type: "button", class: `pu-icon${loading || quotaLoading ? " is-spin" : ""}`, title: t("refresh"), "aria-label": t("refresh"), onClick: () => { load(true); if (tab === "quota") loadQuota(true); } }, "↻"),
      opts.onClose ? h("button", { type: "button", class: "pu-close", title: t("homeStatsHide"), "aria-label": t("homeStatsHide"), onClick: () => opts.onClose() }, "×") : null,
      tab === "quota"
        ? null
        : h(
            "div",
            { class: "pu-filters" },
            h(
              "div",
              { class: "pu-pills pu-pills--range" },
              ranges.map(([id, label]) =>
                h("button", { type: "button", class: range === id ? "is-on" : "", "aria-pressed": range === id ? "true" : "false", onClick: () => { range = id; load(); } }, label),
              ),
            ),
            h("span", { class: "pu-spacer" }),
            harnesses.length > 1
              ? select(t("harness"), harness, harnesses, (v) => { harness = v; load(); }, t("allHarnesses"))
              : null,
            select(t("usageProject"), project, data?.projects ?? [], (v) => { project = v; load(); }, t("allProjects")),
          ),
    );
  }

  // ---- overview ----------------------------------------------------------------
  function cardValue(v) {
    if (!v) return "—";
    if ("usd" in v) return usd(v.usd);
    if ("int" in v) return int(v.int);
    if ("pct" in v) return pct(v.pct);
    if ("compact" in v) return formatCompact(v.compact);
    return v.text ?? "—";
  }

  function cardSub(sub) {
    if (!sub) return null;
    if (sub.unpriced) return h("div", { class: "pu-card__sub" }, t("unpriced").replace("{n}", int(sub.unpriced)));
    if (sub.subSessions) return h("div", { class: "pu-card__sub" }, `+${int(sub.subSessions)} ${t("subAgentSessions")}`);
    if (sub.mainSub) {
      const [main, subT] = sub.mainSub;
      const total = main + subT || 1;
      return h("div", { class: "pu-card__sub" }, `${t("mainSession")} ${Math.round((main / total) * 100)}% · ${t("subAgent")} ${Math.round((subT / total) * 100)}%`);
    }
    if (sub.split)
      return h(
        "div",
        { class: "pu-split" },
        sub.split.map(([k, n]) => h("span", null, h("em", null, t(k)), formatCompact(n))),
      );
    return null;
  }

  function card(c) {
    const value = cardValue(c.value);
    const exact = c.value?.exact !== undefined ? int(c.value.exact) : value;
    return h("div", { class: "pu-card" }, h("div", { class: "pu-card__label" }, t(c.key)), h("div", { class: "pu-card__value", title: exact }, value), cardSub(c.sub));
  }

  function heatmap(days) {
    const nonzero = days.map((d) => d[1]).filter(Boolean).sort((a, b) => a - b);
    const q = (p) => nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))] ?? 0;
    const cuts = [q(0.25), q(0.5), q(0.75)];
    const level = (v) => (!v ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
    const first = new Date(`${days[0]?.[0] ?? "2026-01-01"}T12:00:00`);
    const lead = (first.getDay() + 6) % 7; // weeks start on Monday
    const cells = [...Array(lead).fill(null), ...days];
    return h(
      "div",
      { class: "pu-heatwrap" },
      h(
        "div",
        { class: "pu-heat", role: "img", "aria-label": t("heatmapLabel"), style: { "--cols": String(Math.ceil(cells.length / 7)) } },
        cells.map((d) => (d ? h("span", { class: `pu-heat__c l${level(d[1])}`, title: `${d[0]} · ${formatCompact(d[1])} tokens` }) : h("span", { class: "pu-heat__c is-pad" }))),
        nonzero.length ? null : h("span", { class: "pu-heat__empty" }, t("noActivity")),
      ),
      h("div", { class: "pu-legend", "aria-hidden": "true" }, t("less"), [0, 1, 2, 3, 4].map((l) => h("span", { class: `pu-heat__c l${l}` })), t("more")),
    );
  }

  function overview() {
    return h(
      "div",
      { class: "pu-body" },
      h("div", { class: "pu-cards" }, data.cards.map(card)),
      heatmap(data.heat),
      data.tokens ? h("p", { class: "pu-fun" }, t("funBooks").replace("{n}", int(data.books))) : null,
    );
  }

  // ---- tables ------------------------------------------------------------------
  function table(rows, nameLabel) {
    if (!rows.length) return h("div", { class: "pu-body" }, h("p", { class: "pu-empty" }, t("noActivity")));
    const hasCost = rows.some((r) => r.cost !== null && r.cost !== undefined);
    const hasRequests = rows.some((r) => r.requests !== null && r.requests !== undefined);
    const cols = ["name", "share", "tokens", hasRequests ? "requests" : "sessions", "cache", ...(hasCost ? ["cost"] : [])];
    const head = {
      name: nameLabel,
      share: t("share"),
      tokens: "Tokens",
      requests: t("requests"),
      sessions: t("sessions"),
      cache: t("cacheRateShort"),
      cost: t("cost"),
    };
    const cell = (r, c) => {
      if (c === "name") return h("span", { class: "pu-mname", title: r.id ?? r.label }, r.label ?? t("unknownModel"));
      if (c === "share")
        return h("span", { class: "pu-bar" }, h("span", { class: "pu-bar__fill", style: { width: `${Math.max(2, r.share * 100).toFixed(1)}%` } }), h("span", { class: "pu-bar__text" }, pct(r.share, 0)));
      if (c === "tokens") return h("span", { class: "pu-num", title: int(r.tokens) }, formatCompact(r.tokens));
      if (c === "requests") return h("span", { class: "pu-num" }, int(r.requests));
      if (c === "sessions") return h("span", { class: "pu-num" }, int(r.sessions));
      if (c === "cache") return h("span", { class: "pu-num" }, pct(r.cacheRate, 0));
      return h("span", { class: "pu-num" }, r.cost ? usd(r.cost) : "—");
    };
    return h(
      "div",
      { class: `pu-body pu-models pu-cols-${cols.length}` },
      h("div", { class: "pu-mrow pu-mrow--head" }, cols.map((c) => h("span", null, head[c]))),
      rows.map((r) => h("div", { class: "pu-mrow" }, cols.map((c) => cell(r, c)))),
    );
  }

  // ---- quota ---------------------------------------------------------------------
  function quotaWindow(w) {
    const notes = [];
    if (w.resetsAt) notes.push(`${t("resetsAt")} ${fmtDate(w.resetsAt, api.locale)}`);
    if (w.exhaustAt && !w.stale) notes.push(`${t("exhaustAt")} ${fmtDate(w.exhaustAt, api.locale)}`);
    if (w.stale) notes.push(t("quotaStale"));
    const used = Math.min(100, Math.max(0, w.used));
    return h(
      "div",
      { class: `pu-q${used >= 90 ? " is-hot" : used >= 70 ? " is-warm" : ""}${w.stale ? " is-stale" : ""}` },
      h("div", { class: "pu-q__top" }, h("span", null, windowLabel(w, t)), h("strong", null, `${used.toFixed(0)}%`)),
      h("span", { class: "pu-q__bar" }, h("span", { class: "pu-q__fill", style: { width: `${used}%` } })),
      notes.length ? h("div", { class: "pu-q__note" }, notes.join(" · ")) : null,
    );
  }

  function logTerminal() {
    const log = source.id === "logs" && data?.source === "logs" ? data : null;
    if (!log) return null;
    if (log.status?.state === "error") return `${t("usageError")} ${log.status.error ?? ""}`;
    if (log.ready === false && log.status?.state === "ready" && log.status?.total === 0) return t("usageNoLogs");
    return null;
  }

  function quota() {
    const q = quotaData;
    const terminal = logTerminal();
    if (terminal && !q?.limits?.length) {
      return h("div", { class: "pu-body" }, h("p", { class: "pu-empty" }, terminal));
    }
    if (!q) {
      return h("div", { class: "pu-body" }, h("p", { class: "pu-empty" }, quotaError ? t("quotaError") : t("usageLoading")));
    }
    if (!q.limits.length) {
      const msg = q.kind === "accounts" ? (q.error ? t("quotaError") : t("noQuotaAccounts")) : t("noQuota");
      return h("div", { class: "pu-body" }, h("p", { class: "pu-empty" }, msg));
    }
    return h(
      "div",
      { class: "pu-body pu-quota" },
      q.limits.map((l) =>
        h(
          "div",
          { class: "pu-qcard" },
          h(
            "div",
            { class: "pu-qcard__head" },
            h("strong", null, l.title),
            l.plan ? h("span", { class: "pu-tag" }, l.plan) : null,
            h("span", { class: "pu-spacer" }),
            l.updatedAt ? h("span", { class: "pu-muted" }, `${t("updated")} ${relTime(l.updatedAt, t)}`) : null,
          ),
          l.windows.length ? l.windows.map(quotaWindow) : h("p", { class: "pu-muted pu-small" }, t("noQuota")),
        ),
      ),
      h("p", { class: "pu-muted pu-small" }, q.kind === "accounts" ? t("quotaHintHost") : t("quotaHint")),
    );
  }

  // ---- status --------------------------------------------------------------------
  function errorStatus(e) {
    const msg = String(e?.message ?? e);
    const text = e?.status === 401 || e?.status === 403 ? t("usageAuth") : /backend/iu.test(msg) ? t("usageNoBackend") : `${t("usageError")} ${msg}`;
    return h("p", { class: "pu-status is-error" }, text);
  }

  function statusLine() {
    if (tab === "quota") {
      if (quotaError) return errorStatus(quotaError);
      const terminal = logTerminal();
      if (terminal) return h("p", { class: `pu-status${data?.status?.state === "error" ? " is-error" : ""}` }, terminal);
      const sourceId = source.id === "logs" ? "logs" : "codexhost";
      return h("p", { class: "pu-status" }, quotaData ? (sourceId === "codexhost" ? t("sourceHost") : t("sourceLogs")) : t("usageLoading"));
    }
    if (error) return errorStatus(error);
    if (!data) return h("p", { class: "pu-status" }, t("usageLoading"));
    const parts = [data.source === "codexhost" ? t("sourceHost") : t("sourceLogs")];
    const r = data.reading;
    if (r && r.complete === false) {
      const label = data.source === "codexhost" ? t("hostReading") : t("usageScanning");
      parts.push(r.sources ? `${label} ${r.read}/${r.sources}` : label);
    }
    if (data.status?.state === "error") parts.push(`${t("usageError")} ${data.status.error ?? ""}`);
    return h(
      "p",
      { class: "pu-status" },
      r && r.complete === false ? h("span", { class: "pu-progress" }, h("span", { style: { width: `${r.sources ? (r.read / r.sources) * 100 : 0}%` } })) : null,
      parts.join(" · "),
    );
  }

  function render() {
    if (disposed) return;
    let body;
    if (tab === "quota") {
      body = quota();
    } else if (data?.ready) {
      if (tab === "harness" && !data.harnessRows) tab = "overview";
      body = tab === "overview" ? overview() : tab === "models" ? table(data.models, t("model")) : table(data.harnessRows, t("harness"));
    } else if (data && !data.ready && data.status?.state === "ready" && data.status?.total === 0) {
      body = h("div", { class: "pu-body" }, h("p", { class: "pu-empty" }, t("usageNoLogs")));
    } else {
      body = h("div", { class: "pu-body" }, h("div", { class: "pu-cards" }, Array.from({ length: 6 }, () => h("div", { class: "pu-card is-ghost" }))));
    }
    const cls = `pu${opts.compact ? " pu--compact" : ""}${opts.home ? " pu--home" : ""}`;
    container.replaceChildren(h("div", { class: cls }, toolbar(), body, statusLine()));
  }

  render();
  load();

  return {
    rerender: render,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      container.replaceChildren();
    },
  };
}
