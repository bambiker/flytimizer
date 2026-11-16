#!/usr/bin/env python3
"""
Download 10-minute measurements from the Ministry of Agriculture's
agro-meteorological stations (meteo.moag.gov.il), 2000-2025, with coordinates.

The site has no documented public API. This script calls the same endpoints the
site's "Reports" page (https://meteo.moag.gov.il/Reports) calls from the browser:

  1. GET  reports/station/metadata?stationType=תחנות 10 דקתי   -> station list + each station's channels
  2. POST reports/compass-rose/dates-range-test               -> data range (min/max) for a station
  3. POST reports/station/report                              -> an Excel report (base64) for one station and date range

The payload structure was reconstructed from the site's JavaScript and has not
been tested against the server. If the server returns an error, run with
--dump-meta first and check the structure of the station objects (see "if it
doesn't work" below).

Please check the site's terms of use / get permission from the Ministry before
downloading in bulk. The script is slow on purpose (pause between requests) and
resumable (skips files that were already downloaded).

Usage:
    pip install requests pandas openpyxl
    python moag_download.py --dump-meta            # station list only + coordinates -> out/stations.csv
    python moag_download.py                        # all stations, wind channels only, 2000-2025
    python moag_download.py --all-monitors         # all channels (temperature, humidity, radiation...)
    python moag_download.py --stations "בית דגן" "גילת"
    python moag_download.py --combine              # combine the Excel files into one CSV per station
"""
import argparse, base64, datetime as dt, json, os, re, sys, time

import requests

BASE = "https://uny9pigfrl.execute-api.eu-north-1.amazonaws.com/Observation"
STATION_TYPE = "תחנות 10 דקתי"
REPORT_TYPE = "דוח תחנה"
HEADERS = {"Content-Type": "application/json", "Origin": "https://meteo.moag.gov.il",
           "Referer": "https://meteo.moag.gov.il/", "User-Agent": "research-download/1.0"}

# Names of possible coordinate fields in the station object (we don't know which one the server returns)
LAT_KEYS = ["lat", "Lat", "LAT", "latitude", "Latitude", "y_wgs", "Y_WGS84"]
LON_KEYS = ["lon", "Lon", "LON", "lng", "long", "longitude", "Longitude", "x_wgs", "X_WGS84"]
ITM_X_KEYS = ["X", "x", "itm_x", "ITM_X", "X_ITM", "x_itm", "east", "Easting"]
ITM_Y_KEYS = ["Y", "y", "itm_y", "ITM_Y", "Y_ITM", "y_itm", "north", "Northing"]


def session():
    s = requests.Session()
    s.headers.update(HEADERS)
    return s


def call(s, method, path, *, retries=5, pause=1.5, **kw):
    for a in range(retries):
        try:
            r = s.request(method, BASE + path, timeout=300, **kw)
            if r.status_code == 200:
                time.sleep(pause)
                return r.json()
            print(f"  HTTP {r.status_code}: {r.text[:200]}", file=sys.stderr)
        except Exception as e:  # network / timeout / invalid JSON
            print(f"  error: {e}", file=sys.stderr)
        time.sleep(5 * (a + 1))
    raise RuntimeError(f"failed: {method} {path}")


def iso_midnight(d: dt.date) -> str:
    # The site sends the local date at midnight as a UTC string (createDateCopy + JSON)
    return f"{d.isoformat()}T00:00:00.000Z"


def get_stations(s):
    data = call(s, "GET", "/reports/station/metadata", params={"stationType": STATION_TYPE})
    if not data.get("success", True):
        raise RuntimeError(data.get("message"))
    return data["reportMetaData"]["metaDataForReport"]


def first(d, keys):
    for k in keys:
        if k in d and d[k] not in (None, ""):
            try:
                return float(d[k])
            except (TypeError, ValueError):
                pass
    return None


def coords(st):
    lat, lon = first(st, LAT_KEYS), first(st, LON_KEYS)
    if lat is None or lon is None:
        x, y = first(st, ITM_X_KEYS), first(st, ITM_Y_KEYS)
        if x and y and x > 1e5 and y > 3e5:  # looks like the Israeli grid (ITM)
            try:
                from pyproj import Transformer
                lon, lat = Transformer.from_crs(2039, 4326, always_xy=True).transform(x, y)
            except ImportError:
                print("  pyproj is needed to convert ITM coordinates: pip install pyproj", file=sys.stderr)
    if lat is not None and lon is not None and not (29 < lat < 34) and 29 < lon < 34:
        lat, lon = lon, lat  # the fields came back swapped
    return lat, lon


def pick_monitors(st, all_monitors):
    mons = st.get("monitors") or {}
    out = {}
    for key, m in mons.items():
        name = (m or {}).get("monitorHebName", "")
        if all_monitors or "רוח" in name or re.search(r"WS|WD|wind", key, re.I):
            out[key] = {"monitorHebName": name, "units": (m or {}).get("units")}
    return out


def date_range(s, st, monitors):
    body = {"stationsMetaDataList": [{**st, "stationSelectedMonitors": monitors}], "reportType": REPORT_TYPE}
    r = call(s, "POST", "/reports/compass-rose/dates-range-test", json=body)
    o = r.get("stationDatesRangeObj") or {}
    f = lambda v: dt.date.fromisoformat(str(v)[:10]) if v else None
    return f(o.get("minDate")), f(o.get("maxDate"))


