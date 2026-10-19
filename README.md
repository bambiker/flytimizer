# FLYTIMIZER

### Drone Optimal Route & Altitude Optimizer

**FLYTIMIZER** helps drone operators find a more efficient flight profile between two locations by considering wind, altitude, drone performance, payload, and environmental constraints.

🌐 **Live demo:** https://bambiker.github.io/flytimizer/

---

## What is FLYTIMIZER?

Wind conditions can change significantly with altitude. A route that looks optimal near the ground may not be the fastest or most efficient route at a different height.

FLYTIMIZER evaluates different flight altitudes and estimates the time required for the outbound and return legs of a drone flight.

Instead of simply flying at a fixed altitude, FLYTIMIZER asks:

> **What altitude should the drone fly at to complete the mission as efficiently as possible?**

---

## Current Features

* 📍 Set a **start point and destination** on the map, by place search, or from your current location
* 🌬️ Live hourly wind forecast at several altitudes, with estimated gusts, and a **48-hour outlook** to pick the best time
* 🚁 Drone presets (DJI, Autel) or custom drone parameters
* 📦 **Delivery** missions (different payload on the way back) or **photo / inspection** round trips
* ⛰️ **Terrain following**: heights are above the ground, using Copernicus GLO-90 elevation
* 🏢 Clearance above mapped buildings, or a detour around ones too tall to climb over; where OpenStreetMap has no height for a building, the average building height around it from the EU's Global Human Settlement Layer (GHS-BUILT-H, 2018) is used instead of a guess
* 🏫 Detours around restricted and sensitive sites from OpenStreetMap: schools, kindergartens, hospitals, playgrounds, nursing homes, universities, power facilities, airports, heliports, prisons, embassies and military sites; sites that aren't no-fly zones under the local rules (schools, hospitals, playgrounds…) can be switched off in **Restricted areas**
* ⚖️ **Country rules** (height limit, keep-out distances, no-fly sites) for Israel and the United States, with Israel's as the default elsewhere
* 👥 **People under the route**: roughly how many people live within 50 m either side, and how crowded the busiest stretch is, from the EU's GHS-POP population grid, and a **route over fewer people** when a modest detour saves enough of them (the Fewer people plan)
* 🔋 **Battery estimate** per leg, adjusted for payload, wind, climbs, cold and battery health, with a reserve warning; the DJI Neo 2 preset is calibrated from real flight logs (power curve, climb efficiency, usable energy)
* 📡 **Conditions here** button: for the start point (or your location), the predicted number of navigation satellites overhead (GPS, Galileo, GLONASS, BeiDou, from CelesTrak orbits), the Kp index (NOAA), the highest height today's wind allows for your drone, and the round-trip range; with your own location it also checks for **GPS spoofing** (a position in another country than your internet connection and time zone, e.g. the common fake fix at Beirut airport)
* 🧭 **Round-trip range** drawn on the map: how far the drone can fly from the start and still get back with the reserve, in every direction, with today's wind
* 🔄 Up to three plans, each with its own heights, battery and flight-plan downloads: **fastest**, **least battery** (heights, flight style and, where it saves battery, a lower speed per leg) and **fewer people** (the fastest plan along the route over fewer people, when there is one)
* 💨 Drones that hold a set **ground speed** (DJI waypoint missions, most multirotors) or a set **airspeed** (fixed-wing, or flying flat out), which behave differently with a tailwind
* 🌧️ Rain, visibility and temperature, with warnings
* 🗺️ **DJI flight-plan export** (WPML `.kmz` for DJI Pilot 2)
* 🔗 **Shareable links** that reproduce the route and drone settings; metric or imperial units
* 📚 **Guides** on altitude, battery and round-trip range in wind, and on why the straight line isn't always the best route

---

## How It Works

The user selects two points on the map:

**Start → Destination**

FLYTIMIZER then evaluates candidate heights above ground from **30 m to 120 m** in 10 m steps, up to the local legal limit.

