#!/usr/bin/env python3
"""
UAP File Pipeline — multi-source government scraper.

Pulls UAP/UFO records from every reachable official source into a single
normalized files.json that the app consumes.

KEY REALITY (discovered by probing, 2026):
  Most .gov/.mil sites (war.gov, aaro.mil, vault.fbi.gov, dvidshub) return 403
  to automated requests — they block scrapers at the CDN edge (Akamai/Cloudflare).
  NARA exposes a catalog API but requires a free API key.

  So this pipeline uses THREE ingestion strategies per source:
    1. API      — where a real JSON API exists (NARA, with key)
    2. SCRAPE   — where HTML is reachable (some pages, structured mirrors)
    3. SEED     — curated records for hard-gated sources, kept in seeds/*.json
                  and updated when a new tranche drops (the war.gov catalog is
                  small and human-readable; transcribing the index is fast).

  This is the correct design: it degrades gracefully. A blocked source falls
  back to its seed file instead of silently producing nothing.

USAGE:
    python3 scrape.py                 # run all enabled sources
    python3 scrape.py --only pursue   # run one source
    python3 scrape.py --list          # show source status
    NARA_API_KEY=xxx python3 scrape.py --only nara

OUTPUT:
    data/files.json   — the merged, deduplicated, schema-valid dataset
    data/_report.json — per-source counts + any errors, for debugging
"""

import os
import sys
import json
import time
import hashlib
import argparse
import datetime
from pathlib import Path

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("Install deps:  pip install requests beautifulsoup4 lxml --break-system-packages")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SEEDS = Path(__file__).resolve().parent / "seeds"
DATA.mkdir(exist_ok=True)
SEEDS.mkdir(exist_ok=True)

UA = "Mozilla/5.0 (compatible; UAP-Archive-Research/1.0)"
NOW = datetime.datetime.utcnow().isoformat() + "Z"

# Theater centroids for coordinate assignment when only a region is named.
THEATERS = {
    "Persian Gulf": (26.5, 51.5), "Strait of Hormuz": (26.57, 56.25),
    "Gulf of Aden": (12.5, 48.0), "Iraq": (33.3, 44.4), "Syria": (35.0, 38.5),
    "Iran": (32.0, 53.0), "Greece": (39.0, 22.0), "Mediterranean": (35.0, 18.0),
    "UAE": (24.45, 54.38), "Japan": (36.2, 138.25), "East China Sea": (29.0, 125.0),
    "Indo-Pacific": (15.0, 135.0), "Lunar": (0.0, 0.0), "Western US": (39.5, -111.55),
    "Lake Huron": (44.8, -82.5),
}


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────
def fetch(url, as_json=False, timeout=15, params=None, headers=None):
    """GET with standard headers. Returns (ok, payload_or_error)."""
    h = {"User-Agent": UA, "Accept": "application/json" if as_json else "*/*"}
    if headers:
        h.update(headers)
    try:
        r = requests.get(url, timeout=timeout, params=params, headers=h, allow_redirects=True)
        if r.status_code == 403:
            return False, f"403 blocked (CDN edge): {url}"
        if r.status_code != 200:
            return False, f"{r.status_code}: {url}"
        if as_json:
            ct = r.headers.get("content-type", "")
            if "json" not in ct:
                return False, f"not JSON (got {ct[:30]}): {url}"
            return True, r.json()
        return True, r.text
    except Exception as e:
        return False, f"{type(e).__name__}: {str(e)[:80]}"


def make_id(*parts):
    raw = "|".join(str(p) for p in parts if p)
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def load_seed(name):
    """Load a curated seed file for gated sources."""
    p = SEEDS / f"{name}.json"
    if p.exists():
        return json.loads(p.read_text())
    return []


def stamp(records):
    for r in records:
        r.setdefault("scraped_at", NOW)
    return records


