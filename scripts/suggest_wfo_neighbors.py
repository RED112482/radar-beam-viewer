#!/usr/bin/env python3
"""Suggest radar sites whose configured coverage intersects an NWS WFO CWA.

This is a review aid for building each WFO's neighboring-radar ring. It does not
silently overwrite curated WFO assignments.
"""
from __future__ import annotations
import argparse, json, pathlib, urllib.parse, urllib.request
from shapely.geometry import shape, Point
from shapely.ops import transform
from pyproj import CRS, Transformer

ROOT = pathlib.Path(__file__).resolve().parents[1]
CWA_URL = 'https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/FeatureServer/1/query'
M_PER_NM = 1852.0


def load_cwa(wfo):
    params = {
        'where': f"cwa='{wfo.upper()}'", 'outFields': 'cwa', 'returnGeometry': 'true',
        'outSR': '4326', 'f': 'geojson'
    }
    url = CWA_URL + '?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=60) as r:
        fc = json.load(r)
    if not fc.get('features'):
        raise SystemExit(f'No CWA geometry returned for {wfo}')
    return shape(fc['features'][0]['geometry'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('wfo')
    ap.add_argument('--margin-nm', type=float, default=0.0,
                    help='Extra distance beyond each radar configured range')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    catalog = json.loads((ROOT / 'catalogs/radar_catalog.json').read_text())['radars']
    cwa = load_cwa(args.wfo)
    c = cwa.centroid
    local = CRS.from_proj4(f'+proj=aeqd +lat_0={c.y} +lon_0={c.x} +datum=WGS84 +units=m +no_defs')
    tf = Transformer.from_crs('EPSG:4326', local, always_xy=True).transform
    cwa_m = transform(tf, cwa)
    result = []
    for rid, r in catalog.items():
        p = transform(tf, Point(r['lon'], r['lat']))
        distance_m = p.distance(cwa_m)
        threshold_m = (float(r['range_nm']) + args.margin_nm) * M_PER_NM
        if distance_m <= threshold_m:
            result.append({
                'id': rid,
                'network': r['network'],
                'distance_to_cwa_nm': round(distance_m / M_PER_NM, 1),
                'range_nm': r['range_nm'],
                'lowest_tilt_deg': r['lowest_tilt_deg']
            })
    result.sort(key=lambda x: (x['distance_to_cwa_nm'], x['id']))
    out = pathlib.Path(args.out) if args.out else ROOT / 'data' / 'neighbor_suggestions' / f'{args.wfo.upper()}.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({'wfo': args.wfo.upper(), 'radars': result}, indent=2) + '\n')
    print(f'Wrote {out} with {len(result)} candidates')


if __name__ == '__main__':
    main()
