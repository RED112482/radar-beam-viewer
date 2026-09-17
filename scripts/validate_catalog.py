#!/usr/bin/env python3
import json, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
radars = json.loads((ROOT / 'catalogs/radar_catalog.json').read_text()).get('radars', {})
wfos = json.loads((ROOT / 'catalogs/wfo_catalog.json').read_text()).get('wfos', {})
backups = json.loads((ROOT / 'catalogs/backup_assignments.json').read_text())
errors = []
for wid, w in wfos.items():
    if not isinstance(w.get('center'), dict) or not {'lat','lon'} <= set(w['center']):
        errors.append(f'{wid}: missing center lat/lon')
    for rid in w.get('radars', []):
        if rid not in radars:
            errors.append(f'{wid}: radar {rid} missing from radar_catalog.json')
for wid, b in backups.items():
    if wid not in wfos:
        errors.append(f'backup assignment references unknown WFO {wid}')
    for role in ('primary','secondary','tertiary'):
        target = b.get(role)
        if target and target not in wfos:
            errors.append(f'{wid}: {role} backup {target} missing from wfo_catalog.json')
for rid, r in radars.items():
    for key in ('lat','lon','lowest_tilt_deg','range_nm','network'):
        if key not in r:
            errors.append(f'{rid}: missing {key}')
if errors:
    print('CATALOG VALIDATION FAILED')
    print('\n'.join(f' - {e}' for e in errors))
    sys.exit(1)
print(f'OK: {len(radars)} radars, {len(wfos)} WFO definitions, {len(backups)} backup assignments')
