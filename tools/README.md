# Tools

Offline scripts that are not part of the site.

## `train_urban_fine.py`

Trains the fine building-wind model (`data/urban_fine_model.json`) that
the site uses at the takeoff and landing points: how much of the
open-ground wind the U-Net leaves at a point, from the buildings within
150 m of it (`urban_fine_features.py`, the same features as
`js/urbanfine.js`). Input: per city, the building-height raster and the
U-Net's wind ratio for each direction and height, as `.npy` files (see
the docstring). It reports each city with a model trained on the others,
then writes the model.

```
pip install numpy scikit-learn
python3 tools/train_urban_fine.py ~/tlv/fine ~/jerusalem/fine ~/tokyo/fine ~/singapore/fine --out urban_fine_model.json
```

After changing the features, regenerate the parity fixture:
`python3 tools/urban_fine_features.py --fixture`.

## `dji_battery_model.py`

Fits a battery model to your own DJI flight-record CSVs and predicts when
the battery will run out on a planned route.

- Models **power** (voltage x current) per 1-second sample from airspeed,
  climb, descent, acceleration and turning, with one wind vector estimated
  per day.
- Converts energy to battery % with a Wh-per-% figure measured **per
  battery** (serial number from the logs, or a `--battery-map` CSV).
- Validates with **leave-one-out** (one flight, or `--loo day` for one whole
  day, at a time) against simple baselines and the site's spec-sheet model.
- `--route route.csv` predicts battery % along a route, with wind.

```
pip install numpy pandas matplotlib
python3 tools/dji_battery_model.py ~/dji --battery-map batteries.csv
python3 tools/dji_battery_model.py ~/dji --route route.csv --wind-speed 4 --wind-from 270 --plot-dir plots
```

See the docstring at the top of the script for the CSV formats.
