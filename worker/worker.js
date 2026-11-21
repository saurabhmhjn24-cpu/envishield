/**
 * Cloudflare Worker: weather proxy (Ambient Weather + AccuWeather)
 *
 * Purpose: keep all weather-provider credentials OUT of the browser entirely.
 * This worker holds them as encrypted secrets, makes the real calls
 * server-side, and returns only the two numbers the heat-stress chart
 * needs: temp_c and rh.
 *
 * Routes:
 *   GET /            -> Ambient Weather station reading (uses AMBIENT_MAC / AMBIENT_API_KEY / AMBIENT_APP_KEY)
 *   GET /accuweather?lat=..&lon=..  -> AccuWeather current conditions for that location (uses ACCUWEATHER_API_KEY)
 *   GET /aqi?lat=..&lon=..          -> nearest CPCB station within 10 km, with an Indian AQI ESTIMATED from the
 *                                      latest hourly pollutant readings (uses DATA_GOV_IN_API_KEY). Returns {} when
 *                                      no station qualifies, so the web page falls back to its model estimate.
 *
 * Deploy this once. The keys never appear in GitHub, in the HTML page,
 * or in anything a visitor's browser downloads.
 */

export default {
  async fetch(request, env, ctx) {
    const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || 'https://yourusername.github.io';

    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/accuweather') {
        return await handleAccuWeather(url, env, corsHeaders);
      }
      if (url.pathname === '/aqi') {
        return await handleAqi(url, env, ctx, corsHeaders);
      }
      const endDateParam = url.searchParams.get('endDate'); // ms epoch, optional — historical lookup
      return await handleAmbient(env, corsHeaders, endDateParam, url.searchParams.get('debug') === '1');
    } catch (err) {
      return jsonResponse({ error: 'Unexpected proxy error: ' + err.message }, 500, corsHeaders);
    }
  },
};

// ================== Ambient Weather ==================
async function handleAmbient(env, corsHeaders, endDateParam, debug) {
  const { AMBIENT_MAC, AMBIENT_API_KEY, AMBIENT_APP_KEY } = env;

  if (!AMBIENT_MAC || !AMBIENT_API_KEY || !AMBIENT_APP_KEY) {
    return jsonResponse(
      { error: 'Worker is missing configured secrets. Run: wrangler secret put AMBIENT_MAC (and API_KEY / APP_KEY).' },
      500,
      corsHeaders
    );
  }

  if (endDateParam) {
    // Historical lookup: the devices LIST endpoint only ever returns the single
    // latest reading, so history requires the per-device endpoint with endDate.
    const histUrl = `https://api.ambientweather.net/v1/devices/${encodeURIComponent(AMBIENT_MAC)}` +
                     `?apiKey=${encodeURIComponent(AMBIENT_API_KEY)}` +
                     `&applicationKey=${encodeURIComponent(AMBIENT_APP_KEY)}` +
                     `&limit=1&endDate=${encodeURIComponent(endDateParam)}`;

    const histRes = await fetch(histUrl);

    if (!histRes.ok) {
      return jsonResponse({ error: `Ambient Weather historical request failed (${histRes.status})` }, 502, corsHeaders);
    }

    const histArr = await histRes.json();

    if (!Array.isArray(histArr) || histArr.length === 0) {
      return jsonResponse({ error: 'Ambient Weather returned no historical data near that date/time.' }, 502, corsHeaders);
    }

    const hd = histArr[0];
    const histTempF = hd.tempf;
    const histRh = hd.humidity;

    if (histTempF === undefined || histRh === undefined) {
      return jsonResponse({ error: 'Ambient Weather historical payload missing temperature/humidity fields.' }, 502, corsHeaders);
    }

    return jsonResponse({
      temp_c: Math.round(((histTempF - 32) * 5 / 9) * 100) / 100,
      rh: Math.round(histRh * 100) / 100,
      observed_at: hd.dateutc ? new Date(hd.dateutc).toISOString() : new Date(Number(endDateParam)).toISOString(),
      ...extraReadings(hd),
      ...(debug ? { fields_present: Object.keys(hd).sort() } : {}),
    }, 200, corsHeaders);
  }

  // Use the devices LIST endpoint (not /devices/{mac}) — it reliably returns
  // each device's latest reading in "lastData", and the single-device endpoint
  // has been seen to return an empty result for some accounts even with a
  // correct MAC address. Listing + matching is more robust.
  const listUrl = `https://api.ambientweather.net/v1/devices` +
              `?apiKey=${encodeURIComponent(AMBIENT_API_KEY)}` +
              `&applicationKey=${encodeURIComponent(AMBIENT_APP_KEY)}`;

  const upstream = await fetch(listUrl);

  if (!upstream.ok) {
    return jsonResponse({ error: `Ambient Weather request failed (${upstream.status})` }, 502, corsHeaders);
  }

  const devices = await upstream.json();

  if (!Array.isArray(devices) || devices.length === 0) {
    return jsonResponse({ error: 'Ambient Weather returned no devices for this account.' }, 502, corsHeaders);
  }

  const device = devices.find(
    dev => (dev.macAddress || '').toUpperCase() === AMBIENT_MAC.toUpperCase()
  );

  if (!device) {
    return jsonResponse(
      { error: `No device with MAC ${AMBIENT_MAC} found on this account. Devices seen: ` +
               devices.map(d => d.macAddress).join(', ') },
      502,
      corsHeaders
    );
  }

  const d = device.lastData || {};
  const tempF = d.tempf;
  const rh = d.humidity;

  if (tempF === undefined || rh === undefined) {
    return jsonResponse({ error: 'Ambient Weather payload missing temperature/humidity fields.' }, 502, corsHeaders);
  }

  const payload = {
    temp_c: Math.round(((tempF - 32) * 5 / 9) * 100) / 100,
    rh: Math.round(rh * 100) / 100,
    observed_at: d.dateutc ? new Date(d.dateutc).toISOString() : new Date().toISOString(),
    ...extraReadings(d),
    ...(debug ? { fields_present: Object.keys(d).sort() } : {}),
  };

  return jsonResponse(payload, 200, corsHeaders);
}

