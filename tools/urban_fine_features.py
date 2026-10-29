"""Fine building features for the wind among the buildings.

The site's coarse building model (js/urbanwind.js) reads GHSL on a ~90 m
grid, so it can't tell a sheltered street from an open square. This one
reads the buildings themselves: a 2 m height raster around the point
(on the site, the OpenStreetMap footprints rasterised by
js/urbanfine.js; in training, the building maps the CFD/U-Net used,
resampled to 2 m).

fine_features() must stay identical to fineFeatures() in
js/urbanfine.js - tests/unit/urbanfine.test.js checks the JS against
values computed here (tests/unit/fixtures/urban_fine_features.json,
written by `python3 tools/urban_fine_features.py --fixture`).

The raster: H[r, c] = building height in metres (0 = open ground), row
0 to the north, column 0 to the west, CELL_M square cells, an odd
number of rows and columns (N = 2 * WINDOW_M / CELL_M + 1) with the
point in the middle cell.
"""

import math

import numpy as np

CELL_M = 2.0
WINDOW_M = 150.0
N = int(round(2 * WINDOW_M / CELL_M)) + 1   # 151
ZMAX = 80.0          # m: highest height the U-Net knows
R_NEAR = 20.0        # m
R_MID = 50.0         # m
R_FAR = 150.0        # m
UP_LEN = 100.0       # m: upwind sector length
UP_HALF = 30.0       # degrees: upwind sector half-width
UP_RAY_HALF = 10.0   # degrees: half-width of the narrow upwind "ray"
SHELTER_MIN, SHELTER_MAX = -1.0, 5.0

FEATURES = ['z', 'zrel', 'lam20', 'lam50', 'lam150', 'hm50', 'hm150',
            'dbld', 'hnear', 'lamup', 'shelter', 'updist']


def fine_features(H, z, wdir):
    """Features at the middle cell of H, height z (m), wind FROM wdir (deg)."""
    H = np.asarray(H, dtype=np.float64)
    n = H.shape[0]
    ci = (n - 1) // 2
    z = min(float(z), ZMAX)
    n20 = b20 = n50 = b50 = n150 = b150 = 0
    s50 = s150 = 0.0
    dbld, hnear = R_FAR, 0.0
    nup = bup = 0
    shelter = SHELTER_MIN
    updist = R_FAR
    for r in range(n):
        dN = (ci - r) * CELL_M
        for c in range(n):
            dE = (c - ci) * CELL_M
            d = math.hypot(dN, dE)
            if d > R_FAR:
                continue
            h = float(H[r, c])
            built = h > 0
            n150 += 1
            if built:
                b150 += 1
                s150 += h
            if d <= R_MID:
                n50 += 1
                if built:
                    b50 += 1
                    s50 += h
                if d <= R_NEAR:
                    n20 += 1
                    if built:
                        b20 += 1
            if built and (d < dbld or (d == dbld and h > hnear)):
                dbld, hnear = d, h
            if d == 0:
                continue
            brg = (math.degrees(math.atan2(dE, dN)) % 360 + 360) % 360
            off = abs(((brg - wdir + 180) % 360 + 360) % 360 - 180)
            if off <= UP_HALF and d <= UP_LEN:
                nup += 1
                if built:
                    bup += 1
                    shelter = max(shelter, (h - z) / max(d, CELL_M))
            if built and off <= UP_RAY_HALF and d < updist:
                updist = d
    hm50 = s50 / b50 if b50 else 0.0
    hm150 = s150 / b150 if b150 else 0.0
    shelter = min(max(shelter, SHELTER_MIN), SHELTER_MAX)
    return [z, z / max(hm50, 3.0), b20 / n20, b50 / n50, b150 / n150, hm50, hm150,
            dbld, hnear, bup / nup if nup else 0.0, shelter, updist]


def window(Hcity, r, c):
    """The N x N window of a city raster around cell (r, c), or None at the edge."""
    k = (N - 1) // 2
    if r - k < 0 or c - k < 0 or r + k >= Hcity.shape[0] or c + k >= Hcity.shape[1]:
        return None
    return Hcity[r - k:r + k + 1, c - k:c + k + 1]


def _fixture():
    """Small rasters with known buildings (rectangles), for the JS parity test."""
    rng = np.random.default_rng(7)
    cases = []
    ci = (N - 1) // 2
    for k in range(6):
        H = np.zeros((N, N))
        rects = []
        for _ in range(0 if k == 5 else int(rng.integers(3, 40))):   # case 5: open country
            r0, c0 = int(rng.integers(0, N - 10)), int(rng.integers(0, N - 10))
            rh, cw, h = int(rng.integers(3, 25)), int(rng.integers(3, 25)), float(rng.integers(3, 60))
            if k == 0 and r0 <= ci < r0 + rh and c0 <= ci < c0 + cw:
                continue                         # case 0: the point stays open
            H[r0:r0 + rh, c0:c0 + cw] = h
            rects.append([r0, c0, rh, cw, h])
        z = [10, 20, 30, 45, 80, 120][k]
        wdir = float(rng.uniform(0, 360))
        cases.append({'z': z, 'wdir': wdir, 'rects': rects, 'features': fine_features(H, z, wdir)})
    return {'n': N, 'cell_m': CELL_M, 'features': FEATURES, 'cases': cases}


if __name__ == '__main__':
    import json
    import sys
    if '--fixture' in sys.argv:
        out = 'tests/unit/fixtures/urban_fine_features.json'
        with open(out, 'w') as f:
            json.dump(_fixture(), f)
        print('wrote', out)
