// api/vrm.js
// Partsworth VRM lookup (non-breaking).
// Order: DVLA (make/year) -> DVSA (model) -> VDG (variant).
// Always returns 200 with best-effort fields.
// Add &debug=1 to see all provider attempts (status + short sample).

/* ---------------- CORS ---------------- */
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/* ---------------- utils ---------------- */
const SAMPLE_LEN = 800;

function trim(v) { return (v == null ? '' : String(v)).trim(); }
function pick(...vals) { for (const v of vals) { const t = trim(v); if (t) return t; } return ''; }

async function fetchBody(url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: resp.ok, status: resp.status, json, text, ct: resp.headers.get('content-type') || '' };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e?.message || e) };
  } finally {
    clearTimeout(to);
  }
}

function mergePayload(base, add) {
  const out = { ...base };
  for (const k of ['year','make','model','fuelType','colour','variant']) {
    if (!trim(out[k]) && trim(add[k])) out[k] = trim(add[k]);
  }
  return out;
}

/* ---------------- mappers ---------------- */
// DVLA (UK VES) common response: POST /vehicle-enquiry/v1/vehicles {registrationNumber}
// fields vary; we pull make + year (and fuel/colour if present)
function mapDVLA(j) {
  const src = j?.data || j || {};
  const year = pick(src.yearOfManufacture, src.year);
  return {
    year,
    make: pick(src.make, src.dvlaMake),
    model: pick(src.model, src.dvlaModel),
    fuelType: pick(src.fuelType, src.dvlaFuelType),
    colour: pick(src.colour, src.color),
    variant: ''
  };
}

// DVSA legacy MOT API (x-api-key). We only need model (but map extras if present)
function mapDVSA_Legacy(j) {
  // legacy endpoint returns an array of tests or vehicles; pull first vehicle-level fields
  const arr = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : []);
  const first = arr[0] || {};
  const vehicle = first?.vehicle || first || {};
  return {
    year: pick(vehicle.year, vehicle.firstUsedDate?.slice?.(0,4)),
    make: pick(vehicle.make),
    model: pick(vehicle.model),
    fuelType: pick(vehicle.fuelType),
    colour: pick(vehicle.colour),
    variant: pick(vehicle.derivative, vehicle.trim)
  };
}

// DVSA TAPI (OAuth). Shape varies by endpoint; we still just try to extract model.
function mapDVSA_TAPI(j) {
  const v = j?.vehicle || j?.data || j || {};
  return {
    year: pick(v.year, v.firstRegistrationYear),
    make: pick(v.make),
    model: pick(v.model),
    fuelType: pick(v.fuelType),
    colour: pick(v.colour),
    variant: pick(v.derivative, v.trim)
  };
}

// VDG r2/lookup VehicleDetails → modelDetails.modelIdentification.modelVariant
function mapVDG(j) {
  const r = j?.results || {};
  const vid   = r?.vehicleDetails?.vehicleIdentification || {};
  const vhist = r?.vehicleDetails?.vehicleHistory || {};
  const mid   = r?.modelDetails?.modelIdentification || {};
  const pwr   = r?.modelDetails?.powertrain || {};

  const year =
    vid?.yearOfManufacture ||
    (typeof vid?.dateOfManufacture === 'string' ? vid.dateOfManufacture.slice(0,4) : '');

  return {
    year: trim(year),
    make: pick(mid?.make, vid?.dvlaMake),
    model: pick(mid?.model, vid?.dvlaModel),
    fuelType: pick(vid?.dvlaFuelType, pwr?.fuelType),
    colour: pick(vhist?.colourDetails?.currentColour),
    variant: pick(mid?.modelVariant)
  };
}

/* ---------------- providers ---------------- */
async function tryDVLA(vrm, attempts) {
  // Default to official DVLA VES endpoint; override with DVLA_API_URL if you use your proxy
  const dvlaUrl = process.env.DVLA_API_URL || 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
  const dvlaKey = process.env.DVLA_API_KEY;
  if (!dvlaUrl || !dvlaKey) return null;

  const { ok, status, json, text } = await fetchBody(dvlaUrl, {
    method: 'POST',
    headers: { 'x-api-key': dvlaKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ registrationNumber: vrm })
  });

  attempts.push({ provider: 'DVLA', url: dvlaUrl, status, sample: text.slice(0, SAMPLE_LEN) });
  if (!ok || !json) return null;

  return mapDVLA(json);
}

