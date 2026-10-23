#!/usr/bin/env python3
"""
DJI flight logs -> battery model -> when will the battery run out on a route?

What it does
------------
1. Loads DJI flight-record CSVs (one file = one flight).
2. Turns each flight into 1-second samples. Raw 10 Hz speeds are
   quantised to 0.1 m/s, so accelerations taken from them at 10 Hz are
   mostly noise (0.1 m/s / 0.1 s = 1 m/s^2 steps); 1 s averages are far
   cleaner.
3. Models the POWER the drone draws (battery voltage x current), not the
   current. Current rises as the voltage sags through a flight even when
   the drone does exactly the same thing; power does not. This also keeps
   battery-to-battery differences out of the flight model: an older pack
   sags more and draws more current for the same power.
       power ~ airspeed, airspeed^2, airspeed^3, climb rate, descent rate,
               |horizontal acceleration|, |yaw rate|
   airspeed = |ground velocity - wind|. Wind is not in the logs, so one
   wind vector per day is estimated together with the model.
4. Converts energy (Wh) into battery % with a Wh-per-% CURVE that depends
   on the battery % itself. DJI's charge level counts charge (mAh), and
   the voltage is lower when the battery is low, so the last percents hold
   less energy than the first ones. The curve is measured from every 1%
   step in the logs (energy drawn between two changes of the charge
   level), per battery when that battery has enough steps (serial number
   from the logs, or --battery-map), otherwise from all batteries.
   Batteries age, so recent flights count more (--half-life), and when
   the logs carry the battery's own full-charge capacity the curve
   follows it. A health table shows each battery's energy over time.
5. Leave-one-out validation: each flight in turn is predicted by a model
   fitted on all the other flights, and compared with what its battery
   actually did. Compared side by side:
       naive     - average %/minute of the training flights
       site old  - the Flytimizer site's battery estimate (js/battery.js)
                   with the Neo 2 spec sheet: 11.5 Wh, 19 min
       site 27   - the Neo 2 preset from PR #27: 10 Wh, 11.4 min, and the
                   speed curve and climb efficiency measured from these
                   logs; every gauge % holds the same energy
       site new  - the site's current Neo 2 preset: the same, plus the
                   gauge's last percents holding less energy (socSlope),
                   from the battery % the flight started at
       site fit  - the site's own formula with its hover power, speed
                   curve and climb cost fitted to the OTHER flights' power
                   (what a new preset from these logs would score)
       no wind   - this model, wind assumed zero
       same day  - this model, wind estimated from the OTHER flights of
                   the same day (what you would know before flying)
       own wind  - this model, wind fitted on the test flight itself
                   (an upper bound: not available before the flight)
       E/% flat  - the TRUE energy of the flight converted with one fixed
                   Wh/% - isolates the battery-conversion error
       E/% curve - the same with the Wh/% curve; the drop from 'E/% flat'
                   is what the curve buys
   All model methods (no wind, same day, own wind) use the curve.
6. --route: predicts battery % along a planned route and when it reaches
   the reserve and empty.
7. Wind effects: for each flight, how much battery the (estimated) wind
   cost compared with calm air and its worst 10 seconds, and how far the
   drone drifted, by GPS, while it was hovering. Then the same summed
   over each whole flight (battery, and how far the wind would have
   carried the drone - sideways, head-on and while hovering), the flight
   where each is largest, and cumulative plots with --plot-dir.

Usage
-----
    python3 dji_battery_model.py ~/dji
    python3 dji_battery_model.py ~/dji --loo day
    python3 dji_battery_model.py ~/dji --route route.csv --soc 100 \\
        --wind-speed 4 --wind-from 270 --speed 8
    python3 dji_battery_model.py ~/dji --battery-map batteries.csv

Route CSV: one waypoint per row, heights above takeoff (m).
    lat,lon,alt[,speed][,hover_s]            or
    north_m,east_m,alt[,speed][,hover_s]
speed (m/s, ground) is for the leg leaving that waypoint; hover_s is time
spent hovering at it. The drone takes off vertically to the first
waypoint's height and lands vertically after the last one.

Battery map CSV (only needed when the logs carry no battery serial):
    file,battery
    DJIFlightRecord_2026-09-20_[14-43-19].csv,A
    DJIFlightRecord_2026-09-20_[14-46-19].csv,B
"""

import argparse
import glob
import json
import os
import re
import sys
from types import SimpleNamespace

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------

DEFAULT_PATH = os.path.expanduser("~/dji")

BIN_S = 1.0               # sample length used for modelling
MAX_ROW_GAP_S = 1.0       # longer gaps between log rows are not integrated
SPEED_SCALE = 10.0        # airspeed features use airspeed / 10 m/s
MIN_SOC_DROP_FOR_WH = 3.0     # flights used to measure Wh per %
MIN_SOC_DROP_FOR_EVAL = 5.0   # flights scored in leave-one-out (1% steps)
MIN_EVAL_AIRBORNE_S = 60.0

WIND_SPEEDS = np.arange(0.0, 12.01, 0.5)
WIND_DIRS = np.arange(0.0, 360.0, 10.0)
WIND_ITERS = 4
SPEED_TERMS = 2           # power vs airspeed: 2 = 1 + a*x + b*x^3 (b >= 0); 3 = free cubic

DATETIME_COL = "CUSTOM.dateTime"
NEEDED = [
    "OSD.flyTime", "OSD.xSpeed", "OSD.ySpeed", "OSD.zSpeed", "OSD.height",
    "OSD.yaw", "OSD.isOnGround", "BATTERY.current", "BATTERY.voltage",
    "BATTERY.chargeLevel",
]

FEATURES = [
    "intercept (hover)", "airspeed", "airspeed^2", "airspeed^3",
    "climb m/s", "descent m/s", "|accel| m/s2", "|yaw rate| deg/s",
]

# The site's DJI Neo 2 preset (js/drone.js) and battery model constants
# (js/battery.js), used as the "spec" comparison.
SPEC = SimpleNamespace(wh=11.5, minutes=19.0, mass=0.151, vmax=12.0,
                       test_speed=6.0, climb_eff=0.6, descent_factor=0.9,
                       curve_a=-0.2, curve_b=0.5)
SPEC.soc_slope = 0.0
# The Neo 2 preset from PR #27: its own speed curve and climb efficiency.
SPEC_27 = SimpleNamespace(**{**vars(SPEC), "wh": 10.0, "minutes": 11.4,
                             "curve_a": 0.1, "curve_b": 0.47, "climb_eff": 0.19})
# The current Neo 2 preset: also the gauge's last percents holding less.
SPEC_NEW = SimpleNamespace(**{**vars(SPEC_27), "soc_slope": 0.002})


def site_gauge_used(spec, energy_pct, start_pct):
    """js/battery.js gaugeUsedPct: gauge % used from start_pct when a
    flight uses energy_pct % of the battery's energy."""
    k = spec.soc_slope
    if not k:
        return energy_pct
    below = lambda p: p + k * (p * p / 2 - 50 * p)  # noqa: E731
    target = below(start_pct) - energy_pct
    if target <= 0:
        return energy_pct + start_pct - below(start_pct)
    a, b = k / 2, 1 - 50 * k
    left = (-b + np.sqrt(b * b + 4 * a * target)) / (2 * a)
    return start_pct - left

METHODS = ["naive", "site old", "site 27", "site new", "site fit", "no wind", "same day", "own wind", "E/% flat", "E/% curve"]

MIN_STEPS_PER_BATTERY = 40    # 1% steps needed for a battery's own curve
# Batteries age: a flight this many flights (of the same battery) away
# from the one being predicted counts half as much. 0 = all count equally.
HALF_LIFE_FLIGHTS = 30.0
USE_CAPACITY = True   # scale the curve by the battery-reported capacity
MIN_SOC_DROP_FOR_HEALTH = 20.0   # flights used to track a battery's energy
SOC_GRID = np.arange(-30.0, 100.001, 0.05)   # for energy <-> % conversion


# ---------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------

def find_csv_files(path):
    if os.path.isdir(path):
        return sorted(glob.glob(os.path.join(path, "*.csv")))
    if os.path.isfile(path):
        return [path]
    return []


def num(raw, col):
    if col not in raw.columns:
        return pd.Series(np.nan, index=raw.index)
    return pd.to_numeric(raw[col], errors="coerce")


def battery_serial_columns(columns):
    out = []
    for c in columns:
        low = c.lower()
        if "batt" in low and ("serial" in low or low.endswith("sn")):
            out.append(c)
    return out


def flight_session(raw, name):
    """The flight's date, used to group flights that shared the same wind.
    The file name comes first: some logs carry a corrupt dateTime."""
    m = re.search(r"(\d{4}-\d{2}-\d{2})", name)
    if m:
        return m.group(1)
    if DATETIME_COL in raw.columns:
        try:
            parsed = pd.to_datetime(raw[DATETIME_COL], errors="coerce")
            parsed = parsed[parsed.dt.year > 2000]
            if len(parsed):
                return str(parsed.iloc[0].date())
        except (ValueError, TypeError):
            pass
    return "unknown-date"


def flight_start(raw, name):
    """When the flight started, from the file name (..._2026-10-14_[17-05-39])
    or the log's dateTime; used to put each battery's flights in order."""
    m = re.search(r"(\d{4}-\d{2}-\d{2})_\[(\d{2})-(\d{2})-(\d{2})\]", name)
    if m:
        return pd.Timestamp(f"{m.group(1)} {m.group(2)}:{m.group(3)}:{m.group(4)}")
    if DATETIME_COL in raw.columns:
        parsed = pd.to_datetime(raw[DATETIME_COL], errors="coerce")
        parsed = parsed[parsed.dt.year > 2000]
        if len(parsed):
            return pd.Timestamp(parsed.iloc[0]).tz_localize(None)
    return pd.NaT