// Extra station readings converted to metric. Each is included only when the station reports it,
// so the response stays valid for stations without that sensor. Ambient Weather leaves a key out of
// "lastData" when that sensor did not report, so a missing value means "no reading", not zero.
//   wind_kmh / gust_kmh : wind speed and gust (station reports mph)
//   uv                  : UV index
//   pressure_hpa        : relative barometric pressure (station reports inHg)
//   sensors             : which of wind / uv were present in this record
//   proxy_version       : 2 = this proxy passes wind and UV; the web page uses it to tell an
//                         out-of-date proxy from a silent sensor.
function num(v) {
  const x = (typeof v === 'string' && v.trim() !== '') ? Number(v) : v;   // some consoles send numbers as text
  return Number.isFinite(x) ? x : null;
}
function extraReadings(d) {
  const round1 = (v) => Math.round(v * 10) / 10;
  const out = { proxy_version: 2 };
  // Wind: the live reading, otherwise the 2- or 10-minute average some consoles report instead.
  const windMph = [d.windspeedmph, d.windspdmph_avg2m, d.windspdmph_avg10m].map(num).find(v => v !== null);
  const gustMph = num(d.windgustmph);
  const uv = num(d.uv);
  const baro = num(d.baromrelin);
  if (windMph !== undefined && windMph >= 0) out.wind_kmh = round1(windMph * 1.609344);
  if (gustMph !== null && gustMph >= 0) out.gust_kmh = round1(gustMph * 1.609344);
  if (uv !== null && uv >= 0) out.uv = uv;
  if (baro !== null && baro > 0) out.pressure_hpa = round1(baro * 33.8639);
  out.sensors = { wind: out.wind_kmh !== undefined, uv: out.uv !== undefined };
  return out;
}

