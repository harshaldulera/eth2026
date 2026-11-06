#!/usr/bin/env node
/**
 * qa/screenshots.mjs — the screenshot matrix (plan §7.4) against a running STUB app:
 *   8 routes × 3 viewports (1440×900, 390×844, 1920×1080) × ?skin=crt|neon × ?crt=on|off
 * → qa/out/<route>__<w>x<h>__<skin>__crt-<on|off>.png and qa/out/index.html (contact sheet).
 *
 * FAILS (exit 1) on any console error, page error or hydration warning on any shot. Horizontal
 * overflow (scrollWidth > viewport) is flagged on the sheet; `--strict` makes it fail too.
 *
 * Routes: / · /castle/castle_splinter_gate · /siege/<id> · /replay/<id> · /raider ·
 *         /raider/approvals · /hall · /publish · /docs · /wall (plus /wall?slide=breach|season|pager&paused=1 at 1920×1080,
 *         see --wall-slides). The op id comes from --siege, else the newest paid
 *         breach / op of the day / any ended op in /api/stats and /api/events (run `npm run qa:op` first).
 *
 * Usage: node qa/screenshots.mjs [--base URL] [--siege ID] [--only /,/hall] [--viewports 1440x900,390x844]
 *        [--skins crt,neon] [--crt on,off] [--wait 2500] [--concurrency 4] [--out qa/out] [--strict] [--wall-slides breach,season,pager]
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHED_SHELL = "/home/dhruv1238/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell";

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: process.env.QA_BASE_URL || "http://localhost:4650" },
    siege: { type: "string" },
    only: { type: "string" },
    viewports: { type: "string", default: "1440x900,390x844,1920x1080" },
    skins: { type: "string", default: "crt,neon" },
    crt: { type: "string", default: "on,off" },
    wait: { type: "string", default: "2500" },
    concurrency: { type: "string", default: "4" },
    out: { type: "string", default: path.join(HERE, "out") },
    strict: { type: "boolean", default: false },
    // The wall rotates; /wall alone only ever shows its first slide. These are shot paused, at the
    // wall's own size (1920×1080) in both skins with scanlines on. "" turns them off.
    "wall-slides": { type: "string", default: "breach,season,pager" },
    chrome: { type: "string", default: process.env.QA_CHROME || "" },
  },
});

const BASE = args.base.replace(/\/$/, "");
const OUT = path.resolve(args.out);
const WAIT = Number(args.wait);
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Messages that are not bugs on these pages (network noise from expected auth probes). */
const BENIGN = [/Download the React DevTools/i];
const HYDRATION = /hydrat|did not match|server rendered HTML|Text content does not match/i;

async function getJson(p) {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(`GET ${p} → ${r.status}`);
  return r.json();
}

async function pickSiege() {
  if (args.siege) return args.siege;
  const stats = await getJson("/api/stats").catch(() => null);
  const fromStats = stats?.breaches?.[0]?.siegeId ?? stats?.boards?.opOfDay?.siegeId;
  if (fromStats) return fromStats;
  const ev = await getJson("/api/events?tail=200").catch(() => null);
  const end = ev?.events?.filter((e) => e.type === "end" && e.siegeId).at(-1);
  if (end) return end.siegeId;
  throw new Error("no finished op to shoot: run `npm run qa:op` first, or pass --siege <id>");
}

function launchOpts() {
  const exe = args.chrome || (existsSync(CACHED_SHELL) ? CACHED_SHELL : undefined);
  return exe ? { executablePath: exe } : {};
}

/**
 * goto, then wait until the page stops navigating. A dev server that is still compiling sends
 * "HMR hash mismatch" full reloads for a few seconds; shooting mid-reload destroys the context.
 * Returns how many extra reloads were seen (shown on the sheet).
 */
