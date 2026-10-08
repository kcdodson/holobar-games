# HoloBar games index

An **unofficial**, self-updating index of popular Steam games, served as static JSON on GitHub Pages:

**https://kcdodson.github.io/holobar-games/v1/**

It's used by the HoloBar stream bar (a StreamElements widget by HolosuiteArcade) to:

- show a game's **name and cover** from any Steam App ID or store link, and
- find the **App ID and cover** from a typed name ("peak", "hades 2", "gta 5"), beyond HoloBar's built-in list.

Rebuilt every Monday (09:17 UTC) by a GitHub Action, which commits only when the data changed. Anyone may read it; please cache what you fetch.

## Files

| URL (under `/v1/`) | Contents |
|---|---|
| `meta.json` | `v` (version, changes only when the data changes), `updated`, `count`, `coverBase`, shard lists, notes |
| `ids/<h>.json` | `h` = App ID % 16 in hex (`0`–`f`). `{ "730": "Counter-Strike 2", "3527290": ["PEAK", "<sha1>/library_600x900.jpg"] }` |
| `names/<c>.json` | `c` = first character of the canonical name (`a`–`z`, digits → `0`, other → `_`). `[[appid, "Name", "cover?"], ...]`, **most popular first** |
| `aliases.json` | curated short forms → `[appid, "Name", "cover?"]`, e.g. `cs2`, `bg3`, `gta 5`, `poe2`, `ffxiv`, `hades 2`, `repo` |

**Covers:** when an entry has a cover path, the image is `coverBase + appid + "/" + cover`
(`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/…`). Newer games often use hashed asset paths. Without one,
the classic `https://cdn.cloudflare.steamstatic.com/steam/apps/<appid>/library_600x900.jpg` (then `header.jpg`) works.

**Normalising names** (matches HoloBar): lowercase; drop ®/™/©; `&` → `and`; drop apostrophes; anything not `a-z0-9` → space.
The canonical form also drops a leading "the" and turns roman numerals II–XVI (after the first word) into digits.
Suggested matching order: exact name, then canonical name, then alias, then whole-word prefix (with a sensible length ratio), most popular first.

GitHub Pages sends `Access-Control-Allow-Origin: *` and gzip, so browsers can fetch these files directly. Each shard is small (a few to ~100 KB).

## Where the data comes from

- **[SteamSpy API](https://steamspy.com/api.php)** (`request=all`, pages sorted by owners) for popularity. Its stated limit for `all` is 1 request per 60 s; the build waits 61 s between pages. Data by SteamSpy.
- **Steam Web API** (public, no key): `IStoreBrowseService/GetItems` for the current store name, the item type (only games are kept; demos, DLC, software/tools and soundtracks are dropped) and cover asset paths; `ISteamChartsService/GetMostPlayedGames` so currently hot games are always included. About 100 batched requests per run, spaced out.
- **Steam store search lists** (`store.steampowered.com/search/results/?json=1`, filters `topsellers` (1,000) and `popularnew` (500)): recent hits SteamSpy hasn't ranked yet. 15 requests per run, 1.5 s apart.
- `data/aliases.json`: hand-curated short names.

(Steam's old `ISteamApps/GetAppList/v2` no longer answers, and the store `appdetails` endpoint is limited to roughly 200 requests per 5 minutes. `GetItems` returns the same names and asset paths for 250 apps per request.)

Game names, artwork and trademarks belong to their owners. This project is not affiliated with Valve, Steam or SteamSpy, and it stores no images, only paths to Steam's own CDN.

## How the build works

`node build/build.mjs` (Node 20+, no dependencies):

1. Reads SteamSpy pages (`SPY_PAGES`, default 25 ≈ 25,000 apps), plus the most-played chart, the store's top sellers / popular new releases, and the alias targets (these are always kept).
2. Looks up all of them with `GetItems`, keeps type-0 games (minus obvious test servers, benchmarks and soundtracks), ranks them by owners, then reviews, then players, and keeps the top `TARGET` (20,000).
3. Writes the shards. If a source fails, games from the previous build keep their last good name and cover; the build refuses to write if the result is tiny or shrank by more than 30 %.

Local build: `SPY_PAGES=25 node build/build.mjs` (takes about 26 minutes because of SteamSpy's limit). `SPY_DIR=<folder with page-N.json>` reuses downloaded pages.

The Action (`.github/workflows/update.yml`) runs weekly and on demand (**Actions → Update game list → Run workflow**). It uses only the default `GITHUB_TOKEN`.