def _battery_column_median(raw, *needles):
    """Median of the first battery column whose name holds one of the
    needles (e.g. full-charge capacity, cycle count), or nan."""
    for c in raw.columns:
        low = c.lower().replace("_", "")
        if "batt" in low and any(n in low for n in needles):
            v = pd.to_numeric(raw[c], errors="coerce")
            v = v[v > 0]
            if len(v):
                return float(v.median()), c
    return np.nan, None


def flight_battery(raw, name, battery_map):
    if name in battery_map:
        return battery_map[name]
    for c in battery_serial_columns(raw.columns):
        vals = raw[c].dropna().astype(str).str.strip()
        vals = vals[~vals.str.lower().isin(["", "0", "nan", "none"])]
        if len(vals):
            return vals.mode().iloc[0]
    return "unknown"


def load_flight(path, battery_map):
    name = os.path.basename(path)
    try:
        raw = pd.read_csv(path, low_memory=False)
    except Exception as e:  # noqa: BLE001 - report and carry on
        print(f"[skip] {name}: cannot read ({e})")
        return None

    missing = [c for c in NEEDED if c not in raw.columns]
    if missing:
        print(f"[skip] {name}: missing {', '.join(missing)}")
        return None

    volt = num(raw, "BATTERY.voltage")
    if volt.median() > 100:          # logged in mV
        volt = volt / 1000.0
    cur = num(raw, "BATTERY.current").abs()
    if cur.median() > 200:           # logged in mA
        cur = cur / 1000.0

    ground = raw["OSD.isOnGround"].astype(str).str.strip().str.lower()
    d = pd.DataFrame({
        "t": num(raw, "OSD.flyTime"),
        "vn": num(raw, "OSD.xSpeed"),
        "ve": num(raw, "OSD.ySpeed"),
        "vz": num(raw, "OSD.zSpeed"),
        "h": num(raw, "OSD.height"),
        "yaw": num(raw, "OSD.yaw"),
        "P": volt * cur,
        "soc": num(raw, "BATTERY.chargeLevel"),
        "temp": num(raw, "BATTERY.temperature"),
        "lat": num(raw, "OSD.latitude"),
        "lon": num(raw, "OSD.longitude"),
        "air": ~ground.isin(["true", "1", "yes"]),
    })
    d = d.dropna(subset=["t", "vn", "ve", "vz", "h", "P"])
    d = d.sort_values("t").drop_duplicates("t")

    air_t = d.loc[d["air"], "t"]
    if len(air_t) == 0:
        print(f"[skip] {name}: never airborne")
        return None
    d = d[(d["t"] >= air_t.iloc[0]) & (d["t"] <= air_t.iloc[-1])]
    d = d.reset_index(drop=True)
    if d["t"].iloc[-1] - d["t"].iloc[0] < 10:
        print(f"[skip] {name}: airborne for less than 10 s")
        return None

    # Energy actually drawn, integrated over the raw rows.
    dt = d["t"].diff().shift(-1).clip(lower=0, upper=MAX_ROW_GAP_S).fillna(0)
    d["dur"] = dt
    d["eJ"] = d["P"] * dt
    d["ys"] = np.sin(np.radians(d["yaw"]))
    d["yc"] = np.cos(np.radians(d["yaw"]))
    d["airf"] = d["air"].astype(float)
    d["bin"] = np.floor((d["t"] - d["t"].iloc[0]) / BIN_S).astype(int)

    b = d.groupby("bin").agg(
        t=("t", "mean"), vn=("vn", "mean"), ve=("ve", "mean"),
        vz=("vz", "mean"), h=("h", "mean"), P=("P", "mean"),
        soc=("soc", "mean"), lat=("lat", "mean"), lon=("lon", "mean"),
        ys=("ys", "mean"), yc=("yc", "mean"), air=("airf", "mean"),
        dur=("dur", "sum"), eJ=("eJ", "sum"),
    )
    b = b[b["dur"] > 0].reset_index(drop=True)
    if len(b) < 10:
        print(f"[skip] {name}: too few samples")
        return None

    t = b["t"].to_numpy()
    b["acc"] = np.hypot(np.gradient(b["vn"], t), np.gradient(b["ve"], t))
    yaw = np.unwrap(np.arctan2(b["ys"], b["yc"]))
    b["yawr"] = np.degrees(np.gradient(yaw, t))
    dh = np.gradient(b["h"], t)

    soc = d.loc[d["air"], "soc"].dropna()
    soc = soc[soc > 0]
    soc_start = float(soc.iloc[0]) if len(soc) else np.nan
    soc_end = float(soc.iloc[-1]) if len(soc) else np.nan

    return SimpleNamespace(
        name=name,
        session=flight_session(raw, name),
        battery=flight_battery(raw, name, battery_map),
        bins=b,
        z_corr=_corr(b["vz"], dh),
        axis_check=_gps_axis_check(b),
        soc_start=soc_start,
        soc_end=soc_end,
        steps=soc_steps(d),
        start=flight_start(raw, name),
        full_cap=_battery_column_median(raw, "fullcap", "fullchargecap")[0],
        cycles=_battery_column_median(raw, "cycle", "loopnum")[0],
        cap_cols=[c for c in (_battery_column_median(raw, "fullcap", "fullchargecap")[1],
                              _battery_column_median(raw, "cycle", "loopnum")[1]) if c],
        temp=float(d["temp"].mean()) if d["temp"].notna().any() else np.nan,
        serial_cols=battery_serial_columns(raw.columns),
    )


def soc_steps(d):
    """Energy drawn for each whole 1% of the charge level.

    Each step runs from the row where the level drops to L until the row
    where it drops below L, all in the air. The first and last levels of
    a flight are partial and left out, and so are steps where the level
    went up (gauge corrections) or jumped by more than 2%.
    """
    soc = d["soc"].where(d["soc"] > 0).ffill().to_numpy()
    ce = np.concatenate([[0.0], np.cumsum(d["eJ"].to_numpy())])
    air = d["air"].to_numpy()
    change = np.where(np.isfinite(soc[1:]) & np.isfinite(soc[:-1])
                      & (soc[1:] != soc[:-1]))[0] + 1
    rows = []
    for a, b in zip(change[:-1], change[1:]):
        level, before, after = soc[a], soc[a - 1], soc[b]
        if not (before > level > after) or level - after > 2 or not air[a:b].all():
            continue
        rows.append((level, (ce[b] - ce[a]) / 3600.0, level - after))
    return pd.DataFrame(rows, columns=["level", "wh", "drop"])


def _corr(a, b):
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 10 or np.std(a[ok]) < 1e-6 or np.std(b[ok]) < 1e-6:
        return np.nan
    return float(np.corrcoef(a[ok], b[ok])[0, 1])


def _gps_axis_check(b):
    """+1 if xSpeed/ySpeed match GPS north/east, -1 if swapped, nan if unknown."""
    lat, lon = b["lat"].to_numpy(), b["lon"].to_numpy()
    if not (np.isfinite(lat).sum() > 20 and np.nanmax(np.abs(lat)) > 1):
        return np.nan
    t = b["t"].to_numpy()
    gn = np.gradient(lat, t) * 111320.0
    ge = np.gradient(lon, t) * 111320.0 * np.cos(np.radians(np.nanmean(lat)))
    straight = np.nansum([_corr(b["vn"], gn), _corr(b["ve"], ge)])
    swapped = np.nansum([_corr(b["vn"], ge), _corr(b["ve"], gn)])
    if max(abs(straight), abs(swapped)) < 0.5:
        return np.nan
    return 1.0 if straight >= swapped else -1.0


def load_all(path, battery_map):
    files = find_csv_files(path)
    if not files:
        sys.exit(f"[error] No CSV files found at: {path}")
    print(f"found {len(files)} csv file(s) in {path}")

    flights = [f for f in (load_flight(p, battery_map) for p in files) if f]
    if not flights:
        sys.exit("[error] No usable flights.")

    # Vertical speed sign: DJI logs zSpeed positive DOWN in some exports.
    # Decide per flight from the height trace, or by majority when a
    # flight hardly changed height.
    votes = [np.sign(f.z_corr) for f in flights if abs(np.nan_to_num(f.z_corr)) > 0.3]
    majority = np.sign(np.sum(votes)) if votes and np.sum(votes) != 0 else -1.0
    flipped = 0
    for f in flights:
        sign = np.sign(f.z_corr) if abs(np.nan_to_num(f.z_corr)) > 0.3 else majority
        f.bins["up"] = sign * f.bins["vz"]
        flipped += sign < 0
    print(f"vertical speed: zSpeed is positive DOWN in {flipped}/{len(flights)} "
          f"flight(s) (checked against the height trace) - corrected")

    # North/east axes, checked against GPS when the log has positions.
    checks = [f.axis_check for f in flights if np.isfinite(f.axis_check)]
    swapped = sum(c < 0 for c in checks)
    if checks:
        print(f"xSpeed/ySpeed vs GPS: {len(checks) - swapped} north/east, "
              f"{swapped} swapped")
    for f in flights:
        if f.axis_check < 0:
            f.bins["vn"], f.bins["ve"] = f.bins["ve"].copy(), f.bins["vn"].copy()

    for f in flights:
        b = f.bins[f.bins["air"] >= 0.5].reset_index(drop=True)
        f.bins = b
        f.duration_s = float(b["dur"].sum())
        f.energy_wh = float(b["eJ"].sum() / 3600.0)
        f.soc_drop = f.soc_start - f.soc_end

    # Each battery's flights in time order: 0 = its first logged flight.
    for bat in {f.battery for f in flights}:
        own = sorted((f for f in flights if f.battery == bat),
                     key=lambda f: (pd.isna(f.start), f.start if not pd.isna(f.start) else 0, f.name))
        for i, f in enumerate(own):
            f.seq = i

    cap_cols = sorted({c for f in flights for c in f.cap_cols})
    if cap_cols:
        print(f"battery capacity/cycle column(s): {', '.join(cap_cols)}")
    else:
        print("no battery capacity or cycle-count column in the logs - battery ageing "
              "is followed from the flights themselves")

    serial_cols = sorted({c for f in flights for c in f.serial_cols})
    if serial_cols:
        print(f"battery serial column(s): {', '.join(serial_cols)}")
    elif not battery_map:
        print("no battery serial column in the logs - all flights count as one "
              "battery (use --battery-map to tell them apart)")
    return flights


