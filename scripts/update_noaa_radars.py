#!/usr/bin/env python3
"""Build catalogs/radar_catalog.json from NOAA/NCEI's current NEXRAD/TDWR list.

Manual lowest-tilt/range values in catalogs/radar_overrides.json win over defaults.
Climavision entries are merged from catalogs/climavision_radars.json.
"""
from __future__ import annotations
import argparse, json, pathlib, urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
NCEI_URL = "https://www.ncei.noaa.gov/access/homr/file/nexrad-stations.txt"
PALETTE = [
    "#D7191C", "#18A558", "#246BCE", "#F28E2B", "#7A3DB8", "#00A7B5",
    "#E6A700", "#A23B72", "#6A994E", "#0EA5E9", "#C0392B", "#5D6D7E",
    "#EC4899", "#00B894", "#8B5CF6", "#D35400"
]
DEFAULTS = {
    "NEXRAD": {"lowest_tilt_deg": 0.5, "range_nm": 124},
    "TDWR": {"lowest_tilt_deg": 0.3, "range_nm": 48},
}
DEFAULT_EXCLUDES = {"KCRI", "KOUN"}


def read_json(path: pathlib.Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def deterministic_color(site_id: str) -> str:
    return PALETTE[sum(ord(c) for c in site_id) % len(PALETTE)]


def parse_line(line: str):
    if len(line) < 120 or line.startswith("NCDCID") or line.startswith("-"):
        return None
    site_id = line[9:13].strip()
    name = line[20:50].strip()
    country = line[51:71].strip()
    state = line[72:74].strip()
    county = line[75:105].strip()
    tail = line[105:].split()
    if len(tail) < 5:
        return None
    try:
        lat, lon = float(tail[0]), float(tail[1])
    except ValueError:
        return None
    network = tail[-1].strip()
    if network not in DEFAULTS or not site_id:
        return None
    return site_id, {
        "name": name.title(),
        "network": network,
        "lat": lat,
        "lon": lon,
        "state": state,
        "county": county.title(),
        **DEFAULTS[network],
        "color": deterministic_color(site_id),
        "source": "NOAA/NCEI HOMR"
    }, country


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=NCEI_URL)
    ap.add_argument("--include-test", action="store_true")
    args = ap.parse_args()

    overrides = read_json(ROOT / "catalogs" / "radar_overrides.json", {})
    climavision = read_json(ROOT / "catalogs" / "climavision_radars.json", {})
    old = read_json(ROOT / "catalogs" / "radar_catalog.json", {"radars": {}}).get("radars", {})

    with urllib.request.urlopen(args.url, timeout=60) as r:
        text = r.read().decode("utf-8", errors="replace")

    radars = {}
    for line in text.splitlines():
        parsed = parse_line(line)
        if not parsed:
            continue
        site_id, item, country = parsed
        if country not in {"UNITED STATES", "GUAM", "PUERTO RICO", "VIRGIN ISLANDS", "AMERICAN SAMOA"}:
            continue
        if not args.include_test and site_id in DEFAULT_EXCLUDES:
            continue
        if site_id in old and old[site_id].get("color"):
            item["color"] = old[site_id]["color"]
        item.update(overrides.get(site_id, {}))
        radars[site_id] = item

    for site_id, item in climavision.items():
        merged = dict(item)
        merged.setdefault("source", "manual Climavision catalog")
        merged.setdefault("color", deterministic_color(site_id))
        merged.update(overrides.get(site_id, {}))
        radars[site_id] = merged

    payload = {
        "schema_version": 1,
        "updated_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source_url": args.url,
        "radar_count": len(radars),
        "radars": dict(sorted(radars.items()))
    }
    out = ROOT / "catalogs" / "radar_catalog.json"
    out.write_text(json.dumps(payload, indent=2) + "\n")
    counts = {}
    for r in radars.values():
        counts[r["network"]] = counts.get(r["network"], 0) + 1
    print(f"Wrote {out}: {len(radars)} radars {counts}")


if __name__ == "__main__":
    main()
