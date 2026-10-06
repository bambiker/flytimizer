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
* 🏢 Clearance above mapped buildings, or a detour around ones too tall to climb over
* 🏫 Detours around restricted and sensitive sites from OpenStreetMap: schools, kindergartens, hospitals, playgrounds, nursing homes, universities, power facilities, airports, heliports, prisons, embassies and military sites
* ⚖️ **Country rules** (height limit, keep-out distances, no-fly sites) for Israel and the United States, with Israel's as the default elsewhere
* 🔋 **Battery estimate** per leg, adjusted for payload, wind, climbs, cold and battery health, with a reserve warning
* 🔄 Two plans: **fastest** and **least battery**, each choosing the outbound and return heights independently
* 🌧️ Rain, visibility and temperature, with warnings
* 🗺️ **DJI flight-plan export** (WPML `.kmz` for DJI Pilot 2)
* 🔗 **Shareable links** that reproduce the route and drone settings; metric or imperial units

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

The map incorporates selected features from OpenStreetMap.

Currently, FLYTIMIZER identifies locations such as:

* Schools
* Kindergartens
* Hospitals
* Playgrounds

These areas are displayed on the map and considered when generating the route.

Mapped buildings are also used to maintain a minimum clearance above structures.

> The current implementation is an optimization and planning tool, not a replacement for official aviation regulations, NOTAMs, airspace restrictions, or operator responsibility.

---

## Weather Data

Current wind and weather information is obtained from **Open-Meteo**.

The application uses weather information at multiple altitudes to evaluate how the atmospheric conditions may affect the flight.

Weather forecasts are inherently uncertain, so calculated results should be treated as estimates rather than guaranteed flight conditions.

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

* Detailed battery modeling (the battery estimate is a simple physical model, roughly ±20%)
* Detailed motor/propeller efficiency
* Turbulence
* Building-induced local wind fields
* Complete 3D CFD wind modeling
* Dynamic obstacles
* Air traffic
* Real-time airspace restrictions
* Complete regulatory compliance checking
* Detailed energy consumption along every segment

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

The site is plain HTML, CSS and JavaScript with no build step. `index.html` loads a single ES module, `js/app.js`, which imports the rest of `js/` (one file per area: wind and routing math, OpenStreetMap lookups, terrain, battery, plans, the map, sharing, the DJI export) and wires up the page.

### Running the tests

The site itself has no build step, but it has automated tests (run on every pull request by GitHub Actions):

```bash
npm install
npx playwright install chromium   # first time only
npm test
```

* `tests/unit/` — the calculation and formatting functions, run directly in Node.
* `tests/e2e/` — the real page in Chromium, with the weather, elevation and OpenStreetMap services replaced by fixed test data, so the tests run offline and give the same result every time.

---

## About

**FLYTIMIZER** is an experimental platform for exploring how wind, altitude, drone performance and environmental constraints can be combined to improve drone flight planning.

**FLY + OPTIMIZER = FLYTIMIZER**
