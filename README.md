# Caltrain Live

A dynamic Caltrain schedule web app with live location tracking. Installable as a PWA on mobile devices.

**Live site: [simondedman.github.io/caltrain-dynamic](https://simondedman.github.io/caltrain-dynamic/)**

## Features

- Full weekday and weekend timetables (northbound/southbound)
- Auto-detects weekday vs weekend schedule
- Current time indicator that scrolls to "now" in the timetable
- GPS location tracking to highlight your nearest station and show your position between stations
- Optional real-time delay data via the [511.org API](https://511.org/open-data/token)
- "Next train" banner showing the soonest departure from your station
- Installable as a Progressive Web App with offline support
- Mobile-first responsive design

## How it works

The app uses static GTFS schedule data from Caltrain, pre-processed into a compact JSON file. A Python script downloads the latest GTFS feed and generates the schedule data. The front-end is a single-page vanilla JS app with no dependencies.

## Updating schedule data

When Caltrain publishes a new GTFS feed (e.g. seasonal schedule changes):

```bash
python3 scripts/update-schedule.py
```

This downloads the latest GTFS data and regenerates `data/schedule.json`.

## Tech stack

- Vanilla HTML/CSS/JS (no frameworks, no build step)
- Service Worker for offline caching
- Web Geolocation API for position tracking
- 511.org SIRI API for real-time delays (optional, requires free API key)