def read_battery_map(path):
    if not path:
        return {}
    m = pd.read_csv(path)
    m.columns = [c.strip().lower() for c in m.columns]
    return {os.path.basename(str(r["file"]).strip()): str(r["battery"]).strip()
            for _, r in m.iterrows()}


# ---------------------------------------------------------------------
# Power model
# ---------------------------------------------------------------------

def design(vn, ve, up, acc, yawr, wind, va_max=None):
    va = np.hypot(np.asarray(vn) - wind[0], np.asarray(ve) - wind[1])
    if va_max is not None:
        va = np.minimum(va, va_max)
    x = va / SPEED_SCALE
    up = np.asarray(up, float)
    return np.column_stack([
        np.ones_like(x), x, x ** 2, x ** 3,
        np.clip(up, 0, None), np.clip(-up, 0, None),
        np.asarray(acc, float), np.abs(np.asarray(yawr, float)),
    ])


def flight_design(f, wind, va_max=None):
    b = f.bins
    return design(b["vn"], b["ve"], b["up"], b["acc"], b["yawr"], wind, va_max)


def lstsq(X, y):
    ok = np.all(np.isfinite(X), axis=1) & np.isfinite(y)
    beta, *_ = np.linalg.lstsq(X[ok], y[ok], rcond=None)
    return beta


def fit_power(X, y):
    """Power coefficients with a stable speed curve. With SPEED_TERMS = 2
    the curve is 1 + a*x + b*x^3 (the site's form, no x^2 term) and the
    x^3 term can't go negative - so power can't fall at high speed, and
    the curve can't trade itself off against the wind estimate. With 3,
    all of x, x^2, x^3 are free (the old behaviour)."""
    if SPEED_TERMS >= 3:
        return lstsq(X, y)
    cols = [0, 1, 3, 4, 5, 6, 7]
    beta = np.zeros(X.shape[1])
    beta[cols] = lstsq(X[:, cols], y)
    if beta[3] < 0:
        cols = [0, 1, 4, 5, 6, 7]
        beta = np.zeros(X.shape[1])
        beta[cols] = lstsq(X[:, cols], y)
    return beta


def r2(y, pred):
    ok = np.isfinite(y) & np.isfinite(pred)
    ss = np.sum((y[ok] - y[ok].mean()) ** 2)
    return 1.0 - np.sum((y[ok] - pred[ok]) ** 2) / ss if ss > 0 else np.nan


def _wind_search(beta, vn, ve, rest, y, speeds, dirs):
    best = (np.inf, 0.0, 0.0)
    rad = np.radians(dirs)[:, None]
    for s in speeds:
        wn, we = s * np.cos(rad), s * np.sin(rad)
        x = np.hypot(vn - wn, ve - we) / SPEED_SCALE
        pred = rest + beta[1] * x + beta[2] * x ** 2 + beta[3] * x ** 3
        sse = np.nansum((y - pred) ** 2, axis=1)
        k = int(np.argmin(sse))
        if sse[k] < best[0]:
            best = (sse[k], float(wn[k, 0]), float(we[k, 0]))
    return best


def estimate_wind(beta, flights):
    """Wind (north, east components of the air's motion, m/s) that best
    explains the power drawn on these flights, for the given model."""
    vn = np.concatenate([f.bins["vn"].to_numpy() for f in flights])
    ve = np.concatenate([f.bins["ve"].to_numpy() for f in flights])
    X = np.vstack([flight_design(f, (0.0, 0.0)) for f in flights])
    y = np.concatenate([f.bins["P"].to_numpy() for f in flights])
    rest = X[:, [0, 4, 5, 6, 7]] @ beta[[0, 4, 5, 6, 7]]

    _, wn, we = _wind_search(beta, vn, ve, rest, y, WIND_SPEEDS, WIND_DIRS)
    s0 = np.hypot(wn, we)
    d0 = np.degrees(np.arctan2(we, wn))
    speeds = np.clip(np.arange(s0 - 0.5, s0 + 0.51, 0.1), 0, None)
    dirs = np.arange(d0 - 10, d0 + 10.1, 2.0)
    _, wn, we = _wind_search(beta, vn, ve, rest, y, speeds, dirs)
    return (wn, we)


def fit_model(flights, with_wind=True):
    sessions = sorted({f.session for f in flights})
    winds = {s: (0.0, 0.0) for s in sessions}
    y = np.concatenate([f.bins["P"].to_numpy() for f in flights])

    for _ in range(WIND_ITERS if with_wind else 1):
        X = np.vstack([flight_design(f, winds[f.session]) for f in flights])
        beta = fit_power(X, y)
        if not with_wind:
            break
        for s in sessions:
            winds[s] = estimate_wind(beta, [f for f in flights if f.session == s])

    X = np.vstack([flight_design(f, winds[f.session]) for f in flights])
    beta = fit_power(X, y)
    va_max = float(np.nanmax(SPEED_SCALE * X[:, 1]))
    return {"beta": beta, "winds": winds, "va_max": va_max, "r2": r2(y, X @ beta)}


def predict_power(model, f, wind):
    X = flight_design(f, wind, model["va_max"])
    return np.clip(X @ model["beta"], 0, None)


def wind_from_text(w):
    s = np.hypot(*w)
    if s < 0.05:
        return "calm"
    frm = (np.degrees(np.arctan2(w[1], w[0])) + 180.0) % 360.0
    return f"from {frm:3.0f} deg at {s:4.1f} m/s"


def wind_vector(speed, from_deg):
    to = np.radians(from_deg + 180.0)
    return (speed * np.cos(to), speed * np.sin(to))


# ---------------------------------------------------------------------
# Site spec-sheet model (js/battery.js), for comparison
# ---------------------------------------------------------------------

def _airspeed_factor(v, spec):
    x = np.clip(np.asarray(v, float) / max(spec.vmax, 0.1), 0, 1.2)
    return 1 + spec.curve_a * x + spec.curve_b * x ** 3


def _spec_hover(spec):
    return spec.wh * 60.0 / spec.minutes / _airspeed_factor(spec.test_speed, spec)


def fit_site(flights, base=None, degree=1):
    """The site's own battery formula (js/battery.js) fitted directly to
    the logs: hover power, speed curve 1 + a*x + b*x^3 (x = ground speed /
    top speed; b >= 0) and climb cost from the power; descent stays the
    site's fixed 0.9 x hover. The battery energy (100% -> 0%) and the
    gauge slope (socSlope) come from the Wh-per-% curve. Returns a spec
    like SPEC_NEW, with the flight time that gives that hover power."""
    base = SimpleNamespace(**vars(base or SPEC_NEW))
    curve = fit_wh_curve(flights, None, degree)
    base.wh = float(energy_between(curve, 100, 0))
    mid = float(curve_whp(curve, 50))
    base.soc_slope = float(curve.coef[-2] / mid) if len(curve.coef) == 2 and mid > 0 else 0.0
    rows, ys, ws = [], [], []
    for f in flights:
        b = f.bins
        x = np.clip(np.hypot(b["vn"], b["ve"]).to_numpy() / base.vmax, 0, 1.2)
        up = b["up"].to_numpy()
        climb, desc = up > 0.3, up < -0.3
        cruise = ~(climb | desc)
        X = np.zeros((len(b), 4))
        X[cruise, 0], X[cruise, 1], X[cruise, 2] = 1.0, x[cruise], x[cruise] ** 3
        X[climb, 0], X[climb, 3] = 1.0, up[climb]
        X[desc, 0] = base.descent_factor
        rows.append(X)
        ys.append(b["P"].to_numpy())
        ws.append(np.sqrt(b["dur"].to_numpy()))
    X, y, w = np.vstack(rows), np.concatenate(ys), np.concatenate(ws)
    cols = [0, 1, 2, 3]
    theta = np.zeros(4)
    theta[cols] = lstsq(X[:, cols] * w[:, None], y * w)
    if theta[2] < 0:                       # keep power rising at high speed
        cols = [0, 1, 3]
        theta = np.zeros(4)
        theta[cols] = lstsq(X[:, cols] * w[:, None], y * w)
    hover, ha, hb, k = theta
    spec = SimpleNamespace(**vars(base))
    spec.curve_a, spec.curve_b = ha / hover, hb / hover
    spec.climb_eff = base.mass * 9.81 / k if k > 0 else 10.0
    spec.minutes = base.wh * 60.0 / (hover * _airspeed_factor(base.test_speed, spec))
    spec.hover = hover
    return spec


def spec_power(f, spec=SPEC):
    hover = _spec_hover(spec)
    b = f.bins
    cruise = hover * _airspeed_factor(np.hypot(b["vn"], b["ve"]), spec)
    climb = hover + spec.mass * 9.81 * b["up"].clip(lower=0) / spec.climb_eff
    return np.where(b["up"] > 0.3, climb,
                    np.where(b["up"] < -0.3, hover * spec.descent_factor, cruise))


# ---------------------------------------------------------------------
# Battery: Wh per %
# ---------------------------------------------------------------------

def wh_per_pct(flights, battery=None):
    """Energy per 1% of battery, from flights that used enough of it.
    Uses the same battery's flights when there are any."""
    use = [f for f in flights if f.soc_drop >= MIN_SOC_DROP_FOR_WH]
    same = [f for f in use if battery not in (None, "unknown") and f.battery == battery]
    pool = same or use
    if not pool:
        return np.nan, np.nan, "none"
    e = sum(f.energy_wh for f in pool)
    drop = sum(f.soc_drop for f in pool)
    secs = sum(f.duration_s for f in pool)
    return e / drop, drop / secs, ("same battery" if same else "all batteries")