// ================== AccuWeather ==================
async function handleAccuWeather(url, env, corsHeaders) {
  const { ACCUWEATHER_API_KEY } = env;

  if (!ACCUWEATHER_API_KEY) {
    return jsonResponse(
      { error: 'Worker is missing configured secret. Run: wrangler secret put ACCUWEATHER_API_KEY.' },
      500,
      corsHeaders
    );
  }

  const lat = url.searchParams.get('lat');
  const lon = url.searchParams.get('lon');

  if (!lat || !lon) {
    return jsonResponse({ error: 'Missing lat/lon query parameters.' }, 400, corsHeaders);
  }

  // Step 1: resolve coordinates to an AccuWeather "location key".
  // This is a separate call because AccuWeather's current-conditions endpoint
  // is keyed by their own internal location ID, not raw coordinates.
  const geoUrl = `https://dataservice.accuweather.com/locations/v1/cities/geoposition/search` +
                 `?apikey=${encodeURIComponent(ACCUWEATHER_API_KEY)}` +
                 `&q=${encodeURIComponent(lat)},${encodeURIComponent(lon)}`;

  const geoRes = await fetch(geoUrl);

  if (!geoRes.ok) {
    return jsonResponse({ error: `AccuWeather location lookup failed (${geoRes.status})` }, 502, corsHeaders);
  }

  const geoData = await geoRes.json();
  const locationKey = geoData && geoData.Key;

  if (!locationKey) {
    return jsonResponse({ error: 'AccuWeather did not return a location key for these coordinates.' }, 502, corsHeaders);
  }

  // Step 2: fetch current conditions for that location key.
  // details=true is required for RelativeHumidity to be included in the response.
  const condUrl = `https://dataservice.accuweather.com/currentconditions/v1/${encodeURIComponent(locationKey)}` +
                  `?apikey=${encodeURIComponent(ACCUWEATHER_API_KEY)}&details=true`;

  const condRes = await fetch(condUrl);

  if (!condRes.ok) {
    return jsonResponse({ error: `AccuWeather current-conditions request failed (${condRes.status})` }, 502, corsHeaders);
  }

  const condData = await condRes.json();
  const current = Array.isArray(condData) ? condData[0] : null;

  if (!current || !current.Temperature || !current.Temperature.Metric) {
    return jsonResponse({ error: 'AccuWeather response missing temperature data.' }, 502, corsHeaders);
  }

  const temp_c = current.Temperature.Metric.Value;
  const rh = current.RelativeHumidity;

  if (temp_c === undefined || rh === undefined) {
    return jsonResponse({ error: 'AccuWeather payload missing temperature/humidity fields.' }, 502, corsHeaders);
  }

  const payload = {
    temp_c: Math.round(temp_c * 100) / 100,
    rh: Math.round(rh * 100) / 100,
    observed_at: current.LocalObservationDateTime
      ? new Date(current.LocalObservationDateTime).toISOString()
      : new Date().toISOString(),
  };

  return jsonResponse(payload, 200, corsHeaders);
}

// ================== CPCB station AQI (data.gov.in) ==================
// Source: "Real time Air Quality Index from various locations" (CPCB, via data.gov.in).
// The feed gives the LATEST HOURLY pollutant values per station, not CPCB's official 24-hour-average AQI,
// so the number returned here is an ESTIMATE from CPCB station readings and is labelled that way in the page.
const AQI_RESOURCE_ID = '3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69';
const AQI_MAX_KM = 10;               // only stations this close are returned
const AQI_MAX_AGE_MS = 3 * 3600000;  // readings older than this are ignored
const AQI_CACHE_SECONDS = 900;       // the feed updates hourly; cache the grouped result for 15 minutes
const AQI_PAGE = 1000;
const AQI_MAX_PAGES = 6;

// [concentration low, concentration high, AQI low, AQI high] - same tables as the web page. CO is in mg/m3.
const AQI_BP = {
  pm25: [[0,30,0,50],[31,60,51,100],[61,90,101,200],[91,120,201,300],[121,250,301,400],[251,380,401,500]],
  pm10: [[0,50,0,50],[51,100,51,100],[101,250,101,200],[251,350,201,300],[351,430,301,400],[431,510,401,500]],
  no2:  [[0,40,0,50],[41,80,51,100],[81,180,101,200],[181,280,201,300],[281,400,301,400],[401,500,401,500]],
  so2:  [[0,40,0,50],[41,80,51,100],[81,380,101,200],[381,800,201,300],[801,1600,301,400],[1601,2100,401,500]],
  co:   [[0,1.0,0,50],[1.1,2.0,51,100],[2.1,10,101,200],[10.1,17,201,300],[17.1,34,301,400],[34.1,50,401,500]],
  o3:   [[0,50,0,50],[51,100,51,100],[101,168,101,200],[169,208,201,300],[209,748,301,400],[749,1000,401,500]],
};

