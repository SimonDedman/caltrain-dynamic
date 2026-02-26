#!/usr/bin/env python3
"""
Download and process Caltrain GTFS data into optimized schedule JSON.

Usage:
    python3 scripts/update-schedule.py

Downloads the latest GTFS feed from Caltrain's official source,
parses it, and generates data/schedule.json for the web app.
"""

import csv
import io
import json
import os
import sys
import urllib.request
import zipfile
from collections import defaultdict

GTFS_URL = "https://data.trilliumtransit.com/gtfs/caltrain-ca-us/caltrain-ca-us.zip"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def download_gtfs():
    print(f"Downloading GTFS from {GTFS_URL}...")
    req = urllib.request.Request(GTFS_URL, headers={"User-Agent": "CaltrainLive/1.0"})
    resp = urllib.request.urlopen(req)
    return zipfile.ZipFile(io.BytesIO(resp.read()))


def read_csv(zf, filename):
    with zf.open(filename) as f:
        text = io.TextIOWrapper(f, encoding="utf-8-sig")
        return list(csv.DictReader(text))


def process_gtfs(zf):
    stops_raw = read_csv(zf, "stops.txt")
    trips_raw = read_csv(zf, "trips.txt")
    stop_times_raw = read_csv(zf, "stop_times.txt")
    routes_raw = read_csv(zf, "routes.txt")
    calendar_raw = read_csv(zf, "calendar.txt")

    # Build route map
    routes = {r["route_id"]: r for r in routes_raw}

    # Build calendar map
    calendars = {}
    for cal in calendar_raw:
        is_weekday = cal.get("monday", "0") == "1"
        is_weekend = cal.get("saturday", "0") == "1"
        calendars[cal["service_id"]] = "weekday" if is_weekday else "weekend"

    # Build stops: parent stations only
    parent_stops = {}
    child_to_parent = {}
    for s in stops_raw:
        if s.get("location_type") == "1":
            parent_stops[s["stop_id"]] = {
                "stop_id": s["stop_id"],
                "stop_name": s["stop_name"],
                "lat": float(s["stop_lat"]),
                "lon": float(s["stop_lon"]),
            }
        elif s.get("parent_station"):
            child_to_parent[s["stop_id"]] = s["parent_station"]

    # Sort stations north to south (by latitude, descending)
    stations_sorted = sorted(parent_stops.values(), key=lambda s: -s["lat"])

    # Clean station names
    station_list = []
    station_id_to_idx = {}
    for i, s in enumerate(stations_sorted):
        name = (
            s["stop_name"]
            .replace(" Caltrain Station", "")
            .replace(" Station", "")
        )
        station_list.append(
            {
                "id": s["stop_id"],
                "name": name,
                "lat": round(s["lat"], 6),
                "lon": round(s["lon"], 6),
            }
        )
        station_id_to_idx[s["stop_id"]] = i

    # Build trip info map
    trip_info = {}
    for t in trips_raw:
        route = routes.get(t["route_id"], {})
        trip_info[t["trip_id"]] = {
            "route_type": route.get("route_short_name", "Local"),
            "direction": "northbound" if t.get("direction_id") == "0" else "southbound",
            "service_id": t["service_id"],
            "headsign": t.get("trip_headsign", ""),
            "short_name": t.get("trip_short_name", ""),
        }

    # Build stop times by trip
    trip_stops = defaultdict(list)
    for st in stop_times_raw:
        trip_stops[st["trip_id"]].append(st)

    # Process trains
    schedules = {"weekday": {"northbound": [], "southbound": []}, "weekend": {"northbound": [], "southbound": []}}

    for trip_id, info in trip_info.items():
        sched_type = calendars.get(info["service_id"])
        if not sched_type:
            continue

        stops = sorted(trip_stops.get(trip_id, []), key=lambda s: int(s["stop_sequence"]))
        if not stops:
            continue

        # Map stop times to station indices
        times = [None] * len(station_list)
        for stop in stops:
            parent_id = child_to_parent.get(stop["stop_id"], stop["stop_id"])
            idx = station_id_to_idx.get(parent_id)
            if idx is not None:
                dep = stop["departure_time"]
                parts = dep.split(":")
                h, m = int(parts[0]), int(parts[1])
                times[idx] = f"{h}:{m:02d}"

        # Determine type code
        rt = info["route_type"]
        type_code = "L"
        if "Limited" in rt:
            type_code = "T"
        elif "Express" in rt:
            type_code = "X"
        elif "South" in rt:
            type_code = "S"

        train = {
            "num": info["short_name"] or trip_id.split("-")[0],
            "type": type_code,
            "times": times,
        }

        direction = info["direction"]
        schedules[sched_type][direction].append(train)

    # Sort trains by first departure time
    def sort_key(train):
        for t in train["times"]:
            if t:
                parts = t.split(":")
                return int(parts[0]) * 60 + int(parts[1])
        return 9999

    for sched_type in schedules:
        for direction in schedules[sched_type]:
            schedules[sched_type][direction].sort(key=sort_key)

    return {"stations": station_list, **schedules}


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    zf = download_gtfs()
    result = process_gtfs(zf)

    output_path = os.path.join(OUTPUT_DIR, "schedule.json")
    with open(output_path, "w") as f:
        json.dump(result, f, separators=(",", ":"))

    size = os.path.getsize(output_path)
    n_weekday = len(result["weekday"]["northbound"]) + len(result["weekday"]["southbound"])
    n_weekend = len(result["weekend"]["northbound"]) + len(result["weekend"]["southbound"])

    print(f"Generated {output_path}")
    print(f"  Size: {size:,} bytes ({size / 1024:.1f} KB)")
    print(f"  Stations: {len(result['stations'])}")
    print(f"  Weekday trains: {n_weekday}")
    print(f"  Weekend trains: {n_weekend}")


if __name__ == "__main__":
    main()