def flight_weights(pool, target=None):
    """How much each flight counts, for battery ageing: full weight near the
    flight being predicted (or the battery's latest flight), half weight
    HALF_LIFE_FLIGHTS of that battery's flights away."""
    if HALF_LIFE_FLIGHTS <= 0:
        return {id(f): 1.0 for f in pool}
    latest = {}
    for f in pool:
        latest[f.battery] = max(latest.get(f.battery, 0), f.seq)
    out = {}
    for f in pool:
        if target is not None and target.battery == f.battery:
            ref = target.seq
        else:
            ref = latest[f.battery]
        out[id(f)] = 0.5 ** (abs(ref - f.seq) / HALF_LIFE_FLIGHTS)
    return out


def fit_wh_curve(flights, battery=None, degree=1, target=None):
    """Wh per 1% as a polynomial in the battery %, fitted to the 1% steps.
    Uses the battery's own steps when it has enough of them. Recent
    flights count more (ageing). When the logs carry the battery's own
    full-charge capacity, the curve is fitted per mAh of capacity and
    scaled to the capacity at `target` (or the battery's latest flight),
    so it follows the battery's ageing at once."""
    own = [f for f in flights if battery not in (None, "unknown") and f.battery == battery]
    pool, src = own, "same battery"
    if sum(len(f.steps) for f in own) < MIN_STEPS_PER_BATTERY:
        pool, src = flights, "all batteries"
    if sum(len(f.steps) for f in pool) < 10 * (degree + 1):
        whp, _, src = wh_per_pct(flights, battery)
        return SimpleNamespace(coef=np.array([whp]), lo=0.0, hi=100.0, n=0,
                               src=f"flat ({src}, too few 1% steps)", cap=np.nan)

    weights = flight_weights(pool, target)
    use_cap = USE_CAPACITY and all(np.isfinite(f.full_cap) for f in pool)
    cap_of = (lambda f: f.full_cap) if use_cap else (lambda f: 1.0)
    parts = []
    for f in pool:
        if len(f.steps):
            parts.append(f.steps.assign(fw=weights[id(f)], cap=cap_of(f)))
    st = pd.concat(parts, ignore_index=True)

    # Mid-point of each step: level L covers the charge from L down to L-1.
    x = st["level"].to_numpy() - 0.5 * st["drop"].to_numpy()
    y = (st["wh"] / st["drop"] / st["cap"]).to_numpy()
    w = (st["drop"] * st["fw"]).to_numpy()
    keep = np.ones(len(x), bool)
    for _ in range(2):   # drop stalled-gauge outliers, then refit
        coef = np.polyfit(x[keep], y[keep], degree, w=np.sqrt(w[keep]))
        res = y - np.polyval(coef, x)
        mad = 1.4826 * np.median(np.abs(res[keep] - np.median(res[keep])))
        keep = np.abs(res) <= 3.5 * max(mad, 1e-4)
    coef = np.polyfit(x[keep], y[keep], degree, w=np.sqrt(w[keep]))
    curve = SimpleNamespace(coef=coef, lo=float(x.min()), hi=float(x.max()),
                            n=int(keep.sum()), src=src, cap=np.nan)

    # The steps give the curve's shape, but not its level: dropping the
    # outliers removes the long steps where the gauge stalled and keeps
    # the quick ones where it catches up, which biases the steps low.
    # Scale the curve so it matches the energy of whole flights.
    whole = [f for f in pool if f.soc_drop >= MIN_SOC_DROP_FOR_WH]
    if whole:
        predicted = sum(weights[id(f)] * energy_between(curve, f.soc_start, f.soc_end)
                        for f in whole)
        actual = sum(weights[id(f)] * f.energy_wh / cap_of(f) for f in whole)
        curve.coef = coef * actual / predicted

    if use_cap:
        if target is not None and np.isfinite(target.full_cap):
            cap = target.full_cap
        else:
            ref = own if own else pool
            cap = max(ref, key=lambda f: (f.seq, f.name)).full_cap
        curve.coef = curve.coef * cap
        curve.cap = cap
        curve.src += f", scaled to {cap:.0f} mAh capacity"
    if HALF_LIFE_FLIGHTS > 0:
        curve.src += f", recent flights weighted (half-life {HALF_LIFE_FLIGHTS:g})"
    return curve


def curve_whp(curve, soc):
    """Wh per 1% at this battery %; never below a quarter of the mid value."""
    floor = 0.25 * np.polyval(curve.coef, 50.0)
    return np.maximum(np.polyval(curve.coef, np.asarray(soc, float)), floor)


def _curve_energy(curve):
    """Energy from 0% up to each SOC_GRID point (Wh), increasing."""
    whp = curve_whp(curve, SOC_GRID)
    step = SOC_GRID[1] - SOC_GRID[0]
    e = np.concatenate([[0.0], np.cumsum(0.5 * (whp[1:] + whp[:-1]) * step)])
    return e - np.interp(0.0, SOC_GRID, e)


def energy_between(curve, soc_hi, soc_lo):
    e = _curve_energy(curve)
    return np.interp(soc_hi, SOC_GRID, e) - np.interp(soc_lo, SOC_GRID, e)


def soc_after(curve, soc0, energy_wh):
    """Battery % left after drawing energy_wh (scalar or array) from soc0."""
    e = _curve_energy(curve)
    return np.interp(np.interp(soc0, SOC_GRID, e) - np.asarray(energy_wh, float), e, SOC_GRID)


# ---------------------------------------------------------------------
# Battery health over time
# ---------------------------------------------------------------------

def battery_health(flights, degree, spec_wh):
    """Each battery's usable energy over its logged flights, so ageing
    shows up, and a 'Battery health' figure for the site."""
    print()
    print("=" * 78)
    print("BATTERY HEALTH OVER TIME")
    print("=" * 78)
    print("Wh for 100% = energy used / battery % used x 100, from flights that")
    print(f"used at least {MIN_SOC_DROP_FOR_HEALTH:.0f}% (shorter ones are too coarse: the gauge "
          "moves in 1% steps).")
    out = {}
    for bat in sorted({f.battery for f in flights}):
        own = sorted((f for f in flights if f.battery == bat), key=lambda f: f.seq)
        print()
        print(f"battery {bat}: {len(own)} logged flight(s)")
        print(f"  {'#':>3s} {'started':16s} {'used %':>6s} {'Wh/100%':>8s} {'capacity':>9s} "
              f"{'cycles':>6s}")
        pts = []
        for f in own:
            wh100 = (100.0 * f.energy_wh / f.soc_drop
                     if f.soc_drop >= MIN_SOC_DROP_FOR_HEALTH else np.nan)
            when = f.start.strftime("%Y-%m-%d %H:%M") if not pd.isna(f.start) else "?"
            cap = f"{f.full_cap:7.0f}mAh" if np.isfinite(f.full_cap) else f"{'-':>9s}"
            cyc = f"{f.cycles:6.0f}" if np.isfinite(f.cycles) else f"{'-':>6s}"
            wtxt = f"{wh100:8.2f}" if np.isfinite(wh100) else f"{'-':>8s}"
            print(f"  {f.seq + 1:3d} {when:16s} {f.soc_drop:6.0f} {wtxt} {cap} {cyc}")
            if np.isfinite(wh100):
                pts.append((f.seq, wh100, f.soc_drop))

        curve = fit_wh_curve(flights, bat, degree)
        now = energy_between(curve, 100, 0)
        health = 100.0 * now / spec_wh
        if len(pts) >= 3 and pts[-1][0] - pts[0][0] >= 3:
            seq, wh, wt = (np.array(v, float) for v in zip(*pts))
            slope = np.polyfit(seq, wh, 1, w=np.sqrt(wt))[0]
            trend = f"{10 * slope:+.2f} Wh per 10 flights ({100 * 10 * slope / now:+.1f}%)"
        else:
            trend = "not enough flights yet to see a trend"
        caps = [f.full_cap for f in own if np.isfinite(f.full_cap)]
        if len(caps) >= 2:
            trend += f"; battery-reported capacity {caps[0]:.0f} -> {caps[-1]:.0f} mAh"
        print(f"  now: {now:.2f} Wh for 100% ({curve.src})")
        print(f"  trend: {trend}")
        print(f"  site 'Battery health' for this pack: about {min(health, 100):.0f}% "
              f"(of the preset's {spec_wh:g} Wh)")
        out[bat] = SimpleNamespace(now=now, health=health)
    return out


# ---------------------------------------------------------------------
# Leave-one-out
# ---------------------------------------------------------------------