function aqiPollutantKey(id) {
  const k = String(id || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (k === 'PM25') return 'pm25';
  if (k === 'PM10') return 'pm10';
  if (k === 'NO2') return 'no2';
  if (k === 'SO2') return 'so2';
  // CO is deliberately left out: the feed's CO values (for example 97 or 114 in Delhi) are not in the mg/m3 the
  // breakpoint table needs and the unit is undocumented, so using them would wrongly push stations to AQI 500.
  if (k === 'OZONE' || k === 'O3') return 'o3';
  return null;   // NH3 and others have no part in the overall AQI used here
}

function aqiSubIndex(conc, table) {
  if (!Number.isFinite(conc) || conc < 0) return null;
  for (const [cLow, cHigh, iLow, iHigh] of table) {
    if (conc <= cHigh) {
      const c = Math.max(conc, cLow);   // readings that fall in the small gaps between bands take the band's lower edge
      return iLow + ((iHigh - iLow) / (cHigh - cLow)) * (c - cLow);
    }
  }
  return 500;   // above the highest breakpoint: capped at the Severe ceiling
}

// data.gov.in "last_update" looks like "19-11-2026 14:00:00" in Indian Standard Time.
function parseLastUpdate(text) {
  const m = /^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text || '').trim());
  if (!m) return null;
  const t = Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6] || '00'}+05:30`);
  return Number.isFinite(t) ? t : null;
}

function aqiKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dl = (lat2 - lat1) * rad, dn = (lon2 - lon1) * rad;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dn / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Group the feed's one-row-per-pollutant records into one entry per station and estimate its AQI.
// Rules mirror the web page: at least three pollutants, one of them PM2.5 or PM10.
// The AQI is the highest pollutant sub-index, from the hourly average value ("NA" values are skipped).
function buildStations(records, now) {
  const byStation = new Map();
  for (const r of records) {
    const lat = Number(r.latitude), lon = Number(r.longitude);
    const key = aqiPollutantKey(r.pollutant_id);
    const t = parseLastUpdate(r.last_update);
    // The live feed names the hourly average "avg_value" (the field list calls it pollutant_avg), so accept both.
    const rawAvg = r.avg_value !== undefined ? r.avg_value : r.pollutant_avg;
    const avg = Number(rawAvg);   // "NA" becomes NaN and is skipped
    if (!key || !r.station || !Number.isFinite(lat) || !Number.isFinite(lon) || t === null) continue;
    if (!Number.isFinite(avg) || String(rawAvg).trim() === '') continue;
    if (now - t > AQI_MAX_AGE_MS || t - now > 5 * 60000) continue;
    const id = `${r.station}|${lat}|${lon}`;
    let s = byStation.get(id);
    if (!s) { s = { station: String(r.station).trim(), city: r.city, state: r.state, lat, lon, t, conc: {} }; byStation.set(id, s); }
    s.t = Math.min(s.t, t);   // the station's reading is only as fresh as its oldest pollutant
    s.conc[key] = avg;   // data.gov.in reports CO in mg/m3 and the rest in ug/m3, matching the tables
  }
  const out = [];
  for (const s of byStation.values()) {
    const keys = Object.keys(s.conc);
    if (keys.length < 3 || !(keys.includes('pm25') || keys.includes('pm10'))) continue;
    let best = null, bestKey = null;
    for (const k of keys) {
      const si = aqiSubIndex(s.conc[k], AQI_BP[k]);
      if (si !== null && (best === null || si > best)) { best = si; bestKey = k; }
    }
    if (best === null) continue;
    out.push({ ...s, aqi: Math.round(best), pollutant: bestKey });
  }
  return out;
}

// data.gov.in sometimes answers 5xx (for example 521) for a moment; try each request up to three times.
async function fetchWithRetry(url) {
  let res;
  for (let i = 0; i < 3; i++) {
    try {
      res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; EnviShield/1.0)' } });
      if (res.ok || res.status < 500) return res;
    } catch (e) { if (i === 2) throw e; }
    await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  return res;
}

async function loadAqiRecords(env) {
  const base = `https://api.data.gov.in/resource/${AQI_RESOURCE_ID}?api-key=${encodeURIComponent(env.DATA_GOV_IN_API_KEY)}&format=json&limit=${AQI_PAGE}`;
  const first = await fetchWithRetry(`${base}&offset=0`);
  if (!first.ok) throw new Error(`data.gov.in request failed (${first.status})`);
  const firstJson = await first.json();
  let records = Array.isArray(firstJson.records) ? firstJson.records.slice() : [];
  const total = Number(firstJson.total) || records.length;
  const pages = Math.min(AQI_MAX_PAGES, Math.ceil(total / AQI_PAGE));
  const rest = [];
  for (let p = 1; p < pages; p++) rest.push(fetchWithRetry(`${base}&offset=${p * AQI_PAGE}`));
  let missing = 0;
  for (const res of await Promise.all(rest)) {
    if (!res.ok) { missing++; continue; }   // a missing page only costs some stations, never a wrong number
    try {
      const j = await res.json();
      if (Array.isArray(j.records)) records = records.concat(j.records); else missing++;
    } catch (e) { missing++; }
  }
  records.incomplete = missing > 0;   // the caller must not read "no station nearby" as certain when pages are missing
  return records;
}

