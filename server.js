
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

app.get("/", (req, res) => {
  res.json({
    app: "AZN Flight Radar API",
    status: "online"
  });
});

app.get("/api/aircraft", async (req, res) => {
  try {
    const lat = Number(req.query.lat ?? 32);
    const lon = Number(req.query.lon ?? 45);
    const dist = Number(req.query.dist ?? 250);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(dist) ||
      lat < -90 || lat > 90 ||
      lon < -180 || lon > 180 ||
      dist < 1 || dist > 250
    ) {
      return res.status(400).json({ error: "Invalid coordinates or distance" });
    }

    const url =
      `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`;

    const upstream = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(15000)
    });

    if (!upstream.ok) {
      return res.status(502).json({
        error: "Flight data provider error",
        providerStatus: upstream.status
      });
    }

    const data = await upstream.json();
    const aircraft = data.aircraft || data.ac || [];

    res.setHeader("Cache-Control", "no-store");
    res.json({
      aircraft,
      total: aircraft.length,
      source: "ADSB.lol",
      fetchedAt: new Date().toISOString()
    });

  } catch (error) {
    res.status(502).json({
      error: "Could not retrieve flight data",
      detail: error.name === "TimeoutError"
        ? "Provider timeout"
        : error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AZN Flight Radar API running on port ${PORT}`);
});