For each altitude, the system considers factors including:

* Wind speed
* Wind direction
* Flight heading
* Drone horizontal speed
* Ascent speed
* Descent speed
* Wind resistance
* Drag coefficient
* Payload coefficient
* Flight distance
* Terrain along the route
* Buildings and restricted areas along the route

The system estimates the flight time and battery use for each candidate height, and recommends both the fastest plan and the one that uses the least battery.

The return leg can be evaluated separately because the wind direction relative to the drone's heading is reversed.

---

## Why Altitude Matters

Wind is not necessarily the same at every altitude.

A drone may encounter:

* Lower wind speeds near the ground
* Stronger winds higher up
* Different wind directions with altitude
* Favorable tailwinds at one altitude
* Stronger headwinds at another altitude

Therefore, the shortest geometric route is not necessarily the fastest route.

For longer flights, higher-drag aircraft, or significant winds along the flight direction, altitude selection can have a measurable effect on flight time and potentially on energy consumption.

---

## Drone Parameters

FLYTIMIZER currently supports configurable parameters such as:

| Parameter           | Description                                     |
| ------------------- | ----------------------------------------------- |
| Horizontal speed    | Nominal horizontal flight speed                 |
| Ascent speed        | Vertical climb speed                            |
| Descent speed       | Vertical descent speed                          |
| Wind resistance     | Maximum wind condition considered for the drone |
| Drag coefficient    | Aerodynamic drag parameter                      |
| Payload coefficient | Relative payload effect on flight performance   |

Drone presets can be used where available, while individual parameters can also be modified.

---

## Payload

Payload can affect flight performance.

FLYTIMIZER allows different payload coefficients for:

* **Outbound flight**
* **Return flight**

This is useful for missions such as deliveries where the drone carries a payload on the outbound leg but returns empty.

For example:

```text
Outbound:
Drone + payload

Return:
Drone only
```

This allows the two legs of the mission to be evaluated independently.

---

## Environmental Constraints

The map incorporates selected features from OpenStreetMap:

* **No-fly sites under the local rules** (for example airports, military airfields and other military sites, prisons; in Israel also heliports and embassies) are always avoided, each with its keep-out distance drawn on the map as a dashed ring, and the route warns when it comes close. Public shelters tagged as bunkers aren't counted as military sites.
* **Sensitive sites** (schools, kindergartens, playgrounds, hospitals, nursing homes, universities, power facilities) aren't no-fly zones in themselves but are usually full of people, so they're avoided by default; each type can be switched off in **Restricted areas**, and switched-off sites are shown in grey.
* **Buildings** set a minimum clearance above the route, or a detour around ones too tall to climb over. Missing building heights come from the EU's GHS-BUILT-H layer.
* **People**: the EU's GHS-POP population grid gives a rough count of the people living under the route, and a route over fewer people is offered when a modest detour saves enough of them.

A start or destination inside a keep-out zone doesn't send the route out to the zone's edge and back: the route just doesn't get closer to the site than it has to.

> The current implementation is an optimization and planning tool, not a replacement for official aviation regulations, NOTAMs, airspace restrictions, or operator responsibility.

---

## Data Sources

* **Wind and weather**: Open-Meteo hourly forecasts at several heights (10, 80, 120 m), with gusts, rain, visibility and temperature. Forecasts are inherently uncertain, so results are estimates, not guaranteed flight conditions.
* **Elevation**: Copernicus GLO-90 via Open-Meteo.
* **Map features**: OpenStreetMap (Overpass), with backup servers.
* **Building heights and population**: the EU's Global Human Settlement Layer (GHS-BUILT-H 2018, GHS-POP 2025, CC BY 4.0), read straight from its public file in small pieces.
* **Satellites**: CelesTrak orbit data, propagated in the browser to predict how many GPS, Galileo, GLONASS and BeiDou satellites are overhead. **Kp index**: NOAA SWPC.
* **Spoofing check**: the country of your internet connection (geojs.io) and your device's time zone.