def months(start: dt.date, end: dt.date):
    d = start.replace(day=1)
    while d <= end:
        nxt = (d.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
        yield max(d, start), min(nxt - dt.timedelta(days=1), end)
        d = nxt


def safe(name):
    return re.sub(r'[\\/:*?"<>|\']', "", name).strip()


def download(args):
    s = session()
    os.makedirs(args.out, exist_ok=True)
    stations = get_stations(s)
    json.dump(stations, open(f"{args.out}/stations_raw.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    write_station_table(stations, args.out)
    if args.dump_meta:
        return
    if args.owner:
        stations = [st for st in stations if args.owner in str(st.get("owner", ""))]
    if args.stations:
        stations = [st for st in stations if st.get("Heb_name") in args.stations]
    start, end = dt.date(args.start, 1, 1), dt.date(args.end, 12, 31)
    for i, st in enumerate(stations, 1):
        name = st.get("Heb_name", f"station_{i}")
        mons = pick_monitors(st, args.all_monitors)
        if not mons:
            print(f"[{i}/{len(stations)}] {name}: no matching channels, skipping")
            continue
        try:
            dmin, dmax = date_range(s, st, mons)
        except RuntimeError as e:
            print(f"[{i}/{len(stations)}] {name}: date range failed ({e}), trying the full range")
            dmin, dmax = None, None
        a, b = max(start, dmin or start), min(end, dmax or end)
        print(f"[{i}/{len(stations)}] {name}: {a} .. {b}, channels: {', '.join(m['monitorHebName'] for m in mons.values())}")
        if a > b:
            continue
        sdir = f"{args.out}/raw/{safe(name)}"
        os.makedirs(sdir, exist_ok=True)
        for m0, m1 in months(a, b):
            f = f"{sdir}/{m0:%Y-%m}.xlsx"
            if os.path.exists(f) or os.path.exists(f + ".empty"):
                continue
            body = {"stations": [st],
                    "selectedDateRange": {"startDate": iso_midnight(m0), "endDate": iso_midnight(m1)},
                    "stationSelectedMonitors": mons}
            try:
                r = call(s, "POST", "/reports/station/report", json=body, pause=args.pause)
            except RuntimeError as e:
                print(f"    {m0:%Y-%m}: {e}")
                continue
            buf = r.get("resultBuffer") if r.get("success") else None
            if not buf:
                open(f + ".empty", "w").write(json.dumps(r, ensure_ascii=False)[:500])
                print(f"    {m0:%Y-%m}: no data")
                continue
            open(f, "wb").write(base64.b64decode(buf))
            print(f"    {m0:%Y-%m}: ok")


def write_station_table(stations, out):
    import csv
    with open(f"{out}/stations.csv", "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Heb_name", "owner", "area", "lat", "lon", "monitors"])
        n_xy = 0
        for st in stations:
            lat, lon = coords(st)
            n_xy += lat is not None
            w.writerow([st.get("Heb_name"), st.get("owner"), st.get("area"), lat, lon,
                        "; ".join(f"{k}={(v or {}).get('monitorHebName')}" for k, v in (st.get("monitors") or {}).items())])
    print(f"{len(stations)} stations, {n_xy} with coordinates -> {out}/stations.csv")
    if n_xy == 0:
        keys = sorted({k for st in stations for k in st})
        print("No coordinate fields found. Fields in the station object:", keys)
        print("Fill the coordinates from another source (see README) or add the field name to LAT_KEYS/LON_KEYS.")


def combine(args):
    import pandas as pd
    st = {r["Heb_name"]: r for r in pd.read_csv(f"{args.out}/stations.csv").to_dict("records")}
    os.makedirs(f"{args.out}/csv", exist_ok=True)
    for sname in sorted(os.listdir(f"{args.out}/raw")):
        files = sorted(f for f in os.listdir(f"{args.out}/raw/{sname}") if f.endswith(".xlsx"))
        parts = []
        for f in files:
            df = pd.read_excel(f"{args.out}/raw/{sname}/{f}", header=None)
            # Find the header row: the first row that contains a date/time field
            hdr = next((i for i, row in df.iterrows() if any(re.search("תאריך|שעה|זמן|date|time", str(v), re.I) for v in row)), 0)
            df.columns = [str(c).strip() for c in df.iloc[hdr]]
            parts.append(df.iloc[hdr + 1:])
        if not parts:
            continue
        df = pd.concat(parts, ignore_index=True)
        meta = next((v for k, v in st.items() if safe(str(k)) == sname), {})
        df.insert(0, "station", sname)
        df.insert(1, "lat", meta.get("lat"))
        df.insert(2, "lon", meta.get("lon"))
        df.to_csv(f"{args.out}/csv/{sname}.csv", index=False, encoding="utf-8-sig")
        print(f"{sname}: {len(df)} rows")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", default="moag_data")
    p.add_argument("--start", type=int, default=2000)
    p.add_argument("--end", type=int, default=2025)
    p.add_argument("--stations", nargs="*", help="Station names in Hebrew, as on the site")
    p.add_argument("--owner", default="משרד החקלאות", help='Station owner filter; "" = all (the site also shows IMS stations)')
    p.add_argument("--all-monitors", action="store_true", help="All channels, not just wind")
    p.add_argument("--pause", type=float, default=2.0, help="Seconds between report requests")
    p.add_argument("--dump-meta", action="store_true", help="Download the station list only")
    p.add_argument("--combine", action="store_true", help="Combine the Excel files that were downloaded into a CSV")
    a = p.parse_args()
    combine(a) if a.combine else download(a)
