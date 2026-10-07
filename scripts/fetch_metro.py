"""Fetch Paris métro/RER station positions once from OpenStreetMap (Overpass)
and save them as app/data/metro.json so the map can label them offline."""
import json, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BBOX = "48.825,2.245,48.885,2.385"
def overpass(q):
    for host in ("https://overpass-api.de", "https://overpass.kumi.systems"):
        try:
            req = urllib.request.Request(host + "/api/interpreter", data=urllib.parse.urlencode({"data": q}).encode(),
                                         headers={"User-Agent": "moveable-feast-walk/0.1 (personal project)"})
            return json.load(urllib.request.urlopen(req, timeout=90))
        except Exception as e:
            print(host, "failed:", e)
    raise SystemExit("Overpass unavailable")

els = overpass(f"""[out:json][timeout:60];
(node["railway"="station"]["station"="subway"]({BBOX});
 node["railway"="station"]["network"~"RER"]({BBOX}););
out body;""")["elements"]
seen, out = {}, []
for e in els:
    t = e.get("tags", {})
    name = t.get("name")
    if not name:
        continue
    kind = "RER" if "RER" in t.get("network", "") and t.get("station") != "subway" else "M"
    key = (name, kind)
    if key in seen:
        continue
    seen[key] = 1
    out.append({"name": name, "lat": round(e["lat"], 6), "lng": round(e["lon"], 6), "kind": kind,
                "lines": t.get("line") or t.get("ref") or ""})
(ROOT / "app" / "data" / "metro.json").write_text(json.dumps(out, ensure_ascii=False))
print(len(out), "stations", out[:3])