def leave_one_out(flights, group, degree, long_min):
    key = (lambda f: f.session) if group == "day" else (lambda f: f.name)
    evals = [f for f in flights
             if f.soc_drop >= MIN_SOC_DROP_FOR_EVAL and f.duration_s >= MIN_EVAL_AIRBORNE_S]
    skipped = len(flights) - len(evals)

    print()
    print("=" * 78)
    print(f"LEAVE-ONE-OUT (leave out one {'day' if group == 'day' else 'flight'} at a time)")
    print("=" * 78)
    print(f"scored flights: {len(evals)} (skipped {skipped}: under "
          f"{MIN_EVAL_AIRBORNE_S:.0f} s airborne or under {MIN_SOC_DROP_FOR_EVAL:.0f}% used)")
    if not evals:
        return []

    results = []
    for f in evals:
        train = [g for g in flights if key(g) != key(f)]
        if not train:
            continue
        model = fit_model(train)
        site_fit = fit_site(train, degree=degree)
        whp, rate, whp_src = wh_per_pct(train, f.battery)
        if not np.isfinite(whp):
            continue
        curve = fit_wh_curve(train, f.battery, degree, target=f)
        dur = f.bins["dur"].to_numpy()
        same_day = model["winds"].get(f.session)
        own = estimate_wind(model["beta"], [f])

        power = {
            "site old": spec_power(f, SPEC),
            "site 27": spec_power(f, SPEC_27),
            "site new": spec_power(f, SPEC_NEW),
            "site fit": spec_power(f, site_fit),
            "no wind": predict_power(model, f, (0.0, 0.0)),
            "same day": predict_power(model, f, same_day or (0.0, 0.0)),
            "own wind": predict_power(model, f, own),
        }
        drop = {
            "naive": rate * f.duration_s,
            "site old": np.sum(power["site old"] * dur) / 3600.0 / SPEC.wh * 100.0,
            "site 27": np.sum(power["site 27"] * dur) / 3600.0 / SPEC_27.wh * 100.0,
            "site new": site_gauge_used(
                SPEC_NEW, np.sum(power["site new"] * dur) / 3600.0 / SPEC_NEW.wh * 100.0,
                f.soc_start),
            "site fit": site_gauge_used(
                site_fit, np.sum(power["site fit"] * dur) / 3600.0 / site_fit.wh * 100.0,
                f.soc_start),
            "E/% flat": f.energy_wh / whp,
            "E/% curve": f.soc_start - soc_after(curve, f.soc_start, f.energy_wh),
        }
        for m in ("no wind", "same day", "own wind"):
            e = np.sum(power[m] * dur) / 3600.0
            drop[m] = f.soc_start - soc_after(curve, f.soc_start, e)

        y = f.bins["P"].to_numpy()
        res = SimpleNamespace(
            flight=f, whp=whp, whp_src=whp_src, curve=curve, drop=drop,
            has_same_day=same_day is not None,
            own_wind=own, same_day_wind=same_day,
            r2={m: r2(y, p) for m, p in power.items()},
            soc_pred=soc_after(curve, f.soc_start,
                               np.cumsum(power["same day"] * dur) / 3600.0),
        )
        results.append(res)

    _print_loo(results, long_min)
    return results


def _endurance_min(soc_start, drop, duration_s):
    """Minutes from soc_start to 0% at this flight's average rate."""
    if not (drop > 0):
        return np.nan
    return soc_start * duration_s / drop / 60.0


def _print_summary(results, title, legend=False):
    print()
    print(f"summary, {title} ({len(results)} flights) - each flight's predicted")
    print("battery use vs the actual one:")
    if legend:
        print("  R2       across flights (1 = perfect, 0 = no better than the average)")
        print("  MAE      average miss, in % of a full battery (80% predicted, 78% used")
        print("           = a 2% miss)")
        print("  RMSE     the same, weighting big misses more")
        print("  bias     average signed miss (+ = predicts more use than happened)")
        print("  MAE rel  average miss as a share of the battery that flight used")
        print("  endur.   miss in minutes on time to 0%, at the flight's average rate")
    print(f"  {'method':10s} {'R2':>6s} {'MAE %':>7s} {'RMSE %':>7s} {'bias %':>7s} "
          f"{'MAE rel':>8s} {'endur.':>8s}")
    for m in METHODS:
        err = np.array([r.drop[m] - r.flight.soc_drop for r in results])
        rel = np.array([abs(r.drop[m] - r.flight.soc_drop) / r.flight.soc_drop for r in results])
        end_err = np.array([
            _endurance_min(r.flight.soc_start, r.drop[m], r.flight.duration_s)
            - _endurance_min(r.flight.soc_start, r.flight.soc_drop, r.flight.duration_s)
            for r in results])
        actual = np.array([r.flight.soc_drop for r in results])
        flights_r2 = r2(actual, actual + err)
        print(f"  {m:10s} {flights_r2:6.3f} {np.mean(np.abs(err)):7.2f} "
              f"{np.sqrt(np.mean(err ** 2)):7.2f} {np.mean(err):+7.2f} "
              f"{100 * np.mean(rel):7.1f}% {np.nanmean(np.abs(end_err)):6.1f} m")


def _print_loo(results, long_min):
    print()
    print("battery % used in the flight: actual vs predicted")
    hdr = f"  {'flight':38s} {'bat':>6s} {'min':>5s} {'actual':>6s}"
    for m in METHODS:
        hdr += f" {m:>9s}"
    print(hdr)
    for r in results:
        f = r.flight
        line = (f"  {f.name[:38]:38s} {f.battery[-6:]:>6s} "
                f"{f.duration_s / 60:5.1f} {f.soc_drop:6.0f}")
        for m in METHODS:
            mark = "*" if m == "same day" and not r.has_same_day else " "
            line += f" {r.drop[m]:8.1f}{mark}"
        print(line)
    print("  * no other flight that day - wind taken as calm")

    _print_summary(results, "all scored flights", legend=True)
    long_ = [r for r in results if r.flight.soc_drop >= long_min]
    if len(long_) >= 3:
        _print_summary(long_, f"long flights only (used {long_min:.0f}% or more)")
    else:
        print()
        print(f"only {len(long_)} flight(s) used {long_min:.0f}% or more - too few for a "
              f"score of their own (try --long-min)")
    print()
    print("  'E/% flat' and 'E/% curve' use the flight's TRUE energy, so their")
    print("  error is only the Wh-per-% conversion (fixed value vs the curve by")
    print("  battery %). The model methods all use the curve.")


# ---------------------------------------------------------------------
# Whole-data report
# ---------------------------------------------------------------------

def report_full_model(flights, model, degree):
    print()
    print("=" * 78)
    print("POWER MODEL (all flights)")
    print("=" * 78)
    n = sum(len(f.bins) for f in flights)
    print(f"1-second samples: {n}   power R2: {model['r2']:.3f}")
    print("coefficients (W; airspeed in units of 10 m/s):")
    for name, c in zip(FEATURES, model["beta"]):
        print(f"  {name:20s} {c:9.3f}")

    print()
    print("level flight power vs airspeed (model / site old / site new):")
    for v in (0, 3, 6, 9, 12):
        if v > model["va_max"] + 0.5:
            break
        p = design([v], [0], [0], [0], [0], (0, 0)) @ model["beta"]
        po = _spec_hover(SPEC) * _airspeed_factor(v, SPEC)
        pn = _spec_hover(SPEC_NEW) * _airspeed_factor(v, SPEC_NEW)
        print(f"  {v:4.0f} m/s: {p[0]:6.1f} W / {po:6.1f} W / {pn:6.1f} W")
    print(f"  (highest airspeed in the data: {model['va_max']:.1f} m/s)")

    fit = fit_site(flights, degree=degree)
    print()
    print("site preset fitted to all these flights (the site's own formula):")
    print(f"  hover {fit.hover:.1f} W   curve a={fit.curve_a:.3f} b={fit.curve_b:.3f}   "
          f"climb efficiency {fit.climb_eff:.2f}   battery {fit.wh:.2f} Wh, "
          f"socSlope {fit.soc_slope:.4f}")
    print(f"  -> js/drone.js: batt: {fit.wh:.1f}, ftime: {fit.minutes:.1f}, "
          f"power: {{ curve: {{ a: {fit.curve_a:.2f}, b: {fit.curve_b:.2f} }}, "
          f"climbEff: {fit.climb_eff:.2f}, socSlope: {fit.soc_slope:.4f} }}")
    print("  level flight power, this fit / current site preset:")
    for v in (0, 3, 6, 9):
        pf = _spec_hover(fit) * _airspeed_factor(v, fit)
        pn = _spec_hover(SPEC_NEW) * _airspeed_factor(v, SPEC_NEW)
        print(f"    {v:2d} m/s: {pf:5.1f} W / {pn:5.1f} W")

    print()
    print("estimated wind per day (from the power data; check against a")
    print("weather station before trusting it):")
    for s, w in sorted(model["winds"].items()):
        print(f"  {s}: {wind_from_text(w)}")

    print()
    print("=" * 78)
    print("BATTERY: energy per 1% of charge")
    print("=" * 78)
    print(f"  {'flight':38s} {'battery':>12s} {'temp':>5s} {'min':>5s} "
          f"{'start':>5s} {'used %':>6s} {'Wh':>6s} {'Wh/%':>6s}")
    for f in flights:
        whp = f.energy_wh / f.soc_drop if f.soc_drop >= MIN_SOC_DROP_FOR_WH else np.nan
        temp = f"{f.temp:5.1f}" if np.isfinite(f.temp) else f"{'-':>5s}"
        print(f"  {f.name[:38]:38s} {f.battery[-12:]:>12s} {temp} "
              f"{f.duration_s / 60:5.1f} {f.soc_start:5.0f} {f.soc_drop:6.0f} "
              f"{f.energy_wh:6.2f} {whp:6.3f}")

    batteries = sorted({f.battery for f in flights})
    curves = {"all": fit_wh_curve(flights, None, degree)}
    for bat in batteries:
        c = fit_wh_curve(flights, bat, degree)
        if c.src == "same battery":
            curves[bat[-6:]] = c

    print()
    print("Wh per 1% by battery % - measured from every whole 1% step in the")
    print("logs, and the fitted curve(s):")
    steps = pd.concat([f.steps for f in flights if len(f.steps)], ignore_index=True) \
        if any(len(f.steps) for f in flights) else pd.DataFrame(columns=["level", "wh", "drop"])
    hdr = f"  {'battery %':>9s} {'steps':>6s} {'measured':>9s}"
    for k in curves:
        hdr += f" {'curve ' + k:>13s}"
    print(hdr)
    for top in range(100, 0, -10):
        g = steps[(steps["level"] <= top) & (steps["level"] > top - 10)]
        meas = g["wh"].sum() / g["drop"].sum() if len(g) else np.nan
        line = f"  {top - 10:3d}-{top:<3d}   {len(g):6d} {meas:9.4f}"
        for c in curves.values():
            line += f" {float(curve_whp(c, top - 5)):13.4f}"
        print(line)
    for k, c in curves.items():
        note = f", measured between {c.lo:.0f}% and {c.hi:.0f}%" if c.n else ""
        print(f"  curve {k}: {c.n} steps ({c.src}{note}); "
              f"100->0%: {energy_between(c, 100, 0):.2f} Wh, "
              f"100->20%: {energy_between(c, 100, 20):.2f} Wh  (spec {SPEC.wh} Wh)")
    lo = curves["all"].lo
    if curves["all"].n and lo > 5:
        print(f"  [note] below {lo:.0f}% the curve is extrapolated - no logged flight "
              f"went that low")


