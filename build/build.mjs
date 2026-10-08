#!/usr/bin/env node
// HoloBar games index builder. Node 20+, no dependencies.
//
// 1. Candidates: SteamSpy "all" pages (sorted by owners; SteamSpy allows 1 request / 60 s for request=all)
//    + Steam's most-played chart (ISteamChartsService/GetMostPlayedGames, no key)
//    + data/aliases.json targets (so curated short forms always resolve).
// 2. Details: Steam IStoreBrowseService/GetItems (no key), 250 apps per request: current store name,
//    item type (0 = game; demos, software, DLC, soundtracks have other types) and asset paths, so newer games
//    whose cover isn't at the predictable library_600x900.jpg get an explicit cover path.
// 3. Output (static JSON for GitHub Pages): v1/meta.json, v1/ids/<0-f>.json, v1/names/<char>.json, v1/aliases.json
//
// The previous output is the cache: if a source fails, known games keep their last good data.
// Env: SPY_PAGES (default 25), TARGET (default 20000), SPY_DIR (read SteamSpy pages from disk, for local builds),
//      SPY_DELAY_MS (default 61000), DRY=1 (don't write).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'v1');
const SPY_PAGES = +process.env.SPY_PAGES || 25;
const TARGET = +process.env.TARGET || 20000;
const SPY_DELAY = +process.env.SPY_DELAY_MS || 61000;
const UA = 'holobar-games-index/1.0 (+https://github.com/kcdodson/holobar-games)';
const COVER_BASE = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Same normalisation as the HoloBar widget (normName) + a "canonical" form used for matching.
export function normName(s) {
  return String(s || '').toLowerCase().replace(/[\u00ae\u2122\u00a9]/g, '').replace(/&/g, ' and ').replace(/['\u2019`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const ROMAN = { ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9', x: '10', xi: '11', xii: '12', xiii: '13', xiv: '14', xv: '15', xvi: '16' };
export function canon(s) {
  const w = normName(s).split(' ').filter(Boolean);
  if (w.length > 1 && w[0] === 'the') w.shift();
  return w.map((t, i) => (i > 0 && ROMAN[t]) ? ROMAN[t] : t).join(' ');
}
export function shardChar(c) { const ch = c.charAt(0); return /[a-z]/.test(ch) ? ch : (/[0-9]/.test(ch) ? '0' : '_'); }
const cleanName = (n) => String(n || '').replace(/[\u00ae\u2122\u00a9]/g, '').replace(/\s+/g, ' ').trim();
// type 0 but clearly not a playable game listing
const NOT_GAME = /\b(soundtrack|ost|demo|playtest|test server|public test|dedicated server|benchmark|sdk|mod tools?|editor|wallpaper|artbook|art book|beta test|pts)\b/i;

async function get(url, { tries = 3, timeout = 60000, json = true } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
      clearTimeout(t);
      if (r.status === 429 || r.status >= 500) { last = new Error('HTTP ' + r.status); await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return json ? await r.json() : await r.text();
    } catch (e) { clearTimeout(t); last = e; await sleep(3000 * (i + 1)); }
  }
  throw last;
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };

// ---------------------------------------------------------------- previous output = cache
function loadPrevious() {
  const meta = readJson(path.join(OUT, 'meta.json'), null);
  const prev = new Map();     // appid -> {name, cover, rank}
  if (!meta) return { meta, prev };
  for (let h = 0; h < 16; h++) {
    const shard = readJson(path.join(OUT, 'ids', h.toString(16) + '.json'), {});
    for (const [id, v] of Object.entries(shard)) prev.set(+id, { name: Array.isArray(v) ? v[0] : v, cover: Array.isArray(v) ? v[1] || '' : '' });
  }
  const order = readJson(path.join(ROOT, 'data', 'rank.json'), []);
  order.forEach((id, i) => { const p = prev.get(id); if (p) p.rank = i; });
  return { meta, prev };
}

// ---------------------------------------------------------------- SteamSpy
const ownersLow = (s) => +(String(s || '').split('..')[0].replace(/[^0-9]/g, '')) || 0;
async function steamSpy() {
  const apps = new Map(); let okPages = 0;
  for (let p = 0; p < SPY_PAGES; p++) {
    let page = null;
    const local = process.env.SPY_DIR && path.join(process.env.SPY_DIR, 'page-' + p + '.json');
    if (local && fs.existsSync(local)) page = readJson(local, null);
    else {
      if (p > 0 || okPages) await sleep(SPY_DELAY);
      try { page = await get('https://steamspy.com/api.php?request=all&page=' + p, { tries: 2, timeout: 90000 }); }
      catch (e) { log('SteamSpy page', p, 'failed:', e.message); }
    }
    if (!page || typeof page !== 'object') continue;
    okPages++;
    for (const a of Object.values(page)) {
      if (!a || !a.appid) continue;
      apps.set(+a.appid, { page: p, owners: ownersLow(a.owners), reviews: (+a.positive || 0) + (+a.negative || 0), ccu: +a.ccu || 0, spyName: a.name || '' });
    }
    log('SteamSpy page', p, 'ok,', apps.size, 'apps so far');
  }
  return { apps, okPages };
}

// ---------------------------------------------------------------- Steam
async function mostPlayed() {
  try {
    const j = await get('https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/');
    return ((j.response && j.response.ranks) || []).map((r) => +r.appid).filter(Boolean);
  } catch (e) { log('most played failed:', e.message); return []; }
}
async function storeItems(ids) {
  const out = new Map(); let failed = 0;
  for (let i = 0; i < ids.length; i += 250) {
    const batch = ids.slice(i, i + 250);
    const input = { ids: batch.map((appid) => ({ appid })), context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true } };
    try {
      const j = await get('https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=' + encodeURIComponent(JSON.stringify(input)));
      for (const it of (j.response && j.response.store_items) || []) out.set(+it.id, it);
    } catch (e) { failed += batch.length; log('GetItems batch', i / 250, 'failed:', e.message); }
    if ((i / 250) % 10 === 9) log('GetItems', Math.min(ids.length, i + 250), '/', ids.length);
    await sleep(700);
  }
  return { items: out, failed };
}
function coverFrom(it) {
  const a = it.assets || {};
  const lib = a.library_capsule || '';
  if (lib === 'library_600x900.jpg') return '';                 // predictable path works: no override needed
  if (lib) return lib;                                          // hashed path (e.g. "<sha1>/library_600x900.jpg") or portrait.png
  return a.header || '';                                        // no portrait art at all: landscape header
}