# ─────────────────────────────────────────────────────────────────────────────
# SOURCE ADAPTERS
# Each returns a list of schema-shaped dicts (or []).
# Strategy is noted: API / SCRAPE / SEED
# ─────────────────────────────────────────────────────────────────────────────

def source_pursue():
    """
    PURSUE / war.gov — the Trump 2026 release.
    STRATEGY: SEED. war.gov and DVIDS both 403 automated requests.
    The official catalog is a small, human-readable index of numbered files
    (MR-xx mission reports, PR-xx imagery). We maintain seeds/pursue.json
    transcribed from the index; updating per tranche is ~15 min of work.

    A SCRAPE fallback is attempted first in case edge rules change.
    """
    records = []
    # Optimistic scrape attempt (will normally 403)
    ok, payload = fetch("https://www.war.gov/UFO/")
    if ok:
        # If war.gov ever becomes scrapeable, parse the file table here.
        soup = BeautifulSoup(payload, "lxml")
        # (table structure TBD — would parse <tr> designator/date/location rows)
        # For now we still fall through to seed to avoid partial data.
        pass
    # Authoritative path: curated seed
    records = load_seed("pursue")
    return stamp(records)


def source_nara():
    """
    National Archives UAP Collection.
    STRATEGY: API (requires free key from https://catalog.archives.gov/api-key).
    Without a key, falls back to seed.
    """
    key = os.environ.get("NARA_API_KEY")
    if not key:
        return stamp(load_seed("nara"))
    records = []
    ok, data = fetch(
        "https://catalog.archives.gov/api/v2/records/search",
        as_json=True,
        params={"q": "unidentified anomalous phenomena", "limit": 50},
        headers={"x-api-key": key},
    )
    if not ok:
        return stamp(load_seed("nara"))
    for hit in data.get("body", {}).get("hits", {}).get("hits", []):
        meta = hit.get("_source", {}).get("record", {})
        title = meta.get("title", "Untitled NARA record")
        records.append({
            "id": make_id("nara", meta.get("naId")),
            "designator": str(meta.get("naId", "")),
            "date": (meta.get("productionDates", [{}])[0].get("logicalDate", "1947-01-01"))[:10],
            "date_precision": "day",
            "time": None,
            "location": "United States",
            "lat": 38.9, "lng": -77.0, "geo_precision": "approximate",
            "shape": "unknown",
            "duration": None,
            "description": title[:600],
            "witnesses": 1,
            "source": {"agency": "NARA", "collection": "NARA-UAP",
                       "url": f"https://catalog.archives.gov/id/{meta.get('naId')}"},
            "theater": "US-Domestic", "evidence": ["document"],
            "status": "historical", "tags": ["NARA", "archive"],
        })
    return stamp(records)


def source_fbi():
    """
    FBI Vault UFO files.
    STRATEGY: SEED. vault.fbi.gov 403s automation. The Vault's UFO section
    is a finite set of named PDF collections (Roswell memo, Hottel memo, etc).
    """
    return stamp(load_seed("fbi"))


def source_cia():
    """
    CIA Reading Room 'UFOs: Fact or Fiction'.
    STRATEGY: SEED. Redirect-loops on automation; finite curated collection.
    """
    return stamp(load_seed("cia"))


def source_nsa():
    """
    NSA UAP/Umbra records (2026 FOIA release).
    STRATEGY: SEED.
    """
    return stamp(load_seed("nsa"))


def source_nasa():
    """
    NASA Apollo/UAP imagery referenced in PURSUE + NASA UAP study.
    STRATEGY: SEED (Apollo lunar UAP files are a known finite set).
    """
    return stamp(load_seed("nasa"))