async function tryDVSA_Legacy(vrm, attempts) {
  // Legacy API-key MOT endpoint
  const dvsaKey = process.env.DVSA_API_KEY;
  const dvsaLegacyBase = process.env.DVSA_API_URL || 'https://beta.check-mot.service.gov.uk/trade/vehicles/mot-tests';
  if (!dvsaKey || !dvsaLegacyBase) return null;

  const u = new URL(dvsaLegacyBase);
  u.searchParams.set('registration', vrm);

  const { ok, status, json, text } = await fetchBody(u.toString(), {
    method: 'GET',
    headers: { 'x-api-key': dvsaKey, 'Accept': 'application/json' }
  });

  attempts.push({ provider: 'DVSA-legacy', url: u.toString(), status, sample: text.slice(0, SAMPLE_LEN) });
  if (!ok || !json) return null;

  return mapDVSA_Legacy(json);
}

async function tryDVSA_TAPI(vrm, attempts) {
  // Optional OAuth client-credentials flow (if/when you add a TAPI URL)
  const tokenUrl = process.env.DVSA_TOKEN_URL;
  const clientId = process.env.DVSA_CLIENT_ID;
  const clientSecret = process.env.DVSA_CLIENT_SECRET;
  const scope = process.env.DVSA_SCOPE_URL;
  const apiUrl = process.env.DVSA_TAPI_URL; // <- optional; if not set, skip TAPI

  if (!tokenUrl || !clientId || !clientSecret || !scope || !apiUrl) return null;

  // Get access token
  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  form.set('client_id', clientId);
  form.set('client_secret', clientSecret);
  form.set('scope', scope);

  const tokenRes = await fetchBody(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });

  attempts.push({ provider: 'DVSA-token', url: tokenUrl, status: tokenRes.status, sample: tokenRes.text.slice(0, SAMPLE_LEN) });
  const accessToken = tokenRes.json?.access_token;
  if (!accessToken) return null;

  const u = new URL(apiUrl);
  u.searchParams.set('vrm', vrm);

  const { ok, status, json, text } = await fetchBody(u.toString(), {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
  });

  attempts.push({ provider: 'DVSA-TAPI', url: u.toString(), status, sample: text.slice(0, SAMPLE_LEN) });
  if (!ok || !json) return null;

  return mapDVSA_TAPI(json);
}

async function tryVDG(vrm, attempts) {
  const base = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
  const key = process.env.VDG_API_KEY;
  const pkg = process.env.VDG_PACKAGE || 'VehicleDetails';
  if (!key) return null;

  const endpoint = `${base}/r2/lookup`;
  const body = { apiKey: key, packageName: pkg, searchType: 'Registration', searchTerm: vrm };

  const { ok, status, json, text } = await fetchBody(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });

  attempts.push({ provider: 'VDG', url: endpoint, status, sample: text.slice(0, SAMPLE_LEN) });
  if (!ok || !json || json?.responseInformation?.isSuccessStatusCode !== true) return null;

  return mapVDG(json);
}

/* ---------------- route ---------------- */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCORS(res); return res.status(204).end(); }
  setCORS(res);

  try {
    const plate = String(req.query?.vrm || '').trim().toUpperCase();
    const debugMode = req.query?.debug === '1';
    if (!plate) return res.status(400).json({ error: 'Missing vrm' });

    // Base payload schema for Shopify
    let payload = { vrm: plate, year:'', make:'', model:'', fuelType:'', colour:'', variant:'' };
    const attempts = [];

    // 1) DVLA (year+make)
    const dvla = await tryDVLA(plate, attempts);
    if (dvla) payload = mergePayload(payload, dvla);

    // 2) DVSA legacy (model); else try TAPI if configured
    const dvsaLegacy = await tryDVSA_Legacy(plate, attempts);
    if (dvsaLegacy) payload = mergePayload(payload, dvsaLegacy);
    else {
      const dvsaTapi = await tryDVSA_TAPI(plate, attempts);
      if (dvsaTapi) payload = mergePayload(payload, dvsaTapi);
    }

    // 3) VDG (variant)
    const vdg = await tryVDG(plate, attempts);
    if (vdg) payload = mergePayload(payload, vdg);

    // UX fallback if variant still empty
    if (!trim(payload.variant)) {
      const composed = [payload.year, payload.make, payload.model, payload.fuelType].filter(Boolean).join(' ');
      if (composed) payload.variant = composed;
    }

    if (debugMode) return res.status(200).json({ ...payload, _debug: { attempts } });
    return res.status(200).json(payload);

  } catch {
    // Non-breaking fallback
    return res.status(200).json({
      vrm: String(req.query?.vrm || '').toUpperCase(),
      year:'', make:'', model:'', fuelType:'', colour:'', variant:'',
      note:'Minimal return due to server error'
    });
  }
}