async function handleAqi(url, env, ctx, corsHeaders) {
  if (!env.DATA_GOV_IN_API_KEY) {
    return jsonResponse({ error: 'Worker is missing configured secret. Run: wrangler secret put DATA_GOV_IN_API_KEY.' }, 500, corsHeaders);
  }
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return jsonResponse({ error: 'Missing or invalid lat/lon query parameters.' }, 400, corsHeaders);
  }

  // ?debug=1: skip the cache and report what the feed contained near this location and why stations were kept or dropped.
  if (url.searchParams.get('debug') === '1') {
    let records;
    try { records = await loadAqiRecords(env); }
    catch (err) { return jsonResponse({ error: 'CPCB data service unavailable: ' + err.message }, 502, corsHeaders); }
    const now0 = Date.now();
    const built = buildStations(records, now0);
    const byName = new Map();
    for (const r of records) {
      const la = Number(r.latitude), lo = Number(r.longitude);
      if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
      const d = aqiKm(lat, lon, la, lo);
      if (d > 25) continue;
      const k = r.station;
      if (!byName.has(k)) byName.set(k, { station: k, km: Math.round(d * 10) / 10, last_update: r.last_update, pollutants: {} });
      const rawAvg = r.avg_value !== undefined ? r.avg_value : r.pollutant_avg;
      byName.get(k).pollutants[r.pollutant_id] = rawAvg;
      if (r.last_update !== byName.get(k).last_update) byName.get(k).last_update += ' / ' + r.last_update;
    }
    return jsonResponse({
      records_loaded: records.length,
      stations_usable_anywhere: built.length,
      server_time_utc: new Date(now0).toISOString(),
      within_25km_raw: [...byName.values()].sort((a, b) => a.km - b.km).slice(0, 12),
    }, 200, corsHeaders);
  }

  // Cache the grouped station list (not the per-location answer) so many locations share one upstream fetch.
  const cache = (typeof caches !== 'undefined') ? caches.default : null;
  const cacheKey = new Request('https://aqi-cache.internal/stations-v3');
  let stations = null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) { try { stations = await hit.json(); } catch (e) { stations = null; } }
  }
  let incomplete = false;
  // Per-instance memory cache: workers.dev does not provide the Cache API, so this is what limits upstream calls.
  const mem = globalThis.__aqiMem;
  if (!stations && mem && Date.now() - mem.at < AQI_CACHE_SECONDS * 1000) stations = mem.stations;
  if (!stations) {
    let records;
    try { records = await loadAqiRecords(env); }
    catch (err) {
      // Upstream is down: a recent list (up to 3 hours old, re-checked below) is still better than nothing.
      if (mem && mem.stations) stations = mem.stations;
      else return jsonResponse({ error: 'CPCB data service unavailable: ' + err.message }, 502, corsHeaders);
    }
    if (records) {
      incomplete = !!records.incomplete;
      stations = buildStations(records, Date.now());
      if (!incomplete && stations.length) globalThis.__aqiMem = { at: Date.now(), stations };
    }
    if (records && cache && !incomplete && stations.length) {
      const put = cache.put(cacheKey, new Response(JSON.stringify(stations), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${AQI_CACHE_SECONDS}` },
      }));
      if (ctx && ctx.waitUntil) ctx.waitUntil(put);
    }
  }

  // A cached list can be up to 15 minutes old, so re-check the age limit at request time.
  const now = Date.now();
  const near = stations
    .filter(s => now - s.t <= AQI_MAX_AGE_MS)
    .map(s => ({ s, d: aqiKm(lat, lon, s.lat, s.lon) }))
    .filter(x => x.d <= AQI_MAX_KM)
    .sort((a, b) => a.d - b.d)[0];

  if (!near) {
    // Missing pages mean "unknown", not "no station": report it as an error so nothing is cached as empty.
    if (incomplete) return jsonResponse({ error: 'CPCB data service returned incomplete data' }, 502, corsHeaders);
    return jsonResponse({}, 200, corsHeaders);   // no eligible station: the page uses its model estimate
  }
  const s = near.s;
  return jsonResponse({
    aqi: s.aqi,
    station: s.station,
    lat: s.lat,
    lon: s.lon,
    observed_at: new Date(s.t).toISOString(),
    distance_km: Math.round(near.d * 10) / 10,
    pollutant: s.pollutant,
    basis: 'hourly',   // estimated from the latest hourly readings, not the official 24-hour-average AQI
  }, 200, corsHeaders);
}

function jsonResponse(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}