# ---------------------------------------------------------------------
# Wind effects: battery and drift
# ---------------------------------------------------------------------

HOVER_MAX_SPEED = 0.3     # m/s ground speed, to count as holding position
HOVER_MAX_CLIMB = 0.2     # m/s vertical
HOVER_MIN_S = 5.0         # shortest hover worth measuring


def _rolling_max(x, n):
    """Largest mean of n consecutive values, and where its window starts."""
    if len(x) < n:
        return float(np.mean(x)) if len(x) else np.nan, 0
    m = np.convolve(x, np.ones(n) / n, mode="valid")
    k = int(np.argmax(m))
    return float(m[k]), k


def hover_drift(f):
    """Hover stretches (holding position for 5 s or more) and how far the
    drone wandered from where each one started, from its GPS position.
    GPS itself wanders by a metre or two, so small values are noise."""
    b = f.bins
    lat, lon = b["lat"].to_numpy(), b["lon"].to_numpy()
    if not (np.isfinite(lat).sum() > 10 and np.nanmax(np.abs(lat)) > 1):
        return []
    still = ((np.hypot(b["vn"], b["ve"]) < HOVER_MAX_SPEED)
             & (b["up"].abs() < HOVER_MAX_CLIMB)).to_numpy()
    t = np.cumsum(b["dur"].to_numpy())
    out, i = [], 0
    while i < len(still):
        if not still[i]:
            i += 1
            continue
        j = i
        while j + 1 < len(still) and still[j + 1]:
            j += 1
        seg = slice(i, j + 1)
        length = t[j] - t[i] + b["dur"].iloc[i]
        if length >= HOVER_MIN_S and np.isfinite(lat[i]) and np.isfinite(lon[i]):
            dn = (lat[seg] - lat[i]) * 111320.0
            de = (lon[seg] - lon[i]) * 111320.0 * np.cos(np.radians(lat[i]))
            d = np.hypot(dn, de)
            out.append(SimpleNamespace(start_min=t[i] / 60.0, length_s=length,
                                       max_m=float(np.nanmax(d)),
                                       end_m=float(d[np.isfinite(d)][-1])))
        i = j + 1
    return out


def wind_report(flights, model, degree):
    """How much battery the wind cost each flight, its single worst
    moment, and how far the drone drifted while hovering."""
    print()
    print("=" * 78)
    print("WIND EFFECTS")
    print("=" * 78)
    print("battery: the same flight (same ground track) predicted with the wind")
    print("and in calm air - the difference is what the wind cost. 'day' uses")
    print("the wind estimated for that day, 'own' the wind fitted to that flight")
    print("alone (noisier). 'peak' is the worst 10 s: the most extra power the")
    print("wind demanded, and when.")
    print()
    print(f"  {'flight':38s} {'wind (day)':>22s} {'+% day':>7s} {'+% own':>7s} "
          f"{'+Wh':>6s} {'share':>6s} {'peak W':>7s} {'at min':>6s}")
    rows = []
    for f in flights:
        dur = f.bins["dur"].to_numpy()
        if dur.sum() < 30:
            continue
        w_day = model["winds"].get(f.session, (0.0, 0.0))
        w_own = estimate_wind(model["beta"], [f])
        calm = predict_power(model, f, (0.0, 0.0))
        e_calm = np.sum(calm * dur) / 3600.0
        curve = fit_wh_curve(flights, f.battery, degree, target=f)
        soc0 = f.soc_start if np.isfinite(f.soc_start) else 100.0

        def extra_pct(w):
            e = np.sum(predict_power(model, f, w) * dur) / 3600.0
            used = lambda energy: soc0 - soc_after(curve, soc0, energy)  # noqa: E731
            return used(e) - used(e_calm), e - e_calm

        pct_day, wh_day = extra_pct(w_day)
        pct_own, _ = extra_pct(w_own)
        extra_w = predict_power(model, f, w_day) - calm
        peak, k = _rolling_max(extra_w, 10)
        at_min = np.cumsum(dur)[k] / 60.0 if len(dur) else np.nan
        share = 100.0 * wh_day / e_calm if e_calm > 0 else np.nan
        rows.append(SimpleNamespace(f=f, pct_day=pct_day, pct_own=pct_own,
                                    wh=wh_day, peak=peak, wind=w_day,
                                    per_min=pct_day / (dur.sum() / 60.0)))
        print(f"  {f.name[:38]:38s} {wind_from_text(w_day):>22s} {pct_day:+7.1f} "
              f"{pct_own:+7.1f} {wh_day:+6.2f} {share:+5.1f}% {peak:+7.1f} {at_min:6.1f}")

    if rows:
        worst = max(rows, key=lambda r: r.pct_day)
        peak = max(rows, key=lambda r: r.peak)
        print()
        print(f"  most battery lost to wind: {worst.f.name} - {worst.pct_day:+.1f}% "
              f"of the battery ({worst.per_min:+.2f}% per minute)")
        print(f"  hardest moment: {peak.f.name} - {peak.peak:+.1f} W extra for 10 s")

    print()
    print("drift: hover stretches (ground speed under 0.3 m/s for 5 s or more)")
    print("and how far the drone moved from where each began, by GPS. GPS")
    print("wanders 1-2 m on its own. 'air' is how far the day's wind carries")
    print("the air in one minute - how far the drone would go if it stopped")
    print("holding position.")
    print()
    print(f"  {'flight':38s} {'hovers':>6s} {'secs':>5s} {'median m':>9s} "
          f"{'max m':>6s} {'at min':>6s} {'air m/min':>9s}")
    drift_rows = []
    for f in flights:
        hv = hover_drift(f)
        w = model["winds"].get(f.session, (0.0, 0.0))
        air = np.hypot(*w) * 60.0
        if not hv:
            print(f"  {f.name[:38]:38s} {'-':>6s} {'':>5s} {'':>9s} {'':>6s} {'':>6s} {air:9.0f}")
            continue
        top = max(hv, key=lambda h: h.max_m)
        med = float(np.median([h.max_m for h in hv]))
        secs = sum(h.length_s for h in hv)
        drift_rows.append(SimpleNamespace(f=f, top=top, med=med, wind=np.hypot(*w)))
        print(f"  {f.name[:38]:38s} {len(hv):6d} {secs:5.0f} {med:9.1f} "
              f"{top.max_m:6.1f} {top.start_min:6.1f} {air:9.0f}")

    if drift_rows:
        worst = max(drift_rows, key=lambda r: r.top.max_m)
        print()
        print(f"  largest hover drift: {worst.f.name} - {worst.top.max_m:.1f} m over "
              f"{worst.top.length_s:.0f} s, starting at minute {worst.top.start_min:.1f}")

    # By day: does a windier day mean more battery and more drift?
    days = sorted({r.f.session for r in rows})
    if days:
        print()
        print("by day:")
        print(f"  {'day':10s} {'wind':>22s} {'battery %/min':>14s} {'median drift m':>15s}")
        for d in days:
            rr = [r for r in rows if r.f.session == d]
            dd = [r.med for r in drift_rows if r.f.session == d]
            drift = f"{np.median(dd):15.1f}" if dd else f"{'-':>15s}"
            print(f"  {d:10s} {wind_from_text(rr[0].wind):>22s} "
                  f"{np.mean([r.per_min for r in rr]):+14.2f} {drift}")
    print()
    print("  The wind here is estimated from the power data, not measured. On")
    print("  days with little wind both effects are small and mostly noise.")
    return rows, drift_rows


MOVING_MIN_SPEED = 1.0    # m/s ground speed: below this, the wind is all push


