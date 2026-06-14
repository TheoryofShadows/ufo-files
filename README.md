# SIGINT — UAP Files Pipeline + App

A data pipeline **and** a shippable app for the declassified UAP/UFO files. The
key idea: **data lives in a versioned JSON, not hardcoded in the app.** A scraper
pulls from every reachable government source into `data/files.json`, and the app
reads that file. This is what lets it scale to hundreds of files and stay current
as new tranches drop.

```
 Official sources ──▶ scrapers/scrape.py ──▶ data/files.json ──┬──▶ app/SIGINT.jsx (React component)
 (war.gov, NARA,                                                └──▶ Vite app (index.html + src/) ──▶ ship
  FBI, CIA, NSA, NASA)
```

The point of the app is to **bridge new connections between previously
unconnected locations and events** — links no analyst filed together because they
sit in different agencies, decades, or theaters. Nothing is hand-authored; the
engine recomputes every link over whatever is in the dataset.

## What's in the box

- **A pan/pinch-zoom tactical world map** (`app/SIGINT.jsx` + `app/world.js`) with
  a real coastline silhouette, agency-colored contacts, and **ballistic arcs** —
  animated great-circle tracers streaking between linked events. Built for the
  phone: one-finger pan, two-finger zoom, tap a contact to lock it and fly to it.
- **A connection engine** that scores every pair of files on geographic proximity
  (haversine), temporal proximity, shape taxonomy, shared operational theater,
  same agency, and tag overlap.
- **Bridges** — a first-class view of the *non-obvious* links: events thousands of
  km apart, decades apart, or sequestered in different agencies, yet sharing a
  craft taxonomy, theater, or signature. These are the headline of the app.
- **The full ingestion pipeline** (`scrapers/`) with curated seeds and a weekly
  GitHub Action that refreshes the data and commits it back.

## Why a pipeline instead of a bigger app file

1. **Size** — the dataset alone is 80KB+; embedding-and-forgetting goes stale.
2. **Currency** — PURSUE releases roll out in tranches; hand-typing never keeps up.
3. **Truth** — data should be queryable and versioned, not tangled in UI code.

The app imports `data/files.json` at build time as the offline snapshot, so a
single source of truth feeds both the prototype and the shipped build.

## The reality the scraper is built around

Most `.gov`/`.mil` sites **block automated requests (HTTP 403)** at the CDN edge —
war.gov, aaro.mil, vault.fbi.gov, and dvidshub all do. NARA has a real API but
needs a free key. So the scraper uses three strategies per source and degrades
gracefully:

| Strategy | Used for | How it works |
|----------|----------|--------------|
| **API**    | NARA | Real JSON API (set `NARA_API_KEY`) |
| **SCRAPE** | NUFORC | Parse public HTML index, fall back to seed |
| **SEED**   | PURSUE, FBI, CIA, NSA, NASA | Curated records in `scrapers/seeds/*.json` |

A blocked source falls back to its seed file instead of silently producing
nothing. The PURSUE catalog is small and human-readable, so when a new tranche
drops you transcribe the index into `seeds/pursue.json` (~15 min) and re-run.

## Layout

```
uap-files/
├── index.html               # Vite entry
├── package.json             # app scripts + deps
├── vite.config.js
├── src/
│   └── main.jsx             # mounts the SIGINT component
├── app/
│   ├── SIGINT.jsx           # the app — map, search, connections, bridges
│   └── world.js             # compact world coastline silhouette (map backdrop)
├── schema.json              # the record contract every source writes to
├── scrapers/
│   ├── scrape.py            # main runner — source adapters + merge + validate
│   └── seeds/               # curated data for gated sources
│       ├── pursue.json      # war.gov files w/ official designators (MR-xx, PR-xx)
│       ├── historical.json  # the vetted canon (1942–2024)
│       └── fbi.json  cia.json  nsa.json  nasa.json  nara.json  nuforc.json
├── data/
│   ├── files.json           # ← THE OUTPUT. merged, deduped, schema-valid.
│   └── _report.json         # per-source counts + errors (debugging)
└── .github/workflows/
    └── update.yml           # weekly auto-refresh + commit
```

## Run the app

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static bundle in dist/
npm run preview    # serve the production build
```

To go **live** instead of using the bundled snapshot, set `DATA_URL` at the top of
`app/SIGINT.jsx` to your hosted `files.json`; the app fetches it on load and falls
back to the snapshot on failure.

## Run the pipeline

```bash
pip install -r requirements.txt --break-system-packages
npm run data                       # = cd scrapers && python3 scrape.py
cd scrapers
python3 scrape.py --list           # show sources + strategies
python3 scrape.py --only pursue    # run one source
NARA_API_KEY=xxx python3 scrape.py --only nara   # NARA live (key: catalog.archives.gov/api-key)
```

> Regenerating `app/world.js` is a one-off: it is RDP-simplified from the public-
> domain Natural Earth `land-110m` set and rarely needs to change.

## When a new PURSUE tranche drops

1. Open the war.gov index, add the new numbered files to `seeds/pursue.json`
   (copy an existing record, change the designator/date/location/description).
2. `npm run data` — rebuilds `data/files.json`.
3. Commit. If you've set up the Action, pushing is all it takes.

## Auto-update (GitHub Action)

`.github/workflows/update.yml` runs the scraper every Monday and on any push to
`scrapers/`, committing the refreshed `files.json` back. To enable:

1. Push this repo to GitHub.
2. (Optional) Add `NARA_API_KEY` under Settings → Secrets → Actions.
3. The Action self-commits — no other infra needed.

## The connection engine, in detail

Every pair of files is scored, and the strongest links surface. Each link carries
a human-readable rationale ("Both triangle. Same theater: Persian Gulf. 8.4Mm
apart."). A link is promoted to a **bridge** when a conceptual match (shape,
theater, or shared signature) leaps across one of these gaps:

- **> 1,500 km** apart, or
- **> 1 year** apart, or
- **different agencies**, or
- **different theaters**.

Bridges get a lower strength bar so the genuinely surprising ones aren't buried,
they're ranked toward the top, and they animate distinctly on the map. That's the
"connections nobody filed together" the app is built to surface.

## Ship it

The app is a static SPA. `npm run build`, then deploy `dist/` to Vercel, Netlify,
or GitHub Pages (for a project page, build with `BASE=/uap-files/ npm run build`).
Host `data/files.json` anywhere and point `DATA_URL` at it; the Action keeps the
JSON fresh and the deployed app picks it up.