async function settledGoto(page, url) {
  let navs = 0;
  // full document loads only (history.replaceState also fires framenavigated)
  const onNav = () => navs++;
  page.on("domcontentloaded", onNav);
  try {
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    const start = navs;
    let seen = navs;
    let quietSince = Date.now();
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      await page.waitForTimeout(250);
      if (navs !== seen) {
        seen = navs;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= 1_500) break;
    }
    await page.waitForLoadState("load");
    return navs - start;
  } finally {
    page.off("domcontentloaded", onNav);
  }
}

const slug = (route) => (route === "/" ? "grid" : route.replace(/^\//, "").replace(/[/?=&]+/g, "_").replace(/siege_[0-9a-f]+/, "op"));

async function main() {
  const cfg = await getJson("/api/config").catch((e) => {
    throw new Error(`no app at ${BASE} (${e.message})`);
  });
  if (cfg?.chain?.mode !== "stub") throw new Error(`refusing to run: ${BASE} is in ${cfg?.chain?.mode} mode, not stub`);
  const siege = await pickSiege();

  const routes = ["/", "/castle/castle_splinter_gate", `/siege/${siege}`, `/replay/${siege}`, "/raider", "/raider/approvals", "/hall", "/publish", "/docs", "/wall"].filter(
    (r) => !args.only || list(args.only).some((o) => r === o || (o !== "/" && r.startsWith(o.replace(/<id>$/, "")))),
  );
  const viewports = list(args.viewports).map((v) => {
    const [w, h] = v.split("x").map(Number);
    return { w, h };
  });
  const skins = list(args.skins);
  const crts = list(args.crt);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, ".gitignore"), "*\n");

  // Warm the dev server (first compile of a route can take seconds).
  console.log(`screenshots → ${BASE} · op ${siege} · ${routes.length} routes × ${viewports.length} viewports × ${skins.length} skins × ${crts.length} crt`);
  await Promise.all(routes.map((r) => fetch(BASE + r).then((x) => x.text()).catch(() => "")));

  const jobs = [];
  for (const route of routes) for (const vp of viewports) for (const skin of skins) for (const crt of crts) jobs.push({ route, vp, skin, crt });
  if (routes.includes("/wall"))
    for (const slide of list(args["wall-slides"]))
      for (const skin of skins) jobs.push({ route: `/wall?slide=${slide}&paused=1`, vp: { w: 1920, h: 1080 }, skin, crt: crts.includes("on") ? "on" : crts[0] });

  const browser = await chromium.launch(launchOpts());
  const results = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      results.push(await shoot(browser, job));
      const r = results.at(-1);
      process.stdout.write(r.errors.length ? "✗" : r.overflow ? "!" : ".");
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency)) }, worker));
  await browser.close();
  process.stdout.write("\n");

  results.sort((a, b) => jobs.findIndex((j) => j.file === a.file) - jobs.findIndex((j) => j.file === b.file));
  writeFileSync(path.join(OUT, "index.html"), sheet(results, siege));
  // Untruncated messages (React's hydration diff is long), for the shots that failed.
  const failures = results.filter((r) => r.full.length).map((r) => ({ file: r.file, url: r.url, messages: r.full }));
  writeFileSync(path.join(OUT, "errors.json"), JSON.stringify(failures, null, 2));

  const bad = results.filter((r) => r.errors.length);
  const over = results.filter((r) => r.overflow);
  for (const r of bad) console.log(`✗ ${r.file}\n    ${r.errors.slice(0, 4).join("\n    ")}`);
  for (const r of over) console.log(`! ${r.file}  scrollWidth ${r.scrollWidth} > ${r.vp.w}`);
  console.log(`${results.length} shots · ${bad.length} with errors · ${over.length} overflowing · sheet: ${path.relative(process.cwd(), path.join(OUT, "index.html"))}`);
  if (bad.length || (args.strict && over.length)) process.exit(1);
}