def wind_integrals(flights, model, degree):
    """The wind's effect summed over each whole flight, as curves over
    time and as totals, and the flight where each total is largest.

    battery: extra % used versus the same ground track in calm air.
    drift:   how far the wind would have carried the drone had it not
             held its track - the integral of the wind over time (m),
             split into the part across the track (sideways push), the
             part along it (head- or tailwind), and the part while
             hovering. The drone cancels all of it; that cancelling is
             what costs the battery.
    """
    print()
    print("=" * 78)
    print("WIND EFFECTS OVER WHOLE FLIGHTS (integrals)")
    print("=" * 78)
    print("battery: extra % the wind cost, summed over the flight.")
    print("drift: how far the wind would have carried the drone over the flight")
    print("had it not fought back (m): 'total' = all of it, 'side' = across the")
    print("direction of travel, 'head' = against it (minus = tailwind), 'hover'")
    print("= while holding position. Uses the wind estimated for each day.")
    print()
    print(f"  {'flight':38s} {'min':>5s} {'wind m/s':>8s} {'+bat %':>7s} "
          f"{'total m':>8s} {'side m':>7s} {'head m':>7s} {'hover m':>7s}")
    out = []
    for f in flights:
        b = f.bins
        dur = b["dur"].to_numpy()
        if dur.sum() < 30:
            continue
        w = np.array(model["winds"].get(f.session, (0.0, 0.0)))
        vn, ve = b["vn"].to_numpy(), b["ve"].to_numpy()
        gs = np.hypot(vn, ve)
        moving = gs >= MOVING_MIN_SPEED
        tn = np.where(moving, vn / np.maximum(gs, 1e-9), 0.0)
        te = np.where(moving, ve / np.maximum(gs, 1e-9), 0.0)
        along = w[0] * tn + w[1] * te              # + = wind from behind
        side = np.abs(w[0] * te - w[1] * tn)
        ws = float(np.hypot(*w))

        total_m = np.cumsum(ws * dur)
        side_m = np.cumsum(np.where(moving, side, 0.0) * dur)
        head_m = np.cumsum(np.where(moving, -along, 0.0) * dur)
        hover_m = np.cumsum(np.where(moving, 0.0, ws) * dur)

        curve = fit_wh_curve(flights, f.battery, degree, target=f)
        soc0 = f.soc_start if np.isfinite(f.soc_start) else 100.0
        e_wind = np.cumsum(predict_power(model, f, tuple(w)) * dur) / 3600.0
        e_calm = np.cumsum(predict_power(model, f, (0.0, 0.0)) * dur) / 3600.0
        extra_pct = soc_after(curve, soc0, e_calm) - soc_after(curve, soc0, e_wind)

        r = SimpleNamespace(f=f, t_min=np.cumsum(dur) / 60.0, wind=ws,
                            bat=extra_pct, total=total_m, side=side_m,
                            head=head_m, hover=hover_m)
        out.append(r)
        print(f"  {f.name[:38]:38s} {r.t_min[-1]:5.1f} {ws:8.1f} {extra_pct[-1]:+7.1f} "
              f"{total_m[-1]:8.0f} {side_m[-1]:7.0f} {head_m[-1]:+7.0f} {hover_m[-1]:7.0f}")

    if not out:
        return out
    print()
    print("largest over a whole flight:")
    for label, key, unit in (("battery lost to wind", "bat", "%"),
                             ("total wind drift", "total", " m"),
                             ("sideways push", "side", " m"),
                             ("headwind", "head", " m")):
        r = max(out, key=lambda x: getattr(x, key)[-1])
        v = getattr(r, key)[-1]
        fmt = f"{v:+.1f}" if unit == "%" else f"{v:.0f}"
        print(f"  {label:22s} {r.f.name}  {fmt}{unit}  "
              f"({r.t_min[-1]:.1f} min, wind {r.wind:.1f} m/s)")
    longest = max(out, key=lambda x: x.t_min[-1])
    print(f"  {'longest flight':22s} {longest.f.name}  {longest.t_min[-1]:.1f} min, "
          f"wind cost {longest.bat[-1]:+.1f}%, drift {longest.total[-1]:.0f} m")
    print()
    print("  These drift distances are what the drone had to cancel, not how far")
    print("  it actually moved: it held its track. The measured drift is in the")
    print("  hover table above.")
    return out


def save_wind_plots(out_dir, integrals):
    if not integrals:
        return
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    os.makedirs(out_dir, exist_ok=True)
    top_bat = max(integrals, key=lambda r: r.bat[-1])
    top_drift = max(integrals, key=lambda r: r.total[-1])
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 4.5))
    for r in integrals:
        ax1.plot(r.t_min, r.bat, color="grey", alpha=0.35, linewidth=1)
        ax2.plot(r.t_min, r.total, color="grey", alpha=0.35, linewidth=1)
    ax1.plot(top_bat.t_min, top_bat.bat, linewidth=2.2,
             label=f"most: {top_bat.f.name[-26:]}")
    ax2.plot(top_drift.t_min, top_drift.total, linewidth=2.2,
             label=f"most: {top_drift.f.name[-26:]} (total)")
    ax2.plot(top_drift.t_min, top_drift.side, linewidth=1.5, linestyle="--",
             label="same flight, sideways")
    ax1.axhline(0, color="black", linewidth=0.8)
    ax1.set_xlabel("minutes into the flight")
    ax1.set_ylabel("extra battery % from wind (cumulative)")
    ax1.set_title("Battery the wind cost, over each flight")
    ax2.set_xlabel("minutes into the flight")
    ax2.set_ylabel("wind drift cancelled (m, cumulative)")
    ax2.set_title("How far the wind would have carried the drone")
    ax1.legend(fontsize=8)
    ax2.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, "wind_integrals.png"), dpi=120)
    plt.close(fig)


# ---------------------------------------------------------------------
# Route prediction
# ---------------------------------------------------------------------

def read_route(path, default_speed):
    r = pd.read_csv(path)
    r.columns = [c.strip().lower() for c in r.columns]

    def col(*names):
        for n in names:
            if n in r.columns:
                return pd.to_numeric(r[n], errors="coerce").to_numpy(float)
        return None

    lat, lon = col("lat", "latitude"), col("lon", "lng", "longitude")
    north, east = col("north_m", "north"), col("east_m", "east")
    alt = col("alt", "alt_m", "height", "height_m")
    if alt is None:
        sys.exit("[error] route needs an alt column (m above takeoff)")
    if lat is not None and lon is not None:
        north = (lat - lat[0]) * 111320.0
        east = (lon - lon[0]) * 111320.0 * np.cos(np.radians(lat[0]))
    elif north is None or east is None:
        sys.exit("[error] route needs lat,lon or north_m,east_m columns")
    speed = col("speed", "speed_mps")
    hover = col("hover_s", "hover")
    n = len(alt)
    speed = np.where(np.isfinite(speed), speed, default_speed) if speed is not None else np.full(n, default_speed)
    hover = np.nan_to_num(hover) if hover is not None else np.zeros(n)
    return north, east, alt, speed, hover


def simulate_route(route, climb, descent, accel, yaw_rate, step=0.5):
    """Time steps (dur, vn, ve, up, acc, yawr, leg) for flying the route."""
    north, east, alt, speed, hover = route
    rows = []

    def emit(T, speed_at, heading, up, acc_at, yawr, leg):
        if T <= 0:
            return
        k = max(1, int(np.ceil(T / step)))
        for i in range(k):
            dt = T / k
            tm = (i + 0.5) * dt
            s = speed_at(tm)
            rows.append((dt, s * np.cos(heading), s * np.sin(heading), up,
                         acc_at(tm), yawr, leg))

    zero = lambda _t: 0.0  # noqa: E731
    emit(max(alt[0], 0) / climb, zero, 0.0, climb, zero, 0.0, 0)
    prev_heading = None
    for i in range(len(alt) - 1):
        dn, de, dz = north[i + 1] - north[i], east[i + 1] - east[i], alt[i + 1] - alt[i]
        d = float(np.hypot(dn, de))
        heading = float(np.arctan2(de, dn)) if d > 0.5 else (prev_heading or 0.0)
        emit(hover[i], zero, heading, 0.0, zero, 0.0, i + 1)
        if prev_heading is not None and d > 0.5:
            turn = abs((np.degrees(heading - prev_heading) + 180) % 360 - 180)
            if turn > 5:
                emit(turn / yaw_rate, zero, heading, 0.0, zero, yaw_rate, i + 1)
        v = max(float(speed[i]), 0.1)
        tv = abs(dz) / (climb if dz > 0 else descent)
        if d <= 0.5:
            th = 0.0
        elif d >= v * v / accel:
            th = d / v + v / accel
        else:
            th = 2 * np.sqrt(d / accel)
        if d <= 0.5:
            emit(tv, zero, heading, dz / tv if tv > 0 else 0.0, zero, 0.0, i + 1)
        elif tv >= th:
            # Height change sets the pace: slow, steady horizontal speed.
            emit(tv, lambda _t, s=d / tv: s, heading, dz / tv, zero, 0.0, i + 1)
        else:
            vp = min(v, np.sqrt(d * accel))
            ta = vp / accel
            tc = max(th - 2 * ta, 0.0)
            up = dz / th
            emit(ta, lambda t: accel * t, heading, up, lambda _t: accel, 0.0, i + 1)
            emit(tc, lambda _t, s=vp: s, heading, up, zero, 0.0, i + 1)
            emit(ta, lambda t, s=vp: s - accel * t, heading, up, lambda _t: accel, 0.0, i + 1)
        if d > 0.5:
            prev_heading = heading
    emit(hover[-1], zero, prev_heading or 0.0, 0.0, zero, 0.0, len(alt))
    emit(max(alt[-1], 0) / descent, zero, 0.0, -descent, zero, 0.0, len(alt))

    return pd.DataFrame(rows, columns=["dur", "vn", "ve", "up", "acc", "yawr", "leg"])


