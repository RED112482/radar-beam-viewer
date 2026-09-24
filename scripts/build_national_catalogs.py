#!/usr/bin/env python3
"""Build the national WFO/radar catalog from NOAA CWA geometry and radar metadata.

The generated WFO radar ring contains every configured radar whose nominal range
intersects the WFO CWA, plus a small configurable margin. Curated office-specific
overrides in catalogs/wfo_overrides.json replace auto-generated radar lists where
needed.

Backup assignments are built from catalogs/backup_assignments_seed.json. Roles
not present in the authoritative seed are filled with the nearest WFOs and are
explicitly marked provisional so the UI never presents them as verified backups.
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from pyproj import CRS, Transformer
from shapely.geometry import Point, shape
from shapely.ops import transform

ROOT = pathlib.Path(__file__).resolve().parents[1]
CWA_URL = (
    "https://mapservices.weather.noaa.gov/static/rest/services/"
    "nws_reference_maps/nws_reference_map/FeatureServer/1/query"
)
M_PER_NM = 1852.0
EARTH_RADIUS_KM = 6371.0088

# A radar whose site is outside the CWA must be reasonably close to the CWA
# boundary to be included as supplemental coverage.  The former rule allowed
# a full nominal range circle to merely touch the CWA, which could pull in
# distant 88Ds that were not operationally useful for low-level sampling.
SUPPLEMENTAL_MAX_GAP_NM = {
    "NEXRAD": 100.0,
    "TDWR": 50.0,
    "TERMINAL": 50.0,
    "CLIMAVISION": 54.0,
}


def read_json(path: pathlib.Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def fetch_json(url: str):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "NWS-Radar-Beam-Viewer/1.0 (catalog builder)",
            "Accept": "application/geo+json, application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def prop_ci(props: dict, *names, default=None):
    lower = {str(k).lower(): v for k, v in (props or {}).items()}
    for name in names:
        if str(name).lower() in lower:
            value = lower[str(name).lower()]
            if value not in (None, ""):
                return value
    return default


def fetch_cwas():
    params = {
        "where": "1=1",
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
        "maxAllowableOffset": "0.005",
        "geometryPrecision": "5",
        "f": "geojson",
    }
    fc = fetch_json(CWA_URL + "?" + urllib.parse.urlencode(params))
    features = fc.get("features", [])
    if len(features) < 100:
        raise RuntimeError(f"Expected national CWA dataset; received only {len(features)} features")
    return features


def haversine_km(lat1, lon1, lat2, lon2):
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def safe_centroid(geom, props):
    lat = prop_ci(props, "lat")
    lon = prop_ci(props, "lon")
    try:
        if lat is not None and lon is not None:
            return float(lat), float(lon)
    except (TypeError, ValueError):
        pass
    c = geom.representative_point()
    return float(c.y), float(c.x)


def candidate_radars_for_cwa(cwa_geom, center_lat, center_lon, radars, margin_nm):
    local = CRS.from_proj4(
        f"+proj=aeqd +lat_0={center_lat} +lon_0={center_lon} +datum=WGS84 +units=m +no_defs"
    )
    tf = Transformer.from_crs("EPSG:4326", local, always_xy=True).transform
    cwa_m = transform(tf, cwa_geom)

    result = []
    for rid, radar in radars.items():
        try:
            lat = float(radar["lat"])
            lon = float(radar["lon"])
            range_nm = float(radar["range_nm"])
        except (KeyError, TypeError, ValueError):
            continue

        p = transform(tf, Point(lon, lat))
        gap_nm = p.distance(cwa_m) / M_PER_NM
        network = str(radar.get("network", ""))
        max_gap_nm = SUPPLEMENTAL_MAX_GAP_NM.get(network, range_nm)
        threshold_nm = min(range_nm + margin_nm, max_gap_nm)
        if gap_nm <= threshold_nm:
            result.append(
                {
                    "id": rid,
                    "network": network,
                    "distance_to_cwa_nm": round(gap_nm, 1),
                    "range_nm": range_nm,
                }
            )

    network_order = {"NEXRAD": 0, "TDWR": 1, "TERMINAL": 1, "CLIMAVISION": 2}
    result.sort(
        key=lambda x: (
            x["distance_to_cwa_nm"],
            network_order.get(x["network"], 9),
            x["id"],
        )
    )
    return [x["id"] for x in result]


def nearest_wfos(wfo_id, center, centers, count=3):
    lat, lon = center
    rows = []
    for other_id, (olat, olon) in centers.items():
        if other_id == wfo_id:
            continue
        rows.append((haversine_km(lat, lon, olat, olon), other_id))
    rows.sort()
    return [wfo for _, wfo in rows[:count]]


def build_backups(wfos, seed):
    meta = seed.get("_meta", {})
    sources = meta.get("sources", {})
    result = {}

    for wfo_id, wfo in wfos.items():
        base = dict(seed.get(wfo_id, {}))
        verified = set(base.get("verified_roles", []))
        nearby = list(wfo.get("nearby_wfos", []))
        used = {wfo_id}
        for role in ("primary", "secondary", "tertiary"):
            target = base.get(role)
            if target and target in wfos and target not in used:
                used.add(target)
                continue
            base.pop(role, None)
            for candidate in nearby:
                if candidate not in used:
                    base[role] = candidate
                    used.add(candidate)
                    break

        role_status = {}
        for role in ("primary", "secondary", "tertiary"):
            if base.get(role):
                role_status[role] = "official" if role in verified else "provisional"

        official_count = sum(v == "official" for v in role_status.values())
        if official_count == 3:
            status = "official"
        elif official_count:
            status = "mixed"
        else:
            status = "provisional"

        region = base.get("region")
        source_url = sources.get(region) if region else None
        result[wfo_id] = {
            "primary": base.get("primary"),
            "secondary": base.get("secondary"),
            "tertiary": base.get("tertiary"),
            "verified_roles": sorted(verified),
            "role_status": role_status,
            "status": status,
            "source_region": region,
            "source_url": source_url,
        }

    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--margin-nm",
        type=float,
        default=25.0,
        help="Extra margin beyond each radar's configured range when selecting a WFO radar ring.",
    )
    args = ap.parse_args()

    radar_payload = read_json(ROOT / "catalogs" / "radar_catalog.json", {"radars": {}})
    radars = radar_payload.get("radars", {})
    if len(radars) < 100:
        raise RuntimeError(
            "National radar catalog is not populated yet. Run scripts/update_noaa_radars.py first."
        )

    overrides = read_json(ROOT / "catalogs" / "wfo_overrides.json", {})
    backup_seed = read_json(ROOT / "catalogs" / "backup_assignments_seed.json", {})
    features = fetch_cwas()

    raw = {}
    centers = {}
    for feat in features:
        props = feat.get("properties", {})
        wfo_id = str(prop_ci(props, "cwa", "wfo", default="")).strip().upper()
        if not wfo_id or not feat.get("geometry"):
            continue
        geom = shape(feat["geometry"])
        lat, lon = safe_centroid(geom, props)
        centers[wfo_id] = (lat, lon)
        raw[wfo_id] = (feat, geom, props, lat, lon)

    if len(raw) < 100:
        raise RuntimeError(f"Only {len(raw)} unique WFO/CWAs parsed from NOAA geometry.")

    wfos = {}
    for wfo_id in sorted(raw):
        feat, geom, props, lat, lon = raw[wfo_id]
        name = str(
            prop_ci(
                props,
                "citystate",
                "city",
                default=f"WFO {wfo_id}",
            )
        ).strip()
        region = str(prop_ci(props, "region", default="")).strip().upper()
        auto_radars = candidate_radars_for_cwa(
            geom, lat, lon, radars, margin_nm=args.margin_nm
        )
        nearby = nearest_wfos(wfo_id, (lat, lon), centers, count=5)

        override = overrides.get(wfo_id, {})
        radar_list = list(auto_radars)
        if "radars_replace" in override:
            # Preserve the hand-curated office ring, but do not let a curated
            # NEXRAD list suppress newly-added TDWR or Climavision coverage.
            # This lets the national supplemental networks grow automatically.
            radar_list = [rid for rid in override["radars_replace"] if rid in radars]
            for rid in auto_radars:
                network = str(radars.get(rid, {}).get("network", ""))
                if network in {"TDWR", "TERMINAL", "CLIMAVISION"} and rid not in radar_list:
                    radar_list.append(rid)
        for rid in override.get("radars_add", []):
            if rid in radars and rid not in radar_list:
                radar_list.append(rid)
        remove = set(override.get("radars_remove", []))
        radar_list = [rid for rid in radar_list if rid not in remove]

        display_name = override.get("name", name)
        ring_source = "curated override" if "radars_replace" in override else "NOAA CWA/radar-range intersection"
        wfos[wfo_id] = {
            "name": display_name,
            "description": override.get(
                "description",
                f"WFO {wfo_id} — national radar ring generated from CWA coverage.",
            ),
            "selectable": bool(override.get("selectable", True)),
            "center": {"lat": round(lat, 5), "lon": round(lon, 5)},
            "region": region,
            "radars": radar_list,
            "nearby_wfos": nearby[:3],
            "radar_ring_source": ring_source,
        }

    backups = build_backups(wfos, backup_seed)

    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    wfo_payload = {
        "schema_version": 2,
        "updated_utc": now,
        "default_wfo": "MOB" if "MOB" in wfos else sorted(wfos)[0],
        "generation": {
            "source": "NOAA/NWS CWA FeatureServer + radar_catalog.json",
            "cwa_url": CWA_URL,
            "radar_margin_nm": args.margin_nm,
            "supplemental_max_gap_nm": SUPPLEMENTAL_MAX_GAP_NM,
            "wfo_count": len(wfos),
        },
        "wfos": wfos,
    }

    (ROOT / "catalogs" / "wfo_catalog.json").write_text(
        json.dumps(wfo_payload, indent=2) + "\n"
    )
    (ROOT / "catalogs" / "backup_assignments.json").write_text(
        json.dumps(backups, indent=2) + "\n"
    )

    official = sum(1 for b in backups.values() if b["status"] == "official")
    mixed = sum(1 for b in backups.values() if b["status"] == "mixed")
    provisional = sum(1 for b in backups.values() if b["status"] == "provisional")
    print(
        f"Wrote national catalogs: {len(wfos)} WFOs; "
        f"backup status official={official}, mixed={mixed}, provisional={provisional}"
    )


if __name__ == "__main__":
    main()
