/**
 * Dashboard page — one HTML string served by server.ts.
 *
 * Design notes (antislop R-31, one line each):
 * - OpenCode default theme palette (packages/tui theme "opencode"), both
 *   variants behind --oc-* CSS vars defined in tailwind.css: dark + light,
 *   switched by [data-theme] on <html> from the header toggle (persisted in
 *   localStorage, defaults to prefers-color-scheme). No raw hex in the page.
 * - Token semantics match analytics.ts: avoided = never entered the context
 *   window (green), returned = what the model re-read (amber). The receipt
 *   bar prices the difference with the snapshot's per-token rate.
 * - Numbers carry the page: one hero, KPI cards, bars and a heatmap; prose
 *   is one short line per section, nothing more.
 * - Filters (range + adapter) are client-side over the 90-day series; "all"
 *   switches to the lifetime totals. Heatmap and per-tool/per-project tables
 *   are lifetime/all-time and say so.
 * - IBM Plex Sans / Instrument Serif / IBM Plex Mono: the product's fonts.
 * - MOTION 1: hover brightening only. No loops, no pulses.
 */

import { dashboardCss } from "./styles.js";

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>open-context-mode dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Instrument+Serif&display=swap" rel="stylesheet">
<style>${dashboardCss}</style>
<script>
// Set the theme before first paint so a light-mode reload never flashes dark.
(function () {
  try {
    var t = localStorage.getItem("open_ctx-dash-theme");
    if (t !== "light" && t !== "dark") t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
</script>
</head>
<body class="bg-[var(--oc-bg)] text-[var(--oc-text)] font-sans antialiased min-h-screen">
<div class="max-w-6xl mx-auto px-5 py-8 md:py-12">

  <header class="flex items-baseline justify-between gap-4 mb-6">
    <div>
      <p class="font-mono text-xs text-[var(--oc-muted)]">open-context-mode</p>
      <h1 class="font-serif text-3xl text-[var(--oc-text)] mt-1">Local dashboard</h1>
    </div>
    <div class="flex items-center gap-4 shrink-0">
      <button id="theme-toggle" type="button" class="border border-[var(--oc-border)] rounded-sm px-2.5 py-1 font-mono text-xs text-[var(--oc-muted)] hover:border-[var(--oc-border-strong)] hover:text-[var(--oc-text)] transition-colors" aria-label="Toggle color theme">light</button>
      <p id="status" class="font-mono text-xs text-[var(--oc-muted)] flex items-center gap-2 shrink-0" role="status" aria-live="polite">
        <span id="dot" class="inline-block w-2 h-2 rounded-sm bg-[var(--oc-muted)]"></span>
        <span id="status-text">connecting</span>
      </p>
    </div>
  </header>

  <div id="controls" class="flex flex-wrap items-center gap-x-6 gap-y-3 mb-8"></div>

  <main id="main">
    <section class="rounded-md bg-[var(--oc-panel)] px-6 py-10">
      <p class="font-mono text-xs text-[var(--oc-muted)]">Loading your local SQLite data</p>
    </section>
  </main>

  <footer class="mt-10 font-mono text-xs text-[var(--oc-muted)] leading-relaxed">
    <p>Read-only view of the SQLite stores under your adapter config dirs. Nothing is written or uploaded.</p>
    <p class="mt-1">Started from <span class="text-[var(--oc-text)]">open-context-mode dashboard</span>; press Ctrl+C in that terminal to stop this server.</p>
  </footer>

</div>
<script>
(function () {
  "use strict";
  var state = null;
  var range = "30";
  var adapterSel = "all";
  var openSessions = {};
  var lastUpdate = 0;
  var main = document.getElementById("main");
  var controls = document.getElementById("controls");
  var dot = document.getElementById("dot");
  var statusText = document.getElementById("status-text");

  var RANGES = [["7", "7d"], ["30", "30d"], ["90", "90d"], ["all", "all"]];
  var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function fmtInt(n) { return new Intl.NumberFormat("en-US").format(n || 0); }
  function fmtTokens(n) {
    return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n || 0);
  }
  function fmtBytes(n) {
    n = n || 0;
    if (n < 1024) return fmtInt(n) + " B";
    var units = ["KB", "MB", "GB", "TB"], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + " " + units[i];
  }
  function fmtUsd(n) {
    if (!n || n <= 0) return "$0";
    if (n < 0.01) return "<$0.01";
    if (n < 100) return "$" + n.toFixed(2);
    return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
  }
  function fmtDate(ms) {
    if (!ms) return "";
    return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }
  function parseUtc(s) {
    if (!s) return 0;
    var t = String(s).replace(" ", "T");
    if (t.indexOf("Z") < 0 && t.indexOf("+") < 0) t += "Z";
    var ms = Date.parse(t);
    return Number.isNaN(ms) ? 0 : ms;
  }
  function ago(ms) {
    if (!ms) return "";
    var s = Math.max(1, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function titleCase(s) {
    return s.replace(/[-_]/g, " ").replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
  }
  function baseName(p) {
    return String(p || "").replace(/\\\\+$/, "").split("/").pop() || p;
  }
  function toolName(t) {
    var parts = String(t || "").split("__");
    return titleCase(parts[parts.length - 1]);
  }
  function pill(label, active) {
    return 'border rounded-sm px-2.5 py-1 font-mono text-xs transition-colors '
      + (active ? 'border-[var(--oc-primary)] text-[var(--oc-primary)]' : 'border-[var(--oc-border)] text-[var(--oc-muted)] hover:border-[var(--oc-border-strong)] hover:text-[var(--oc-text)]');
  }

  function setStatus(kind, text) {
    dot.className = "inline-block w-2 h-2 rounded-sm " + (kind === "live" ? "bg-[var(--oc-success)]" : kind === "lost" ? "bg-[var(--oc-warning)]" : "bg-[var(--oc-muted)]");
    statusText.textContent = text;
  }

  // ── Theme toggle: the button shows the mode it switches TO. ──
  var themeToggle = document.getElementById("theme-toggle");
  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }
  function syncThemeButton() {
    themeToggle.textContent = currentTheme() === "light" ? "dark" : "light";
  }
  themeToggle.addEventListener("click", function () {
    var next = currentTheme() === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("open_ctx-dash-theme", next); } catch (e) { /* private mode */ }
    syncThemeButton();
  });
  syncThemeButton();

  // ── Range/adapter-aware token math ──
  function rangeDays() { return range === "all" ? 0 : Number(range); }

  function tokens() {
    var av = 0, ret = 0, events = 0;
    if (range === "all") {
      (state.realBytes.perAdapter || []).forEach(function (r) {
        if (adapterSel !== "all" && r.name !== adapterSel) return;
        av += Math.floor((r.bytesAvoided || 0) / 4);
        ret += Math.floor((r.bytesReturned || 0) / 4);
      });
      state.lifetime.perAdapter.forEach(function (a) {
        if (adapterSel !== "all" && a.name !== adapterSel) return;
        events += a.eventCount;
      });
      return { avoided: av, returned: ret, events: events };
    }
    var n = rangeDays();
    state.byDay.slice(-n).forEach(function (d) {
      if (adapterSel !== "all") {
        var per = d.perAdapter[adapterSel] || [0, 0, 0];
        events += per[0]; av += per[1]; ret += per[2];
      } else {
        events += d.count; av += d.avoided; ret += d.returned;
      }
    });
    return { avoided: av, returned: ret, events: events };
  }

  function firstMs() {
    var first = 0;
    state.lifetime.perAdapter.forEach(function (a) { if (a.firstMs && (!first || a.firstMs < first)) first = a.firstMs; });
    return first;
  }

  // ── Sections ──
  function heroHtml(t) {
    var usd = t.avoided * (state.pricing.usdPerMillionTokens || 0) / 1e6;
    var since = firstMs();
    return '<section class="rounded-md bg-[var(--oc-panel)] px-6 py-10 md:px-10 md:py-12">'
      + '<p class="font-mono text-xs text-[var(--oc-muted)] mb-3">Tokens kept out of your context window</p>'
      + '<p class="font-serif text-[var(--oc-primary)] text-5xl md:text-7xl leading-none">' + esc(fmtTokens(t.avoided)) + '</p>'
      + '<p class="mt-4 text-sm text-[var(--oc-muted)]">'
      + fmtBytes(t.avoided * 4) + ' indexed into local SQLite'
      + ' \\u00b7 <span class="text-[var(--oc-success)]">' + fmtUsd(usd) + ' estimated saved</span>'
      + (since ? ' \\u00b7 since ' + esc(fmtDate(since)) : '')
      + '</p></section>';
  }

  function receiptHtml(t) {
    var without = t.avoided + t.returned;
    if (without <= 0) return "";
    var withPct = Math.max(1, Math.round((t.returned / without) * 100));
    var savedPct = Math.max(0, 100 - withPct);
    var usd = t.avoided * (state.pricing.usdPerMillionTokens || 0) / 1e6;
    function row(label, val, pct, cls) {
      return '<div class="flex items-center gap-4">'
        + '<p class="w-36 shrink-0 font-mono text-xs text-[var(--oc-muted)]">' + label + '</p>'
        + '<div class="flex-1 h-6 rounded-sm bg-[var(--oc-element)] overflow-hidden">'
        + '<div class="h-6 rounded-sm ' + cls + '" style="width:' + pct + '%"></div></div>'
        + '<p class="w-24 shrink-0 text-right font-mono text-xs">' + esc(fmtTokens(val)) + '</p></div>';
    }
    return '<section class="mt-3 rounded-md bg-[var(--oc-panel)] px-6 py-6 md:px-8">'
      + '<h2 class="font-mono text-xs text-[var(--oc-muted)] mb-4">The receipt \\u2014 what the model re-read</h2>'
      + row("without open-context-mode", without, 100, "bg-[var(--oc-error-soft)]")
      + '<div class="h-2"></div>'
      + row("with open-context-mode", t.returned, withPct, "bg-[var(--oc-success)]")
      + '<p class="mt-4 text-sm text-[var(--oc-muted)]"><span class="text-[var(--oc-success)] font-medium">' + savedPct + '% smaller</span>'
      + ' \\u00b7 <span class="text-[var(--oc-text)]">' + fmtTokens(t.avoided) + '</span> tokens never entered'
      + ' \\u00b7 <span class="text-[var(--oc-success)]">' + fmtUsd(usd) + '</span> saved at $' + fmtInt(state.pricing.usdPerMillionTokens) + '/M</p>'
      + '</section>';
  }

  function kpisHtml() {
    var projects = 0;
    state.lifetime.perAdapter.forEach(function (a) { projects += a.projectDirs.length; });
    var last = 0;
    state.lifetime.perAdapter.forEach(function (a) { if (a.lastMs > last) last = a.lastMs; });
    var items = [
      ["Events", fmtInt(state.lifetime.totalEvents)],
      ["Sessions", fmtInt(state.lifetime.totalSessions)],
      ["Projects", fmtInt(projects)],
      ["Adapters", fmtInt(state.lifetime.perAdapter.length)],
      ["Rescued", fmtBytes(state.realBytes.snapshotBytes)]
    ];
    return '<section class="mt-3 grid grid-cols-2 md:grid-cols-5 gap-3">'
      + items.map(function (it) {
          return '<div class="rounded-md bg-[var(--oc-panel)] border border-[var(--oc-border)] px-4 py-3">'
            + '<p class="font-mono text-xs text-[var(--oc-muted)]">' + esc(it[0]) + '</p>'
            + '<p class="text-xl mt-1 font-medium">' + esc(it[1]) + '</p></div>';
        }).join("")
      + (last ? '<p class="col-span-2 md:col-span-5 font-mono text-xs text-[var(--oc-muted)]">lifetime totals \\u00b7 last event ' + esc(fmtDate(last)) + "</p>" : "")
      + '</section>';
  }

  function timelineHtml() {
    var n = range === "all" ? state.byDay.length : rangeDays();
    var data = state.byDay.slice(-n);
    var max = 1;
    data.forEach(function (d) { var tot = (adapterSel !== "all" ? sumAdapter(d)[1] + sumAdapter(d)[2] : d.avoided + d.returned); if (tot > max) max = tot; });
    var bars = data.map(function (d) {
      var av, ret;
      if (adapterSel !== "all") { var p = sumAdapter(d); av = p[1]; ret = p[2]; }
      else { av = d.avoided; ret = d.returned; }
      var tot = av + ret;
      var h = tot === 0 ? 0 : Math.max(3, Math.round((tot / max) * 100));
      var avH = tot === 0 ? 0 : Math.round((av / tot) * 100);
      var label = d.day + " \\u00b7 " + fmtTokens(av) + " avoided \\u00b7 " + fmtTokens(ret) + " returned";
      return '<div class="flex-1 h-full flex flex-col justify-end group" title="' + esc(label) + '">'
        + '<div class="w-full rounded-t-sm bg-[var(--oc-warning)] group-hover:bg-[var(--oc-warning)]/80 transition-colors" style="height:' + (100 - avH) * h / 100 + '%"></div>'
        + '<div class="w-full rounded-b-sm bg-[var(--oc-success)] group-hover:bg-[var(--oc-success)]/80 transition-colors" style="height:' + avH * h / 100 + '%"></div></div>';
    }).join("");
    return '<section class="mt-10">'
      + '<h2 class="font-serif text-2xl">Tokens per day</h2>'
      + '<p class="font-mono text-xs text-[var(--oc-muted)] mt-1"><span class="text-[var(--oc-success)]">\\u2588 avoided</span> <span class="text-[var(--oc-warning)]">\\u2588 returned</span>' + (range === "all" ? " \\u00b7 showing last 90 days" : "") + '</p>'
      + '<div class="mt-4 flex items-end gap-[2px] h-44">'
      + bars + '</div>'
      + '<div class="flex justify-between font-mono text-xs text-[var(--oc-muted)] mt-2"><span>' + esc(data[0].day) + '</span><span>peak ' + fmtTokens(max) + '/day</span><span>today</span></div>'
      + '</section>';
  }
  function sumAdapter(d) { return d.perAdapter[adapterSel] || [0, 0, 0]; }

  function toolsHtml() {
    var rows = state.byTool.filter(function (t) { return adapterSel === "all" || t.adapter === adapterSel; });
    if (rows.length === 0) return "";
    var max = 1;
    rows.forEach(function (t) { if (t.tokensReturned > max) max = t.tokensReturned; });
    var lis = rows.map(function (t) {
      return '<li class="py-2">'
        + '<div class="flex justify-between text-sm gap-4"><span class="truncate">' + esc(toolName(t.tool)) + '</span>'
        + '<span class="font-mono text-xs text-[var(--oc-muted)] shrink-0">' + fmtInt(t.calls) + ' calls \\u00b7 ' + fmtTokens(t.tokensReturned) + ' tk</span></div>'
        + '<div class="mt-1 h-1.5 rounded-sm bg-[var(--oc-element)]"><div class="h-1.5 rounded-sm bg-[var(--oc-secondary)]" style="width:' + Math.max(2, Math.round((t.tokensReturned / max) * 100)) + '%"></div></div>'
        + '</li>';
    }).join("");
    return '<section class="mt-10">'
      + '<h2 class="font-serif text-2xl">Tokens by tool</h2>'
      + '<p class="font-mono text-xs text-[var(--oc-muted)] mt-1">what the model re-read per tool \\u00b7 all time</p>'
      + '<ul class="mt-4">' + lis + '</ul></section>';
  }

  function categoriesHtml() {
    if (state.byCategory.length === 0) return "";
    var max = 1;
    state.byCategory.forEach(function (c) { if (c.count > max) max = c.count; });
    var rows = state.byCategory.map(function (c) {
      return '<li class="py-2">'
        + '<div class="flex justify-between text-sm gap-4"><span class="truncate">' + esc(c.label) + '</span><span class="font-mono text-xs text-[var(--oc-muted)] shrink-0">' + fmtInt(c.count) + '</span></div>'
        + '<div class="mt-1 h-1.5 rounded-sm bg-[var(--oc-element)]"><div class="h-1.5 rounded-sm bg-[var(--oc-accent)]" style="width:' + Math.max(2, Math.round((c.count / max) * 100)) + '%"></div></div>'
        + '</li>';
    }).join("");
    return '<section class="mt-10">'
      + '<h2 class="font-serif text-2xl">Session composition</h2>'
      + '<p class="font-mono text-xs text-[var(--oc-muted)] mt-1">events by category \\u00b7 all time</p>'
      + '<ul class="mt-4">' + rows + '</ul></section>';
  }

  function heatHtml() {
    var maxT = 0;
    state.heat.forEach(function (c) { if (c.t > maxT) maxT = c.t; });
    if (maxT <= 0) return "";
    var order = [1, 2, 3, 4, 5, 6, 0];
    var grid = order.map(function (w) {
      var cells = "";
      for (var h = 0; h < 24; h++) {
        var c = state.heat[w * 24 + h] || { e: 0, t: 0 };
        var a = c.t === 0 ? 0 : 0.08 + 0.92 * Math.pow(c.t / maxT, 0.6);
        var label = DAY_NAMES[w] + " " + String(h).padStart(2, "0") + ":00 \\u00b7 " + fmtInt(c.e) + " events \\u00b7 " + fmtTokens(c.t) + " tokens";
        cells += '<div class="h-4 rounded-[2px]" style="background-color:color-mix(in srgb, var(--oc-primary) ' + (a * 100).toFixed(1) + '%, transparent)" title="' + esc(label) + '"></div>';
      }
      return '<div class="flex items-center gap-2"><span class="w-8 font-mono text-[10px] text-[var(--oc-muted)] text-right">' + DAY_NAMES[w] + '</span>'
        + '<div class="grid grid-cols-24 gap-[3px] flex-1">' + cells + '</div></div>';
    }).join("");
    var hourLabels = "";
    for (var h = 0; h < 24; h += 6) {
      hourLabels += '<span class="font-mono text-[10px] text-[var(--oc-muted)]">' + String(h).padStart(2, "0") + '</span>';
    }
    return '<section class="mt-10">'
      + '<h2 class="font-serif text-2xl">When you work</h2>'
      + '<p class="font-mono text-xs text-[var(--oc-muted)] mt-1">tokens by weekday \\u00d7 hour, local time \\u00b7 all time</p>'
      + '<div class="mt-4 space-y-[3px]">' + grid + '</div>'
      + '<div class="flex gap-2 mt-1"><span class="w-8"></span><div class="grid grid-cols-4 gap-[3px] flex-1">' + hourLabels + '</div></div>'
      + '</section>';
  }

  function projectsHtml() {
    var rows = state.byProject.filter(function (p) { return adapterSel === "all" || p.adapter === adapterSel; });
    if (rows.length === 0) return "";
    var max = 1;
    rows.forEach(function (p) { var t = p.avoidedTokens + p.returnedTokens; if (t > max) max = t; });
    var trs = rows.map(function (p) {
      var tot = p.avoidedTokens + p.returnedTokens;
      var avW = tot === 0 ? 0 : Math.round((p.avoidedTokens / tot) * 100);
      return '<tr class="border-b border-[var(--oc-border)] last:border-0">'
        + '<td class="py-2 pr-3 max-w-[280px] truncate" title="' + esc(p.project) + '">' + esc(baseName(p.project))
        + (adapterSel === "all" ? ' <span class="font-mono text-[10px] text-[var(--oc-muted)]">' + esc(p.adapter) + '</span>' : '') + '</td>'
        + '<td class="py-2 px-3 font-mono text-xs text-[var(--oc-muted)] text-right">' + fmtInt(p.sessions) + '</td>'
        + '<td class="py-2 px-3 font-mono text-xs text-[var(--oc-muted)] text-right">' + fmtInt(p.events) + '</td>'
        + '<td class="py-2 px-3 font-mono text-xs text-[var(--oc-success)] text-right">' + fmtTokens(p.avoidedTokens) + '</td>'
        + '<td class="py-2 px-3 font-mono text-xs text-[var(--oc-warning)] text-right">' + fmtTokens(p.returnedTokens) + '</td>'
        + '<td class="py-2 pl-3 w-32"><div class="h-1.5 rounded-sm bg-[var(--oc-element)] flex overflow-hidden">'
        + '<div class="h-1.5 bg-[var(--oc-success)]" style="width:' + avW + '%"></div>'
        + '<div class="h-1.5 bg-[var(--oc-warning)]" style="width:' + (100 - avW) + '%"></div></div></td>'
        + '</tr>';
    }).join("");
    return '<section class="mt-10">'
      + '<h2 class="font-serif text-2xl">Projects</h2>'
      + '<p class="font-mono text-xs text-[var(--oc-muted)] mt-1">tokens by project \\u00b7 all time</p>'
      + '<table class="mt-4 w-full text-sm"><thead><tr class="font-mono text-[10px] text-[var(--oc-muted)] text-left uppercase">'
        + '<th class="py-1 pr-3 font-normal">project</th><th class="py-1 px-3 font-normal text-right">sessions</th>'
        + '<th class="py-1 px-3 font-normal text-right">events</th><th class="py-1 px-3 font-normal text-right text-[var(--oc-success)]">avoided</th>'
        + '<th class="py-1 px-3 font-normal text-right text-[var(--oc-warning)]">returned</th><th class="py-1 pl-3 font-normal"></th>'
        + '</tr></thead><tbody>' + trs + '</tbody></table></section>';
  }

  function sessionsHtml() {
    var cutoff = range === "all" ? 0 : Date.now() - rangeDays() * 86400000;
    var rows = state.bySession.filter(function (s) {
      if (adapterSel !== "all" && s.adapter !== adapterSel) return false;
      if (!cutoff) return true;
      var ms = parseUtc(s.lastAt || s.startedAt);
      return !ms || ms >= cutoff;
    }).slice(0, 30);
    if (rows.length === 0) return "";
    var lis = rows.map(function (s) {
      var last = parseUtc(s.lastAt || s.startedAt);
      var tools = s.tools.map(function (t) {
        return '<span class="inline-block rounded-sm bg-[var(--oc-element)] px-2 py-1 font-mono text-xs text-[var(--oc-secondary)]">' + esc(toolName(t.tool)) + ' \\u00b7 ' + fmtInt(t.calls) + ' \\u00b7 ' + fmtTokens(t.tokensReturned) + ' tk</span>';
      }).join(" ");
      return '<details data-sid="' + esc(s.sessionId) + '" class="rounded-md bg-[var(--oc-panel)] border border-[var(--oc-border)] mb-2">'
        + '<summary class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 cursor-pointer list-none">'
        + '<span class="text-sm truncate max-w-[45%]" title="' + esc(s.project) + '">' + esc(baseName(s.project))
        + ' <span class="font-mono text-[10px] text-[var(--oc-muted)]">' + esc(s.adapter) + '</span></span>'
        + '<span class="font-mono text-xs">'
        + '<span class="text-[var(--oc-success)]">' + fmtTokens(s.avoidedTokens) + '</span>'
        + ' <span class="text-[var(--oc-muted)]">/</span> '
        + '<span class="text-[var(--oc-warning)]">' + fmtTokens(s.returnedTokens) + '</span>'
        + ' <span class="text-[var(--oc-muted)]">tk \\u00b7 ' + fmtInt(s.events) + ' ev' + (s.compacts ? ' \\u00b7 ' + fmtInt(s.compacts) + '\\u27f3' : '') + ' \\u00b7 ' + esc(ago(last)) + '</span></span>'
        + '</summary>'
        + '<div class="px-4 pb-4 pt-1 border-t border-[var(--oc-border)]">'
        + '<p class="font-mono text-xs text-[var(--oc-muted)] break-all">' + esc(s.sessionId) + '</p>'
        + '<p class="mt-2 font-mono text-xs text-[var(--oc-muted)]">started ' + esc(s.startedAt || "\\u2014") + ' \\u00b7 last ' + esc(s.lastAt || "\\u2014") + '</p>'
        + (tools ? '<div class="mt-3 flex flex-wrap gap-2">' + tools + '</div>' : "")
        + '</div></details>';
    }).join("");
    return '<section class="mt-10">'
      + '<h2 class="font-serif text-2xl">Recent sessions</h2>'
      + '<p class="font-mono text-xs text-[var(--oc-muted)] mt-1">avoided / returned tokens \\u00b7 click to expand</p>'
      + '<div class="mt-4">' + lis + '</div></section>';
  }

  function adaptersHtml() {
    var rows = state.lifetime.perAdapter.map(function (a) {
      var rb = (state.realBytes.perAdapter || []).filter(function (r) { return r.name === a.name; })[0] || {};
      return '<li class="py-3 border-b border-[var(--oc-border)] last:border-0 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">'
        + '<span class="text-sm">' + esc(titleCase(a.name)) + '</span>'
        + '<span class="font-mono text-xs text-[var(--oc-muted)]">'
        + fmtInt(a.eventCount) + ' events \\u00b7 ' + fmtInt(a.uuidConvs) + ' conversations \\u00b7 '
        + fmtBytes(a.dataBytes + a.rescueBytes + (rb.contentBytes || 0))
        + (a.lastMs ? ' \\u00b7 last ' + esc(fmtDate(a.lastMs)) : '')
        + '</span></li>';
    }).join("");
    return '<section class="mt-10">'
      + '<h2 class="font-serif text-2xl">Adapters on this machine</h2>'
      + '<ul class="mt-4">' + rows + '</ul></section>';
  }

  function emptyHtml() {
    return '<section class="rounded-md bg-[var(--oc-panel)] px-6 py-10 md:px-10">'
      + '<h2 class="font-serif text-2xl">No session events yet</h2>'
      + '<p class="mt-3 text-sm text-[var(--oc-muted)] max-w-prose">The dashboard reads what the open-context-mode hooks record, and no adapter has written an event so far. Run a conversation in a supported tool, or check that the hooks are installed:</p>'
      + '<p class="mt-3 font-mono text-xs">open-context-mode doctor</p>'
      + '<p class="mt-3 text-sm text-[var(--oc-muted)]">This page updates itself once events start arriving.</p></section>';
  }

  function errorHtml(msg) {
    return '<section class="rounded-md border border-[var(--oc-error)]/50 bg-[var(--oc-panel)] px-6 py-8">'
      + '<h2 class="font-serif text-2xl">Connection lost</h2>'
      + '<p class="mt-3 text-sm text-[var(--oc-muted)]">' + esc(msg) + '</p>'
      + '<p class="mt-3 text-sm text-[var(--oc-muted)]">The local server may have stopped. Restart it with <span class="font-mono text-xs text-[var(--oc-text)]">open-context-mode dashboard</span> and reload.</p></section>';
  }

  // ── Controls ──
  function controlsHtml() {
    var rangePills = RANGES.map(function (r) {
      return '<button data-range="' + r[0] + '" class="' + pill(r[1], range === r[0]) + '">' + r[1] + '</button>';
    }).join("");
    var adapters = state.lifetime.perAdapter.map(function (a) { return a.name; }).sort();
    var adapterPills = ['<button data-adapter="all" class="' + pill("all", adapterSel === "all") + '">all</button>']
      .concat(adapters.map(function (name) {
        return '<button data-adapter="' + esc(name) + '" class="' + pill(titleCase(name), adapterSel === name) + '">' + esc(titleCase(name)) + '</button>';
      })).join("");
    return '<div class="flex items-center gap-2"><span class="font-mono text-xs text-[var(--oc-muted)]">range</span>' + rangePills + '</div>'
      + (adapters.length > 1 ? '<div class="flex items-center gap-2 flex-wrap"><span class="font-mono text-xs text-[var(--oc-muted)]">adapter</span>' + adapterPills + '</div>' : "");
  }

  controls.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.range && b.dataset.range !== range) { range = b.dataset.range; render(); }
    if (b.dataset.adapter && b.dataset.adapter !== adapterSel) { adapterSel = b.dataset.adapter; render(); }
  });

  // ── Render ──
  function render() {
    if (!state) return;
    controls.innerHTML = controlsHtml();
    if (state.lifetime.totalEvents === 0) { main.innerHTML = emptyHtml(); return; }
    var t = tokens();
    main.innerHTML = heroHtml(t) + receiptHtml(t) + kpisHtml() + timelineHtml(t)
      + '<div class="mt-10 md:grid md:grid-cols-2 md:gap-10">' + toolsHtml() + categoriesHtml() + '</div>'
      + heatHtml() + projectsHtml() + sessionsHtml() + adaptersHtml();
    main.querySelectorAll("details[data-sid]").forEach(function (d) {
      if (openSessions[d.dataset.sid]) d.open = true;
      d.addEventListener("toggle", function () { openSessions[d.dataset.sid] = d.open; });
    });
  }

  function accept(snap) { state = snap; lastUpdate = Date.now(); render(); }

  function refreshStamp() {
    if (!lastUpdate) return;
    var secs = Math.max(0, Math.round((Date.now() - lastUpdate) / 1000));
    setStatus("live", secs < 5 ? "live" : "live \\u00b7 updated " + (secs < 60 ? secs + "s" : Math.round(secs / 60) + "m") + " ago");
  }

  fetch("/api/stats").then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(accept).catch(function (e) {
    main.innerHTML = errorHtml("Could not read /api/stats: " + e.message);
  });

  var es = new EventSource("/events");
  es.onmessage = function (e) { accept(JSON.parse(e.data)); refreshStamp(); };
  es.onopen = refreshStamp;
  es.onerror = function () { setStatus("lost", "reconnecting"); };

  setInterval(refreshStamp, 1000);
})();
</script>
</body>
</html>`;
}