def source_nuforc():
    """
    NUFORC civilian sighting database.
    STRATEGY: SCRAPE (NUFORC publishes HTML index tables: a curated "highlights"
    table plus one table per month). This is the only genuinely large, growing
    source (100k+ reports), so we pull highlights + the most recent months and
    geocode each City/State against seeds/geo_cities.json. Anything we can't
    geocode is skipped (no junk centroids). Falls back to the baked seed if the
    site is unreachable.
    """
    # Offline/CI-fast path: skip the live pull and build from the baked seed.
    if os.environ.get("NUFORC_OFFLINE"):
        return stamp(load_seed("nuforc"))

    geo = {}
    p = SEEDS / "geo_cities.json"
    if p.exists():
        geo = json.loads(p.read_text())

    def geocode(city, state):
        name = city.split("(")[0].strip().lower()
        for key in (f"US|{name}",):
            if key in geo:
                lat, lng = geo[key]
                # deterministic sub-city jitter so same-city reports don't stack
                h = int(hashlib.sha1((city + state).encode()).hexdigest(), 16)
                return round(lat + ((h % 1000) / 1000 - 0.5) * 0.18, 4), \
                       round(lng + (((h >> 10) % 1000) / 1000 - 0.5) * 0.18, 4)
        return None

    SHAPES = {"disk": "disc", "disc": "disc", "saucer": "disc", "circle": "orb",
              "sphere": "orb", "orb": "orb", "light": "orb", "flash": "orb",
              "fireball": "orb", "star": "orb", "oval": "orb", "egg": "orb",
              "triangle": "triangle", "delta": "triangle", "chevron": "chevron",
              "boomerang": "boomerang", "diamond": "diamond", "cigar": "cigar",
              "cylinder": "cigar"}

    def norm_shape(s):
        s = (s or "").strip().lower()
        return SHAPES.get(s, "unknown" if not s else "other")

    def parse_table(html, collection):
        out = []
        soup = BeautifulSoup(html, "lxml")
        for row in soup.select("table tr")[1:]:
            cells = [c.get_text(strip=True) for c in row.find_all("td")]
            if len(cells) < 8:
                continue
            _, occ, city, state, country, shape_s, summary, _rep = cells[:8]
            try:
                d = datetime.datetime.strptime(occ[:10], "%m/%d/%Y").strftime("%Y-%m-%d")
            except Exception:
                continue
            if (country or "USA") not in ("USA", "United States", ""):
                continue  # geocoder is US-only; international cases live in the seed
            g = geocode(city, state)
            if not g:
                continue
            tm = occ[11:16] if len(occ) >= 16 and ":" in occ[11:16] else None
            shp = norm_shape(shape_s)
            out.append({
                # id scheme matches the baked seed so live + seed union cleanly
                "id": "nuforc-" + make_id(d, city, state, "US"),
                "designator": None, "date": d, "date_precision": "day", "time": tm,
                "location": f"{city}, {state}".strip(", "),
                "lat": g[0], "lng": g[1], "geo_precision": "city",
                "shape": shp, "duration": None,
                "description": (summary[:560] or f"NUFORC report from {city}, {state}."),
                "witnesses": 1,
                "source": {"agency": "NUFORC", "collection": collection, "url": "https://nuforc.org"},
                "theater": "US-Domestic", "evidence": ["testimony"],
                "status": "unresolved",
                "tags": ["NUFORC", "civilian"] + ([shp] if shp not in ("unknown", "other") else []),
            })
        return out

    records = {}
    ok, html = fetch("https://nuforc.org/subndx/?id=highlights")
    if ok:
        for r in parse_table(html, "NUFORC-Highlights"):
            records.setdefault(r["id"], r)
        # most recent months for volume
        y, mo = datetime.datetime.utcnow().year, datetime.datetime.utcnow().month
        for _ in range(14):
            ok2, h2 = fetch(f"https://nuforc.org/subndx/?id=e{y}{mo:02d}")
            if ok2:
                for r in parse_table(h2, "NUFORC"):
                    records.setdefault(r["id"], r)
            mo -= 1
            if mo == 0:
                y -= 1; mo = 12

    # Union with the baked seed. NUFORC rate-limits bulk pulls (you get the most
    # recent months, then the CDN throttles), so a single run can't fetch the
    # whole archive. Merging with the committed seed means the large geocoded
    # corpus persists and live runs only ever *add* freshly reported months.
    for r in load_seed("nuforc"):
        records.setdefault(r["id"], r)
    recs = list(records.values())
    if not recs:
        return []
    recs.sort(key=lambda r: r["date"])
    return stamp(recs)



