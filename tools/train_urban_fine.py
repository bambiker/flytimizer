"""Train the fine building-wind model (data/urban_fine_model.json).

It learns, from the U-Net (itself trained on CFD), how much of the
open-ground wind is left at a point among the buildings, from the
buildings around that point only (tools/urban_fine_features.py). The
site uses it where the drone takes off and lands (js/urbanfine.js),
with the buildings from OpenStreetMap.

Unlike data/urban_wind_model.json (the 70th percentile of the highest
value within 40 m, for weather stations in the open), the target here is
the U-Net value at the point itself, so a sheltered street comes out
sheltered.

Input, one directory per city:

  buildings.npy   2-D float array, building height in metres (0 = open),
                  row 0 to the north, square cells
  meta.json       {"cell_m": <cell size in metres>}
  wind_<dir>_<z>.npy
                  for each wind direction <dir> (degrees the wind comes
                  FROM) and height <z> (m above ground) the U-Net was run
                  at: the U-Net's wind speed divided by the open-ground
                  (inflow) speed at that height, on the same grid as
                  buildings.npy; NaN or <= 0 where there's no value
                  (inside buildings)

Rasters are resampled to 2 m (nearest cell) before the features are
taken, as the site's are.

  pip install numpy scikit-learn
  python3 tools/train_urban_fine.py ~/tlv/fine ~/jerusalem/fine ~/tokyo/fine ~/singapore/fine \
      --samples 40000 --out urban_fine_model.json

It prints, for each city left out in turn, how well a model trained on
the others imitates the U-Net there (R² of log ratio, and the mean ratio
among the buildings vs the U-Net's), then trains on all of them and
writes the model. Copy the file to data/urban_fine_model.json.
"""

import argparse
import glob
import json
import math
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import urban_fine_features as uf  # noqa: E402


def city_name(d):
    """~/tlv/fine -> tlv; ~/tlv -> tlv."""
    p = os.path.normpath(os.path.expanduser(d))
    return os.path.basename(os.path.dirname(p)) if os.path.basename(p) == 'fine' else os.path.basename(p)


def resample(a, cell_m):
    """Nearest-cell resample of a raster with cell_m cells to uf.CELL_M."""
    if abs(cell_m - uf.CELL_M) < 1e-6:
        return a
    rows = int(round(a.shape[0] * cell_m / uf.CELL_M))
    cols = int(round(a.shape[1] * cell_m / uf.CELL_M))
    ri = np.minimum((np.arange(rows) + 0.5) * uf.CELL_M / cell_m, a.shape[0] - 1).astype(int)
    ci = np.minimum((np.arange(cols) + 0.5) * uf.CELL_M / cell_m, a.shape[1] - 1).astype(int)
    return a[np.ix_(ri, ci)]


def load_city(d):
    meta = json.load(open(os.path.join(d, 'meta.json')))
    H = resample(np.load(os.path.join(d, 'buildings.npy')).astype(np.float64), meta['cell_m'])
    H = np.where(np.isfinite(H) & (H > 0), H, 0.0)
    winds = []
    for f in sorted(glob.glob(os.path.join(d, 'wind_*_*.npy'))):
        m = re.match(r'wind_([\d.]+)_([\d.]+)\.npy$', os.path.basename(f))
        if not m:
            continue
        W = resample(np.load(f).astype(np.float64), meta['cell_m'])
        if W.shape != H.shape:
            raise SystemExit(f'{f}: shape {W.shape} differs from buildings.npy {H.shape}')
        winds.append((float(m.group(1)), float(m.group(2)), W))
    if not winds:
        raise SystemExit(f'{d}: no wind_<dir>_<z>.npy files')
    return H, winds


