# National Radar Beam Height Viewer

Static GitHub Pages viewer for exploring lowest radar beam height **Above Radar Level (ARL)** by NWS Forecast Office.

## Current first case

The first selectable office is **MOB — Mobile/Pensacola**. When MOB is selected the viewer builds four toggleable radar groups:

- **MOB — Home Office**
- **LIX — Primary Backup**
- **TAE — Secondary Backup**
- **KEY — Tertiary Backup**

Each group can be switched on/off, and individual radar sites inside a group can also be switched on/off. The lowest available beam is recalculated directly in the browser from radar latitude/longitude, lowest tilt, and configured range.

## Why the viewer does not need beam `.bin` files

ARL beam height does not require terrain. For each site the browser needs only radar latitude/longitude, lowest elevation angle, maximum viewing range, and 4/3-Earth beam geometry.

The beam-center equation used is:

`h = sqrt(r^2 + Re^2 + 2*r*Re*sin(theta)) - Re`

where `Re = 4/3 * Earth radius`. The radar origin is 0 ft ARL.

## Publish as a public GitHub Pages link

1. Open this repository on GitHub.
2. Select **Settings** → **Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Choose branch **main** and folder **/(root)**.
5. Click **Save**.
6. The viewer will publish at approximately `https://RED112482.github.io/radar-beam-viewer/`.

The same URL can be embedded in Google Sites with **Insert → Embed → By URL**.

## Test locally

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000/`. Do not double-click `index.html`; the viewer needs HTTP so `fetch()` can load the JSON catalogs.

## Catalog design

Three kinds of information are intentionally separated:

1. **Radar catalog** — physical radar sites and beam metadata.
2. **WFO catalog** — the radar ring assigned to each forecast office.
3. **Backup assignments** — primary/secondary/tertiary office relationships.

This keeps backup-office changes from requiring radar metadata changes and allows the same physical radar to be referenced by multiple WFOs.

## Refresh NOAA radar metadata

Run:

```powershell
python scripts\update_noaa_radars.py
python scripts\validate_catalog.py
```

The updater reads the current NOAA/NCEI NEXRAD/TDWR station inventory, applies `catalogs/radar_overrides.json`, merges `catalogs/climavision_radars.json`, and rewrites `catalogs/radar_catalog.json`.

Network defaults are NEXRAD 0.5° / 124 nmi and TDWR 0.3° / 48 nmi; site-specific lowest tilts belong in the overrides file. Climavision sites are maintained manually at 40 nmi unless specified otherwise.

## Add another WFO

Install the optional spatial dependencies:

```powershell
pip install -r requirements.txt
```

Generate a neighboring-radar suggestion from the official NWS CWA polygon:

```powershell
python scripts\suggest_wfo_neighbors.py LIX
```

Review `data/neighbor_suggestions/LIX.json`, add the approved radar IDs to `catalogs/wfo_catalog.json`, set `selectable` to `true` when ready, and add the office relationships to `catalogs/backup_assignments.json`.

Validate with:

```powershell
python scripts\validate_catalog.py
```

Then commit and push. The GitHub Pages URL stays the same and the WFO dropdown updates from the catalog.

## Climavision

Climavision remains a manual catalog because this project does not assume a complete authoritative public machine-readable inventory of every active site. Add verified sites to `catalogs/climavision_radars.json`; the NOAA updater merges them into the main catalog.

## Map layers

The viewer uses NOAA/NWS reference-map services for CWA, state, and county boundaries, with OpenStreetMap as the background basemap.