def source_historical():
    """
    The curated historical canon (1942-2024) — the 60 vetted cases from the
    original app. STRATEGY: SEED (these are stable, well-documented events).
    """
    return stamp(load_seed("historical"))


# Registry: name -> (adapter, strategy, enabled)
SOURCES = {
    "historical": (source_historical, "SEED",   True),
    "pursue":     (source_pursue,     "SEED",   True),
    "nara":       (source_nara,       "API",    True),
    "fbi":        (source_fbi,        "SEED",   True),
    "cia":        (source_cia,        "SEED",   True),
    "nsa":        (source_nsa,        "SEED",   True),
    "nasa":       (source_nasa,       "SEED",   True),
    "nuforc":     (source_nuforc,     "SCRAPE", True),
}


# ─────────────────────────────────────────────────────────────────────────────
# Validation + merge
# ─────────────────────────────────────────────────────────────────────────────
VALID_SHAPES = {"disc","triangle","orb","cigar","chevron","boomerang","diamond","other","unknown"}

def validate(rec):
    """Light validation. Returns list of problems (empty = valid)."""
    problems = []
    for f in ("id", "date", "location", "lat", "lng", "shape", "description", "source"):
        if f not in rec:
            problems.append(f"missing {f}")
    if "lat" in rec and not (-90 <= rec["lat"] <= 90):
        problems.append("bad lat")
    if "lng" in rec and not (-180 <= rec["lng"] <= 180):
        problems.append("bad lng")
    if rec.get("shape") not in VALID_SHAPES:
        problems.append(f"bad shape {rec.get('shape')}")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="run a single source")
    ap.add_argument("--list", action="store_true", help="list sources and exit")
    args = ap.parse_args()

    if args.list:
        print(f"{'SOURCE':<14}{'STRATEGY':<10}{'ENABLED'}")
        for name, (_, strat, en) in SOURCES.items():
            print(f"{name:<14}{strat:<10}{en}")
        return

    targets = [args.only] if args.only else [n for n, (_, _, en) in SOURCES.items() if en]
    all_records, report = [], {}

    for name in targets:
        if name not in SOURCES:
            print(f"  ! unknown source: {name}")
            continue
        adapter, strat, _ = SOURCES[name]
        t0 = time.time()
        try:
            recs = adapter()
            valid = [r for r in recs if not validate(r)]
            invalid = len(recs) - len(valid)
            all_records.extend(valid)
            report[name] = {"strategy": strat, "fetched": len(recs),
                            "valid": len(valid), "invalid": invalid,
                            "secs": round(time.time() - t0, 2)}
            print(f"  ✓ {name:<12} {len(valid):>4} records ({strat})"
                  + (f"  [{invalid} invalid skipped]" if invalid else ""))
        except Exception as e:
            report[name] = {"strategy": strat, "error": str(e)[:120]}
            print(f"  ✗ {name:<12} ERROR: {str(e)[:60]}")

    # Dedupe by id (later sources can't overwrite earlier without same id)
    seen, merged = set(), []
    for r in all_records:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        merged.append(r)

    merged.sort(key=lambda r: r["date"])
    out = {"generated_at": NOW, "count": len(merged),
           "sources": list(report.keys()), "records": merged}
    (DATA / "files.json").write_text(json.dumps(out, indent=2))
    (DATA / "_report.json").write_text(json.dumps(report, indent=2))

    print(f"\n  → {len(merged)} unique records written to data/files.json")
    dupes = len(all_records) - len(merged)
    if dupes:
        print(f"  → {dupes} duplicates merged")
    print(f"  → per-source report in data/_report.json")


if __name__ == "__main__":
    main()