// ---------------------------------------------------------------- main
async function main() {
  const { meta: prevMeta, prev } = loadPrevious();
  const aliasSrc = readJson(path.join(ROOT, 'data', 'aliases.json'), {});
  const aliasIds = [...new Set(Object.values(aliasSrc).map(Number))];
  log('previous dataset:', prev.size, 'games');

  const [{ apps, okPages }, top] = [await steamSpy(), await mostPlayed()];
  log('SteamSpy:', okPages, '/', SPY_PAGES, 'pages,', apps.size, 'apps; most played:', top.length);
  const spyOk = okPages >= Math.ceil(SPY_PAGES * 0.8);
  if (!spyOk) log('SteamSpy mostly unavailable: keeping the previous ranking');

  // ranking: SteamSpy owners bracket, then reviews, then concurrent players; most-played chart and aliases always in
  let ranked;
  if (spyOk) {
    ranked = [...apps.entries()].sort((a, b) => (b[1].owners - a[1].owners) || (b[1].reviews - a[1].reviews) || (b[1].ccu - a[1].ccu) || (a[0] - b[0])).map((e) => e[0]);
  } else {
    ranked = [...prev.entries()].sort((a, b) => (a[1].rank ?? 1e9) - (b[1].rank ?? 1e9)).map((e) => e[0]);
    for (const id of apps.keys()) if (!prev.has(id)) ranked.push(id);
  }
  const front = [...new Set([...top, ...aliasIds])];
  const seen = new Set(); const candidates = [];
  for (const id of [...front, ...ranked]) if (!seen.has(id)) { seen.add(id); candidates.push(id); }
  const rankOf = new Map(); ranked.forEach((id, i) => rankOf.set(id, i));
  top.forEach((id, i) => { if (!rankOf.has(id) || rankOf.get(id) > i * 10) rankOf.set(id, Math.min(rankOf.get(id) ?? 1e9, i * 10)); });

  const { items, failed } = await storeItems(candidates);
  log('GetItems:', items.size, 'answers,', failed, 'failed');

  const games = [];  // {id, name, cover, rank}
  let skipped = { type: 0, name: 0, gone: 0, kept: 0 };
  for (const id of candidates) {
    const it = items.get(id);
    if (!it) { const p = prev.get(id); if (p) { games.push({ id, name: p.name, cover: p.cover, rank: rankOf.get(id) ?? p.rank ?? 1e9 }); skipped.kept++; } continue; }
    if (it.success !== 1 || !it.name) { skipped.gone++; continue; }
    if (it.type !== 0) { skipped.type++; continue; }
    const name = cleanName(it.name);
    if (NOT_GAME.test(name) && !aliasIds.includes(id)) { skipped.name++; continue; }
    games.push({ id, name, cover: coverFrom(it), rank: rankOf.get(id) ?? 1e9 });
  }
  games.sort((a, b) => a.rank - b.rank || a.id - b.id);
  // top TARGET by popularity, plus anything on the most-played chart or an alias target (always kept)
  const final = games.slice(0, TARGET);
  const frontSet = new Set(front), inFinal = new Set(final.map((g) => g.id));
  for (const g of games.slice(TARGET)) if (frontSet.has(g.id) && !inFinal.has(g.id)) final.push(g);
  log('games:', games.length, '-> keeping', final.length, '; skipped', JSON.stringify(skipped));
  if (final.length < 1000) throw new Error('suspiciously small dataset (' + final.length + '), not writing');
  if (prev.size && final.length < prev.size * 0.7) throw new Error('dataset shrank from ' + prev.size + ' to ' + final.length + ', not writing');

  // ---- shards
  const ids = {}; for (let h = 0; h < 16; h++) ids[h.toString(16)] = {};
  const names = {};
  const byId = new Map();
  for (const g of final) {
    byId.set(g.id, g);
    ids[(g.id % 16).toString(16)][g.id] = g.cover ? [g.name, g.cover] : g.name;
    const c = canon(g.name); if (!c) continue;
    const sc = shardChar(c);
    (names[sc] = names[sc] || []).push(g.cover ? [g.id, g.name, g.cover] : [g.id, g.name]);   // popularity order
  }
  const aliases = {};
  for (const [k, id] of Object.entries(aliasSrc)) {
    const g = byId.get(+id); const key = normName(k);
    if (!g) { log('alias target not in dataset (skipped):', k, '->', id); continue; }
    aliases[key] = g.cover ? [g.id, g.name, g.cover] : [g.id, g.name];
  }
  const files = {};
  for (const [h, v] of Object.entries(ids)) files['ids/' + h + '.json'] = JSON.stringify(v);
  for (const [c, v] of Object.entries(names).sort()) files['names/' + c + '.json'] = JSON.stringify(v);
  files['aliases.json'] = JSON.stringify(aliases);
  const hash = crypto.createHash('sha256'); for (const k of Object.keys(files).sort()) hash.update(k + '\0' + files[k] + '\0');
  const digest = hash.digest('hex').slice(0, 10);

  if (prevMeta && prevMeta.hash === digest) { log('no data change (hash', digest + ')'); return; }
  const meta = {
    format: 1, v: new Date().toISOString().slice(0, 10) + '.' + digest, hash: digest, updated: new Date().toISOString(), count: final.length,
    coverBase: COVER_BASE, coverNote: 'cover = coverBase + appid + "/" + cover; when absent use https://cdn.cloudflare.steamstatic.com/steam/apps/<appid>/library_600x900.jpg',
    ids: { shard: 'appid % 16 as hex', files: Object.keys(ids) }, names: { shard: 'first char of canon(name), digits -> 0', files: Object.keys(names).sort() },
    normalize: 'lowercase; drop (R)(TM)(C); & -> and; drop apostrophes; non [a-z0-9] -> space; canon also drops a leading "the" and turns roman numerals II-XVI (not first word) into digits',
    sources: ['SteamSpy API (steamspy.com) - popularity / owners ranking', 'Steam Web API IStoreBrowseService/GetItems + ISteamChartsService/GetMostPlayedGames - current names, item type, cover asset paths'],
    unofficial: 'Unofficial index of public data. Not affiliated with Valve or SteamSpy.'
  };
  if (process.env.DRY) { log('DRY run: would write', final.length, 'games, v', meta.v); return; }
  fs.rmSync(path.join(OUT, 'names'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'ids'), { recursive: true }); fs.mkdirSync(path.join(OUT, 'names'), { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(OUT, f), body + '\n');
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');
  fs.writeFileSync(path.join(ROOT, 'data', 'rank.json'), JSON.stringify(final.map((g) => g.id)) + '\n');
  const sizes = Object.keys(files).map((f) => [f, Buffer.byteLength(files[f])]).sort((a, b) => b[1] - a[1]);
  log('wrote v' + meta.v + ':', final.length, 'games; total', (sizes.reduce((s, x) => s + x[1], 0) / 1024).toFixed(0) + 'KB; largest', sizes.slice(0, 3).map((x) => x[0] + ' ' + (x[1] / 1024).toFixed(0) + 'KB').join(', '));
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().catch((e) => { console.error('BUILD FAILED:', e.message); process.exit(1); });
