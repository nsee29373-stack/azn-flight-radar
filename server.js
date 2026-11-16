
const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const TILE_RADIUS_NM = 250;
const TILE_RADIUS_KM = 463;
const TILE_SPACING_KM = 750;
const CACHE_TTL_MS = 60000;
const cache = new Map();

function destination(lat, lon, bearingDeg, distanceKm) {
  const R = 6371.0088;
  const b = bearingDeg * Math.PI / 180;
  const d = distanceKm / R;
  const p1 = lat * Math.PI / 180;
  const l1 = lon * Math.PI / 180;

  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(d) +
    Math.cos(p1) * Math.sin(d) * Math.cos(b)
  );

  const l2 = l1 + Math.atan2(
    Math.sin(b) * Math.sin(d) * Math.cos(p1),
    Math.cos(d) - Math.sin(p1) * Math.sin(p2)
  );

  return {
    lat: p2 * 180 / Math.PI,
    lon: ((l2 * 180 / Math.PI + 540) % 360) - 180
  };
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const p1 = lat1 * rad;
  const p2 = lat2 * rad;
  const dp = (lat2 - lat1) * rad;
  const dl = (lon2 - lon1) * rad;

  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) *
    Math.sin(dl / 2) ** 2;

  return 6371.0088 * 2 *
    Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildQueryCenters(lat, lon, radiusKm) {
  const centers = [{ lat, lon }];

  const rowStep =
    TILE_SPACING_KM * Math.sqrt(3) / 2;

  const extent = radiusKm + TILE_RADIUS_KM;
  const rows = Math.ceil(extent / rowStep);
  const cols = Math.ceil(extent / TILE_SPACING_KM) + 2;

  for (let row = -rows; row <= rows; row++) {
    for (let col = -cols; col <= cols; col++) {

      if (row === 0 && col === 0) continue;

      const east =
        (col + row / 2) * TILE_SPACING_KM;

      const north = row * rowStep;
      const offset = Math.hypot(east, north);

      if (offset > extent) continue;

      const bearing =
        (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;

      centers.push(
        destination(lat, lon, bearing, offset)
      );
    }
  }

  return centers;
}

async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function runWorker() {
    while (true) {
      const index = next++;

      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        results[index] = { error: error.message };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      runWorker
    )
  );

  return results;
}

async function fetchTile(center) {
  const url =
    `https://api.adsb.lol/v2/lat/${center.lat.toFixed(5)}` +
    `/lon/${center.lon.toFixed(5)}/dist/${TILE_RADIUS_NM}`;

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`ADSB.lol HTTP ${response.status}`);
  }

  const data = await response.json();

  return data.aircraft || data.ac || [];
}

app.get("/", (req, res) => {
  res.json({
    app: "AZN Flight Radar API",
    status: "online",
    coverageKm: 2000,
    providerTileRadiusNm: TILE_RADIUS_NM
  });
});

app.get("/api/aircraft", async (req, res) => {
  try {
    const lat = Number(req.query.lat ?? 32);
    const lon = Number(req.query.lon ?? 45);
    const dist = Number(req.query.dist ?? 2000);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(dist) ||
      lat < -90 || lat > 90 ||
      lon < -180 || lon > 180 ||
      dist < 1 || dist > 2000
    ) {
      return res.status(400).json({
        error: "Invalid coordinates or distance"
      });
    }

    const cacheKey =
      `${lat.toFixed(2)}:${lon.toFixed(2)}:${dist}`;

    const cached = cache.get(cacheKey);

    if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
      res.setHeader("Cache-Control", "no-store");

      return res.json({
        ...cached.data,
        cached: true
      });
    }

    const centers = buildQueryCenters(lat, lon, dist);

    const tileResults = await mapWithLimit(
      centers,
      4,
      fetchTile
    );

    const successful =
      tileResults.filter(Array.isArray);

    const failedQueries =
      tileResults.length - successful.length;

    if (successful.length === 0) {
      return res.status(502).json({
        error: "Could not retrieve flight data",
        detail: "All ADSB.lol area requests failed",
        queries: centers.length
      });
    }

    const unique = new Map();

    for (const tile of successful) {
      for (const aircraft of tile) {

        if (
          !aircraft ||
          !aircraft.hex ||
          aircraft.lat == null ||
          aircraft.lon == null
        ) continue;

        const distance = distanceKm(
          lat,
          lon,
          Number(aircraft.lat),
          Number(aircraft.lon)
        );

        if (
          !Number.isFinite(distance) ||
          distance > dist
        ) continue;

        const key = String(aircraft.hex).toLowerCase();
        const existing = unique.get(key);

        const seen = Number(
          aircraft.seen ?? aircraft.seen_pos ?? Infinity
        );

        const existingSeen = existing
          ? Number(existing.seen ?? existing.seen_pos ?? Infinity)
          : Infinity;

        if (!existing || seen < existingSeen) {
          unique.set(key, {
            ...aircraft,
            distanceFromCenterKm:
              Math.round(distance * 10) / 10
          });
        }
      }
    }

    const aircraft = Array.from(unique.values()).sort(
      (a, b) =>
        (Number(a.distanceFromCenterKm) || 0) -
        (Number(b.distanceFromCenterKm) || 0)
    );

    const result = {
      aircraft,
      total: aircraft.length,
      source: "ADSB.lol",
      coverageKm: dist,
      tileRadiusNm: TILE_RADIUS_NM,
      queries: centers.length,
      successfulQueries: successful.length,
      failedQueries,
      partial: failedQueries > 0,
      fetchedAt: new Date().toISOString()
    };

    cache.set(cacheKey, {
      time: Date.now(),
      data: result
    });

    if (cache.size > 30) {
      cache.delete(cache.keys().next().value);
    }

    res.setHeader("Cache-Control", "no-store");
    res.json(result);

  } catch (error) {
    res.status(502).json({
      error: "Could not retrieve flight data",
      detail:
        error.name === "TimeoutError"
          ? "Provider timeout"
          : error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `AZN Flight Radar API running on port ${PORT}`
  );
});