async function shoot(browser, job) {
  const { route, vp, skin, crt } = job;
  const file = `${slug(route)}__${vp.w}x${vp.h}__${skin}__crt-${crt}.png`;
  job.file = file;
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1, hasTouch: vp.w < 640, isMobile: vp.w < 640 });
  const page = await ctx.newPage();
  const errors = [];
  const full = [];
  page.on("console", (m) => {
    const t = m.text();
    if (BENIGN.some((re) => re.test(t))) return;
    if (m.type() === "error" || (m.type() === "warning" && HYDRATION.test(t))) {
      errors.push(`${m.type() === "error" ? "console" : "hydration"}: ${t.slice(0, 300)}`);
      full.push(t);
    }
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on("dialog", (d) => {
    errors.push(`dialog: ${d.type()} "${d.message().slice(0, 80)}"`);
    void d.dismiss();
  });
  const sep = route.includes("?") ? "&" : "?";
  const url = `${BASE}${route}${sep}skin=${skin}&crt=${crt}`;
  let scrollWidth = 0;
  let reloads = 0;
  try {
    reloads = await settledGoto(page, url);
    await page.evaluate(() => document.fonts.ready);
    // Scene routes and the wall load their op / slide data after hydration: give them longer.
    await page.waitForTimeout(/^\/(wall|siege|replay)/.test(route) ? WAIT * 2 : WAIT);
    scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    await page.screenshot({ path: path.join(OUT, file) });
  } catch (e) {
    errors.push(`navigation: ${e.message.split("\n")[0]}`);
  }
  await ctx.close();
  return { ...job, file, url, errors, full, scrollWidth, reloads, overflow: scrollWidth > vp.w };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function sheet(results, siege) {
  const byRoute = new Map();
  for (const r of results) {
    if (!byRoute.has(r.route)) byRoute.set(r.route, []);
    byRoute.get(r.route).push(r);
  }
  const bad = results.filter((r) => r.errors.length).length;
  const sections = [...byRoute]
    .map(
      ([route, rs]) => `<section><h2>${esc(route)}</h2><div class="grid">${rs
        .map(
          (r) => `<figure class="${r.errors.length ? "bad" : r.overflow ? "warn" : ""}"><a href="${esc(r.file)}"><img loading="lazy" src="${esc(r.file)}" alt="${esc(r.file)}"></a>
<figcaption>${r.vp.w}×${r.vp.h} · ${esc(r.skin)} · crt ${esc(r.crt)}${r.overflow ? ` · <b>overflow ${r.scrollWidth}px</b>` : ""}${r.reloads ? ` · dev reloads ${r.reloads}` : ""}${
            r.errors.length ? `<ul>${r.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""
          }</figcaption></figure>`,
        )
        .join("")}</div></section>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Siege screenshot matrix</title>
<style>
:root{color-scheme:dark;--bg:#0b0f0c;--ink:#d8f5da;--dim:#7d9a80;--bad:#ff5a3c;--warn:#ffb347;--line:#1e3a24}
body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font:14px/1.4 ui-monospace,monospace}
h1{font-size:18px;margin:0 0 4px}p{color:var(--dim);margin:0 0 16px}h2{font-size:15px;margin:24px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
figure{margin:0;border:2px solid var(--line);padding:6px;background:#000}figure.bad{border-color:var(--bad)}figure.warn{border-color:var(--warn)}
img{width:100%;height:180px;object-fit:contain;object-position:top;display:block;background:#050605}
figcaption{color:var(--dim);font-size:12px;margin-top:4px}figcaption b{color:var(--warn)}ul{margin:4px 0 0;padding-left:16px;color:var(--bad)}
</style></head><body><h1>Siege screenshot matrix</h1><p>${results.length} shots · ${bad} with errors · op ${esc(siege)} · ${esc(BASE)} · ${new Date().toISOString()}</p>
${sections}</body></html>`;
}

main().catch((e) => {
  console.error(`screenshots: ${e.message}`);
  process.exit(1);
});