def sample_city(d, n, rng):
    """n (features, log ratio) pairs at random open cells, every direction and height."""
    H, winds = load_city(d)
    k = (uf.N - 1) // 2
    X, y = [], []
    per = max(1, n // len(winds))
    for wdir, z, W in winds:
        ok = (H == 0) & np.isfinite(W) & (W > 0)
        ok[:k, :] = ok[-k:, :] = False
        ok[:, :k] = ok[:, -k:] = False
        rr, cc = np.nonzero(ok)
        if len(rr) == 0:
            continue
        pick = rng.choice(len(rr), size=min(per, len(rr)), replace=False)
        for i in pick:
            r, c = int(rr[i]), int(cc[i])
            X.append(uf.fine_features(uf.window(H, r, c), z, wdir))
            y.append(math.log(min(max(W[r, c], 0.05), 3.0)))
        print(f'  {city_name(d)}: dir {wdir:g} z {z:g}: {len(pick)} points', flush=True)
    return np.array(X), np.array(y)


def fit(X, y, args):
    from sklearn.ensemble import GradientBoostingRegressor
    m = GradientBoostingRegressor(n_estimators=args.trees, learning_rate=args.lr, max_depth=args.depth,
                                  min_samples_leaf=args.min_leaf, subsample=0.8, random_state=0)
    m.fit(X, y)
    return m


def export(m, cities, n):
    """The tree format js/urbanwind.js predictLogRatio reads: x[f] <= t goes left."""
    trees = []
    for est in m.estimators_[:, 0]:
        t = est.tree_
        trees.append({'f': [int(v) for v in t.feature], 't': [float(v) for v in t.threshold],
                      'l': [int(v) for v in t.children_left], 'r': [int(v) for v in t.children_right],
                      'v': [float(v) for v in t.value[:, 0, 0]]})
    init = float(m.init_.constant_[0][0]) if hasattr(m.init_, 'constant_') else float(m._raw_predict_init(np.zeros((1, len(uf.FEATURES))))[0][0])
    return {'version': 1, 'features': uf.FEATURES, 'init': init, 'lr': float(m.learning_rate), 'trees': trees,
            'cell_m': uf.CELL_M, 'window_m': uf.WINDOW_M, 'zmax': uf.ZMAX, 'target': 'point', 'cities': cities, 'n': int(n)}


def predict(model, X):
    out = np.full(len(X), model['init'])
    for t in model['trees']:
        node = np.zeros(len(X), dtype=int)
        for _ in range(64):
            leaf = np.array(t['l'])[node] < 0
            if leaf.all():
                break
            f = np.array(t['f'])[node]
            go_left = X[np.arange(len(X)), np.maximum(f, 0)] <= np.array(t['t'])[node]
            node = np.where(leaf, node, np.where(go_left, np.array(t['l'])[node], np.array(t['r'])[node]))
        out += model['lr'] * np.array(t['v'])[node]
    return out


def report(name, y, p, X):
    r2 = 1 - np.sum((y - p) ** 2) / np.sum((y - y.mean()) ** 2)
    close = X[:, uf.FEATURES.index('dbld')] <= 15
    print(f'{name:>12}: R² {r2:.2f}  mean ratio within 15 m of a building: U-Net {np.exp(y[close]).mean():.2f}, '
          f'model {np.exp(p[close]).mean():.2f}  (open: U-Net {np.exp(y[~close]).mean():.2f}, model {np.exp(p[~close]).mean():.2f})')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cities', nargs='+', help='one directory per city (see above)')
    ap.add_argument('--samples', type=int, default=40000, help='points per city')
    ap.add_argument('--trees', type=int, default=300)
    ap.add_argument('--lr', type=float, default=0.05)
    ap.add_argument('--depth', type=int, default=4)
    ap.add_argument('--min-leaf', type=int, default=50)
    ap.add_argument('--out', default='urban_fine_model.json')
    args = ap.parse_args()
    rng = np.random.default_rng(0)
    data = {}
    for d in args.cities:
        print('sampling', d, flush=True)
        data[d] = sample_city(d, args.samples, rng)
    names = {d: city_name(d) for d in args.cities}
    if len(args.cities) > 1:
        print('\nEach city with a model trained on the others:')
        for d in args.cities:
            Xtr = np.vstack([data[o][0] for o in args.cities if o != d])
            ytr = np.concatenate([data[o][1] for o in args.cities if o != d])
            m = export(fit(Xtr, ytr, args), [], len(ytr))
            report(names[d], data[d][1], predict(m, data[d][0]), data[d][0])
    X = np.vstack([data[d][0] for d in args.cities])
    y = np.concatenate([data[d][1] for d in args.cities])
    fitted = fit(X, y, args)
    model = export(fitted, [names[d] for d in args.cities], len(y))
    # The exported trees must predict what scikit-learn does.
    diff = np.abs(fitted.predict(X[:2000]) - predict(model, X[:2000])).max()
    if diff > 1e-5:
        raise SystemExit(f'export check failed: max difference {diff}')
    print('\nAll cities together (training fit):')
    report('all', y, predict(model, X), X)
    with open(args.out, 'w') as f:
        json.dump(model, f, separators=(',', ':'))
    print(f'\nwrote {args.out} ({os.path.getsize(args.out) // 1024} kB, {len(model["trees"])} trees)')


if __name__ == '__main__':
    main()
