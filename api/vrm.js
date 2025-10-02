// api/vrm.js
// Robust VDG VehicleDetails lookup.
// Tries multiple request variants (GET + POST) and returns the first success.
// Add &debug=1 to see every attempt (status + short body sample).

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
const SAMPLE_LEN = 800;

async function tryFetch(url, init) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: resp.status, ok: resp.ok, json, text, ct: resp.headers.get('content-type') || '' };
  } catch (e) {
    return { status: 0, ok: false, json: null, text: String(e?.message || e) };
  } finally {
    clearTimeout(to);
  }
}

function mapPayload(plate, data) {
  const r     = data?.results || {};
  const vid   = r?.vehicleDetails?.vehicleIdentification || {};
  const vhist = r?.vehicleDetails?.vehicleHistory || {};
  const mid   = r?.modelDetails?.modelIdentification || {};
  const pwr   = r?.modelDetails?.powertrain || {};

  const year =
    vid?.yearOfManufacture ||
    (typeof vid?.dateOfManufacture === 'string' ? vid.dateOfManufacture.slice(0,4) : '');

  return {
    vrm: plate,
    year: String(year || '').trim(),
    make: String(mid?.make  || vid?.dvlaMake  || '').trim(),
    model:String(mid?.model || vid?.dvlaModel || '').trim(),
    fuelType: String(vid?.dvlaFuelType || pwr?.fuelType || '').trim(),
    colour: String(vhist?.colourDetails?.currentColour || '').trim(),
    variant: String(mid?.modelVariant || '').trim()
  };
}

function success(data) {
  return Boolean(
    data &&
    data.responseInformation &&
    data.responseInformation.isSuccessStatusCode === true &&
    data.results
  );
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCORS(res); return res.status(204).end(); }
  setCORS(res);

  const plate = String(req.query?.vrm || '').trim().toUpperCase();
  const debugMode = req.query?.debug === '1';

  if (!plate) return res.status(400).json({ error: 'Missing vrm' });

  const apiKey = process.env.VDG_API_KEY || '';
  if (!apiKey) {
    return res.status(200).json({
      vrm: plate, error: 'Missing VDG_API_KEY (set it in Vercel env vars)'
    });
  }

  const base = 'https://uk.api.vehicledataglobal.com';
  const attempts = [];

  // --- Build candidate requests (most likely first) ---
  // GET with PascalCase params
  const u1 = new URL(`${base}/r2/lookup`);
  u1.searchParams.set('apiKey', apiKey);
  u1.searchParams.set('packageName', 'VehicleDetails');
  u1.searchParams.set('SearchType', 'Registration');
  u1.searchParams.set('SearchTerm', plate);

  // GET with lower-case params
  const u2 = new URL(`${base}/r2/lookup`);
  u2.searchParams.set('apiKey', apiKey);
  u2.searchParams.set('packageName', 'VehicleDetails');
  u2.searchParams.set('searchType', 'Registration');
  u2.searchParams.set('searchTerm', plate);

  // GET path-variant (seen in some accounts)
  const u3 = new URL(`${base}/r2/lookup/Registration/${encodeURIComponent(plate)}`);
  u3.searchParams.set('apiKey', apiKey);
  u3.searchParams.set('packageName', 'VehicleDetails');

  // POST JSON (body)
  const postJson = {
    url: `${base}/r2/lookup`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        apiKey,
        packageName: 'VehicleDetails',
        searchType: 'Registration',
        searchTerm: plate
      })
    }
  };

  // POST form-encoded (some gateways require this)
  const form = new URLSearchParams();
  form.set('apiKey', apiKey);
  form.set('packageName', 'VehicleDetails');
  form.set('searchType', 'Registration');
  form.set('searchTerm', plate);
  const postForm = {
    url: `${base}/r2/lookup`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString()
    }
  };

  const candidates = [
    { method: 'GET',  url: u1.toString(), init: { headers: { Accept: 'application/json' }, cache: 'no-store' } },
    { method: 'GET',  url: u2.toString(), init: { headers: { Accept: 'application/json' }, cache: 'no-store' } },
    { method: 'GET',  url: u3.toString(), init: { headers: { Accept: 'application/json' }, cache: 'no-store' } },
    { method: 'POST', url: postJson.url,  init: postJson.init },
    { method: 'POST', url: postForm.url,  init: postForm.init }
  ];

  // --- Execute attempts in order ---
  for (const c of candidates) {
    const r = await tryFetch(c.url, c.init);
    attempts.push({
      method: c.method,
      url: c.url.replace(/(apiKey=)[^&]+/, '$1***'),
      status: r.status,
      sample: (r.text || '').slice(0, SAMPLE_LEN)
    });

    if (r.ok && r.json && success(r.json)) {
      const payload = mapPayload(plate, r.json);
      return res.status(200).json(debugMode ? { ...payload, _debug: { attempts } } : payload);
    }
  }

  // Nothing succeeded – return non-breaking with detailed debug
  const empty = { vrm: plate, year:'', make:'', model:'', fuelType:'', colour:'', variant:'' };
  return res.status(200).json(debugMode ? { ...empty, _debug: { attempts } } : { ...empty, error:'Lookup failed' });
}