def route_report(model, flights, args, loo_results):
    route = read_route(args.route, args.speed)
    sim = simulate_route(route, args.climb_speed, args.descent_speed,
                         args.accel, args.yaw_rate)
    whp, _, _ = wh_per_pct(flights, args.battery)
    if not np.isfinite(whp):
        sys.exit("[error] no flight used enough battery to measure Wh per %")
    curve = fit_wh_curve(flights, args.battery, args.curve_degree)

    if args.wind_day:
        if args.wind_day not in model["winds"]:
            sys.exit(f"[error] no logged day {args.wind_day}")
        wind = model["winds"][args.wind_day]
    else:
        wind = wind_vector(args.wind_speed, args.wind_from)

    def run(w):
        X = design(sim["vn"], sim["ve"], sim["up"], sim["acc"], sim["yawr"], w, model["va_max"])
        p = np.clip(X @ model["beta"], 0, None)
        t = np.cumsum(sim["dur"].to_numpy())
        soc = soc_after(curve, args.soc, np.cumsum(p * sim["dur"].to_numpy()) / 3600.0)
        return t, soc, p

    t, soc, p = run(wind)

    print()
    print("=" * 78)
    print(f"ROUTE: {args.route}")
    print("=" * 78)
    north, east, alt, _, _ = route
    dist = np.sum(np.hypot(np.diff(north), np.diff(east)))
    print(f"waypoints: {len(alt)}   horizontal distance: {dist:.0f} m   "
          f"flight time: {t[-1] / 60:.1f} min")
    print(f"wind: {wind_from_text(wind)}   battery: {args.battery or 'all'} "
          f"(Wh/% curve: {curve.src})   start: {args.soc:.0f}%")
    if model["va_max"] < np.max(np.hypot(sim["vn"] - wind[0], sim["ve"] - wind[1])):
        print(f"[warn] the route needs airspeeds above the {model['va_max']:.1f} m/s "
              f"seen in the logs; power there is extrapolated")

    print()
    print(f"  {'leg':>4s} {'end min':>8s} {'battery %':>10s}")
    legs = sim["leg"].to_numpy()
    for leg in np.unique(legs):
        k = np.where(legs == leg)[0][-1]
        name = "up" if leg == 0 else ("down" if leg == len(alt) else f"{leg}")
        print(f"  {name:>4s} {t[k] / 60:8.1f} {soc[k]:10.1f}")

    used = args.soc - soc[-1]
    mean_w = np.sum(p * sim["dur"]) / t[-1]
    print()
    print(f"battery used: {used:.1f}%   left on landing: {soc[-1]:.1f}%   "
          f"average power: {mean_w:.1f} W")

    rel = None
    if loo_results:
        rel = np.mean([abs(r.drop["same day"] - r.flight.soc_drop) / r.flight.soc_drop
                       for r in loo_results])
        print(f"leave-one-out typical error: +/-{100 * rel:.0f}% of the battery used "
              f"(+/-{rel * used:.1f} points here)")

    for level, label in ((args.reserve, f"reserve ({args.reserve:.0f}%)"), (0.0, "empty")):
        hit = np.where(soc <= level)[0]
        if len(hit):
            k = hit[0]
            print(f"reaches {label} at {t[k] / 60:.1f} min, on leg "
                  f"{'up' if legs[k] == 0 else legs[k]} - ROUTE NOT FLYABLE")
        else:
            extra = energy_between(curve, soc[-1], level) * 3600.0 / mean_w
            print(f"{label}: not reached; at this route's average power it would be "
                  f"reached after {(t[-1] + extra) / 60:.1f} min in total")

    if np.hypot(*wind) > 0.05:
        _, soc0, _ = run((0.0, 0.0))
        print(f"(in calm air the route would use {args.soc - soc0[-1]:.1f}%)")
    return t, soc


# ---------------------------------------------------------------------
# Plots
# ---------------------------------------------------------------------

def save_plots(out_dir, loo_results, route_curve, reserve, flights, curve):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    os.makedirs(out_dir, exist_ok=True)

    steps = [f.steps.assign(battery=f.battery) for f in flights if len(f.steps)]
    if steps:
        st = pd.concat(steps, ignore_index=True)
        fig, ax = plt.subplots(figsize=(8, 4.5))
        for bat, g in st.groupby("battery"):
            ax.scatter(g["level"] - 0.5 * g["drop"], g["wh"] / g["drop"],
                       s=8, alpha=0.35, label=f"1% steps, battery {bat[-6:]}")
        x = np.linspace(0, 100, 101)
        ax.plot(x, curve_whp(curve, x), color="black", label="fitted curve")
        ax.axvspan(0, curve.lo, color="grey", alpha=0.15, label="extrapolated")
        ax.set_xlabel("battery %")
        ax.set_ylabel("Wh per 1%")
        ax.set_title("Energy in each 1% of the charge level")
        ax.legend(fontsize=8)
        fig.tight_layout()
        fig.savefig(os.path.join(out_dir, "wh_per_pct.png"), dpi=120)
        plt.close(fig)
    if loo_results:
        fig, ax = plt.subplots(figsize=(6.5, 6))
        actual = [r.flight.soc_drop for r in loo_results]
        for m in ("naive", "site old", "site new", "site fit", "no wind"):
            ax.scatter(actual, [r.drop[m] for r in loo_results], label=m, s=22)
        top = max(actual + [r.drop[m] for r in loo_results for m in METHODS]) * 1.05
        ax.plot([0, top], [0, top], color="black", linewidth=0.8)
        ax.set_xlabel("actual battery used (%)")
        ax.set_ylabel("predicted battery used (%)")
        ax.set_title("Leave-one-out: battery used per flight")
        ax.legend()
        fig.tight_layout()
        fig.savefig(os.path.join(out_dir, "loo_used.png"), dpi=120)
        plt.close(fig)

        n = len(loo_results)
        cols = min(4, n)
        rows = int(np.ceil(n / cols))
        fig, axes = plt.subplots(rows, cols, figsize=(4 * cols, 3 * rows), squeeze=False)
        for ax, r in zip(axes.flat, loo_results):
            t = np.cumsum(r.flight.bins["dur"].to_numpy()) / 60.0
            ax.plot(t, r.flight.bins["soc"], label="actual")
            ax.plot(t, r.soc_pred, label="predicted")
            ax.set_title(r.flight.name[-26:], fontsize=8)
            ax.set_xlabel("min")
        for ax in list(axes.flat)[n:]:
            ax.axis("off")
        axes.flat[0].legend(fontsize=8)
        fig.tight_layout()
        fig.savefig(os.path.join(out_dir, "loo_soc_traces.png"), dpi=110)
        plt.close(fig)

    if route_curve is not None:
        t, soc = route_curve
        fig, ax = plt.subplots(figsize=(8, 4.5))
        ax.plot(t / 60.0, soc)
        ax.axhline(reserve, color="orange", linestyle="--", label="reserve")
        ax.axhline(0, color="red", linewidth=0.8)
        ax.set_xlabel("minutes")
        ax.set_ylabel("battery %")
        ax.set_title("Predicted battery along the route")
        ax.legend()
        fig.tight_layout()
        fig.savefig(os.path.join(out_dir, "route_battery.png"), dpi=120)
        plt.close(fig)
    print(f"plots saved in {out_dir}")


# ---------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("path", nargs="?", default=DEFAULT_PATH, help="folder of DJI CSVs")
    p.add_argument("--battery-map", help="CSV file,battery for logs without a serial")
    p.add_argument("--loo", choices=["flight", "day", "off"], default="flight",
                   help="leave out one flight (default) or one whole day at a time")
    p.add_argument("--route", help="route CSV to predict")
    p.add_argument("--soc", type=float, default=100.0, help="battery %% at takeoff")
    p.add_argument("--reserve", type=float, default=20.0, help="reserve %% to warn at")
    p.add_argument("--battery", help="battery id for the route (default: all)")
    p.add_argument("--speed", type=float, default=6.0, help="ground speed m/s")
    p.add_argument("--climb-speed", type=float, default=2.0)
    p.add_argument("--descent-speed", type=float, default=2.0)
    p.add_argument("--accel", type=float, default=2.0, help="m/s^2 at leg ends")
    p.add_argument("--yaw-rate", type=float, default=60.0, help="deg/s when turning")
    p.add_argument("--wind-speed", type=float, default=0.0, help="m/s")
    p.add_argument("--wind-from", type=float, default=0.0, help="deg, where it blows from")
    p.add_argument("--wind-day", help="use the wind estimated for this logged day (YYYY-MM-DD)")
    p.add_argument("--no-wind-report", action="store_true",
                   help="skip the wind effects section (battery and drift)")
    p.add_argument("--half-life", type=float, default=HALF_LIFE_FLIGHTS,
                   help="battery ageing: a flight this many of the same battery's "
                        "flights away counts half (default 30; 0 = all equal)")
    p.add_argument("--speed-terms", type=int, choices=[2, 3], default=SPEED_TERMS,
                   help="power vs airspeed: 2 = 1 + a*x + b*x^3, b >= 0 (default, "
                        "stable); 3 = free cubic (the old fit)")
    p.add_argument("--no-capacity", action="store_true",
                   help="ignore the battery-reported capacity (to compare)")
    p.add_argument("--long-min", type=float, default=25.0,
                   help="also score only the flights that used at least this "
                        "much battery (%%, default 25)")
    p.add_argument("--curve-degree", type=int, choices=[0, 1, 2], default=1,
                   help="Wh-per-%% curve vs battery %%: 0 flat, 1 straight line "
                        "(default), 2 quadratic")
    p.add_argument("--save-model", help="write the fitted model as JSON")
    p.add_argument("--plot-dir", help="save plots (PNG) in this folder")
    return p.parse_args()


def main():
    global HALF_LIFE_FLIGHTS, USE_CAPACITY, SPEED_TERMS
    args = parse_args()
    SPEED_TERMS = args.speed_terms
    HALF_LIFE_FLIGHTS = args.half_life
    USE_CAPACITY = not args.no_capacity
    flights = load_all(args.path, read_battery_map(args.battery_map))

    model = fit_model(flights)
    report_full_model(flights, model, args.curve_degree)
    battery_health(flights, args.curve_degree, SPEC_NEW.wh)
    if not args.no_wind_report:
        wind_report(flights, model, args.curve_degree)
        integrals = wind_integrals(flights, model, args.curve_degree)
        if args.plot_dir:
            save_wind_plots(args.plot_dir, integrals)

    loo = [] if args.loo == "off" else leave_one_out(flights, args.loo, args.curve_degree, args.long_min)

    route_curve = route_report(model, flights, args, loo) if args.route else None

    if args.save_model:
        batteries = {}
        for bat in sorted({f.battery for f in flights}):
            c = fit_wh_curve(flights, bat, args.curve_degree)
            batteries[bat] = {"poly_coef_high_first": [float(v) for v in c.coef],
                              "source": c.src}
        with open(args.save_model, "w") as fh:
            json.dump({
                "features": FEATURES,
                "speed_scale": SPEED_SCALE,
                "beta": [float(c) for c in model["beta"]],
                "va_max": model["va_max"],
                "winds_north_east": {k: list(v) for k, v in model["winds"].items()},
                "wh_per_pct_vs_battery_pct": batteries,
            }, fh, indent=2)
        print(f"model saved to {args.save_model}")

    if args.plot_dir:
        save_plots(args.plot_dir, loo, route_curve, args.reserve, flights,
                   fit_wh_curve(flights, None, args.curve_degree))


if __name__ == "__main__":
    main()