---

## Research Background

Several aspects of the current model are based on published research and engineering references, including:

* Effects of payload and aircraft weight on flight performance
* Wind variation with altitude
* Drone aerodynamic drag
* Atmospheric boundary-layer wind behavior
* Effects of drone altitude on acoustic disturbance

Relevant references are provided directly in the application.

---

## Current Limitations

FLYTIMIZER is an evolving prototype.

The current version does **not** attempt to model every factor affecting a real drone mission.

Examples include:

* Detailed battery modeling (the battery estimate is a simple physical model, roughly ±20%, calibrated from flight logs only for the Neo 2 so far)
* Detailed motor/propeller efficiency
* Turbulence
* Building-induced local wind fields
* Complete 3D CFD wind modeling
* Dynamic obstacles
* Air traffic
* Real-time airspace restrictions
* Complete regulatory compliance checking
* Detailed energy consumption along every segment
* Where people actually are at flight time (the population grid counts where people live)
* The satellites your drone actually sees (the count is a prediction from their orbits)

The current optimization should therefore be considered a **decision-support estimate**, rather than an autonomous flight command.

---

## Roadmap

Potential future development includes:

### Building-Scale Wind

Future versions may incorporate local wind effects around buildings, terrain and urban structures.

This could allow the optimizer to distinguish between:

* Open terrain
* Urban areas
* Wind corridors
* Wind shadows
* Exposed rooftops
* Sheltered areas

### Flight Log Learning

Real flight data could eventually be used to compare:

```text
Forecast wind
      vs.
Observed wind
      vs.
Actual drone performance
```

This could allow FLYTIMIZER to learn aircraft-specific performance and local wind biases over time.

A first step is in [`tools/dji_battery_model.py`](tools/README.md): an offline script that fits a battery model to DJI flight-record CSVs, validates it flight by flight, and estimates wind effects. Its results already calibrate the site's Neo 2 preset.

---

## Project Status

🚧 **Early-stage prototype / research project**

The goal is to develop FLYTIMIZER into a practical platform for wind-aware drone flight planning and optimization.

The current web application is primarily a demonstration and experimentation environment.

---

## Disclaimer

FLYTIMIZER provides estimated flight-planning information.

It does not provide legal authorization to operate a drone and does not replace applicable aviation regulations, airspace information, weather warnings, operational risk assessments, or the judgment of a qualified drone operator.

Always verify current regulations, airspace restrictions and actual weather conditions before flight.

---

## Contributing

Ideas, bug reports, model improvements and suggestions are welcome.

Potential areas for contribution include:

* Wind modeling
* Drone performance models
* Route optimization algorithms
* Energy consumption models
* GIS / OpenStreetMap integration
* Visualization
* Weather-data integration

### Code layout

The site is plain HTML, CSS and JavaScript with no build step. `index.html` loads a single ES module, `js/app.js`, which imports the rest of `js/` (one file per area: wind and routing math, OpenStreetMap lookups, terrain, battery, range, plans, the map, sharing, the DJI export, the GHSL readers for building heights and population, the route over fewer people, satellites, the spoofing check and the "Conditions here" card) and wires up the page. Offline scripts that aren't part of the site live in `tools/`.

### Running the tests

The site itself has no build step, but it has automated tests (run on every pull request by GitHub Actions):

```bash
npm install
npx playwright install chromium   # first time only
npm test
```

* `npm run lint` — ESLint (also part of `npm test`).
* `tests/unit/` — the calculation and formatting functions, run directly in Node.
* `tests/e2e/` — the real page in Chromium, with every outside service (weather, elevation, OpenStreetMap, GHSL, CelesTrak, NOAA, IP country) replaced by fixed test data, so the tests run offline and give the same result every time.

---

## About

**FLYTIMIZER** is an experimental platform for exploring how wind, altitude, drone performance and environmental constraints can be combined to improve drone flight planning.

**FLY + OPTIMIZER = FLYTIMIZER**
