# Tools

Offline scripts that are not part of the site.

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
