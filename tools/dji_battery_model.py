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
5. Leave-one-out validation: each flight in turn is predicted by a model
   fitted on all the other flights, and compared with what its battery
   actually did. Compared side by side:
       naive     - average %/minute of the training flights
       spec      - the Flytimizer site's spec-sheet model (js/battery.js)
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
                       test_speed=6.0, climb_eff=0.6, descent_factor=0.9)

METHODS = ["naive", "spec", "no wind", "same day", "own wind", "E/% flat", "E/% curve"]

MIN_STEPS_PER_BATTERY = 40    # 1% steps needed for a battery's own curve
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
        beta = lstsq(X, y)
        if not with_wind:
            break
        for s in sessions:
            winds[s] = estimate_wind(beta, [f for f in flights if f.session == s])

    X = np.vstack([flight_design(f, winds[f.session]) for f in flights])
    beta = lstsq(X, y)
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

def _airspeed_factor(v, vmax):
    x = np.clip(np.asarray(v, float) / max(vmax, 0.1), 0, 1.2)
    return 1 - 0.2 * x + 0.5 * x ** 3


def spec_power(f, spec=SPEC):
    hover = spec.wh * 60.0 / spec.minutes / _airspeed_factor(spec.test_speed, spec.vmax)
    b = f.bins
    cruise = hover * _airspeed_factor(np.hypot(b["vn"], b["ve"]), spec.vmax)
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


def fit_wh_curve(flights, battery=None, degree=1):
    """Wh per 1% as a polynomial in the battery %, fitted to the 1% steps.
    Uses the battery's own steps when it has enough of them."""
    def steps_of(fs):
        parts = [f.steps for f in fs if len(f.steps)]
        return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()

    own = [f for f in flights if battery not in (None, "unknown") and f.battery == battery]
    st, src = steps_of(own), "same battery"
    if len(st) < MIN_STEPS_PER_BATTERY:
        st, src = steps_of(flights), "all batteries"
    if len(st) < 10 * (degree + 1):
        whp, _, src = wh_per_pct(flights, battery)
        return SimpleNamespace(coef=np.array([whp]), lo=0.0, hi=100.0, n=0,
                               src=f"flat ({src}, too few 1% steps)")

    # Mid-point of each step: level L covers the charge from L down to L-1.
    x = st["level"].to_numpy() - 0.5 * st["drop"].to_numpy()
    y = (st["wh"] / st["drop"]).to_numpy()
    w = st["drop"].to_numpy()
    keep = np.ones(len(x), bool)
    for _ in range(2):   # drop stalled-gauge outliers, then refit
        coef = np.polyfit(x[keep], y[keep], degree, w=np.sqrt(w[keep]))
        res = y - np.polyval(coef, x)
        mad = 1.4826 * np.median(np.abs(res[keep] - np.median(res[keep])))
        keep = np.abs(res) <= 3.5 * max(mad, 1e-4)
    coef = np.polyfit(x[keep], y[keep], degree, w=np.sqrt(w[keep]))
    return SimpleNamespace(coef=coef, lo=float(x.min()), hi=float(x.max()),
                           n=int(keep.sum()), src=src)


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
# Leave-one-out
# ---------------------------------------------------------------------

def leave_one_out(flights, group, degree):
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
        whp, rate, whp_src = wh_per_pct(train, f.battery)
        if not np.isfinite(whp):
            continue
        curve = fit_wh_curve(train, f.battery, degree)
        dur = f.bins["dur"].to_numpy()
        same_day = model["winds"].get(f.session)
        own = estimate_wind(model["beta"], [f])

        power = {
            "spec": spec_power(f),
            "no wind": predict_power(model, f, (0.0, 0.0)),
            "same day": predict_power(model, f, same_day or (0.0, 0.0)),
            "own wind": predict_power(model, f, own),
        }
        drop = {
            "naive": rate * f.duration_s,
            "spec": np.sum(power["spec"] * dur) / 3600.0 / SPEC.wh * 100.0,
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

    _print_loo(results)
    return results


def _endurance_min(soc_start, drop, duration_s):
    """Minutes from soc_start to 0% at this flight's average rate."""
    if not (drop > 0):
        return np.nan
    return soc_start * duration_s / drop / 60.0


def _print_loo(results):
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

    print()
    print("summary (errors in battery percentage points; endurance = time to 0%")
    print("at the flight's average rate, extrapolated)")
    print(f"  {'method':10s} {'MAE %':>7s} {'bias %':>7s} {'MAE rel':>8s} "
          f"{'endur. MAE':>11s} {'power R2':>9s}")
    for m in METHODS:
        err = np.array([r.drop[m] - r.flight.soc_drop for r in results])
        rel = np.array([abs(r.drop[m] - r.flight.soc_drop) / r.flight.soc_drop for r in results])
        end_err = np.array([
            _endurance_min(r.flight.soc_start, r.drop[m], r.flight.duration_s)
            - _endurance_min(r.flight.soc_start, r.flight.soc_drop, r.flight.duration_s)
            for r in results])
        r2s = [r.r2[m] for r in results if m in r.r2]
        r2txt = f"{np.nanmedian(r2s):9.2f}" if r2s else f"{'-':>9s}"
        print(f"  {m:10s} {np.mean(np.abs(err)):7.2f} {np.mean(err):+7.2f} "
              f"{100 * np.mean(rel):7.1f}% {np.nanmean(np.abs(end_err)):9.1f} m {r2txt}")
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
    print("level flight power vs airspeed (model / site spec model):")
    for v in (0, 3, 6, 9, 12):
        if v > model["va_max"] + 0.5:
            break
        p = design([v], [0], [0], [0], [0], (0, 0)) @ model["beta"]
        hover = SPEC.wh * 60 / SPEC.minutes / _airspeed_factor(SPEC.test_speed, SPEC.vmax)
        ps = hover * _airspeed_factor(v, SPEC.vmax)
        print(f"  {v:4.0f} m/s: {p[0]:6.1f} W / {ps:6.1f} W")
    print(f"  (highest airspeed in the data: {model['va_max']:.1f} m/s)")

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
        for m in ("naive", "spec", "same day", "E/% flat", "E/% curve"):
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
    p.add_argument("--curve-degree", type=int, choices=[0, 1, 2], default=1,
                   help="Wh-per-%% curve vs battery %%: 0 flat, 1 straight line "
                        "(default), 2 quadratic")
    p.add_argument("--save-model", help="write the fitted model as JSON")
    p.add_argument("--plot-dir", help="save plots (PNG) in this folder")
    return p.parse_args()


def main():
    args = parse_args()
    flights = load_all(args.path, read_battery_map(args.battery_map))

    model = fit_model(flights)
    report_full_model(flights, model, args.curve_degree)

    loo = [] if args.loo == "off" else leave_one_out(flights, args.loo, args.curve_degree)

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
