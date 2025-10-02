// api/vrm.js
// Partsworth VRM lookup – no fake variants.
// Sources:
//   DVLA  -> make, year, (fuel/colour if present)
//   DVSA  -> model, (derivative/trim if present)  [legacy API-key; optional TAPI OAuth]
//   VDG   -> variant (modelDetails.modelIdentification.modelVariant)
// Behaviour:
//   - Returns 200 always with best-effort fields
//   - "variant" ONLY from VDG or DVSA (never composed)
//   - &debug=1 shows all attempts (status + short sample)

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const SAMPLE_LEN = 800;

const t = (v) => (v == null ? '' : String(v)).trim();
const pick = (...vals) => { for (const v of vals) { const s = t(v); if (s) return s; } return ''; };

async function fetchBody(url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: resp.ok, status: resp.status, json, text, ct: resp.headers.get('content-type') || '' };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e?.message || e) };
  } finally {
    clearTimeout(to);
  }
}

function mergeBase(base, add) {
  const out = { ...base };
  for (const k of ['year','make','model','fuelType','colour']) {
    if (!t(out[k]) && t(add[k])) out[k] = t(add[k]);
  }
  // variant handled separately: we NEVER compose it
  if (!t(out.variant) && t(add.variant)) out.variant = t(add.variant);
  return out;
}

/* ---------- MAPPERS ---------- */
function mapDVLA(j) {
  const src = j?.data || j || {};
  return {
    year: pick(src.yearOfManufacture, src.year),
    make: pick(src.make, src.dvlaMake),
    model: pick(src.model, src.dvlaModel),
    fuelType: pick(src.fuelType, src.dvlaFuelType),
    colour: pick(src.colour, src.color),
    variant: '' // DVLA doesn't provide true variant
  };
}
function mapDVSA_Legacy(j) {
  const arr = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : []);
  const first = arr[0] || {};
  const v = first?.vehicle || first || {};
  return {
    year: pick(v.year, v.firstUsedDate?.slice?.(0,4)),
    make: pick(v.make),
    model: pick(v.model),
    fuelType: pick(v.fuelType),
    colour: pick(v.colour),
    variant: pick(v.derivative, v.trim) // MAYBE present
  };
}
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
function mapVDG(j) {
  const r   = j?.results || {};
  const vid = r?.vehicleDetails?.vehicleIdentification || {};
  const vhist = r?.vehicleDetails?.vehicleHistory || {};
  const mid = r?.modelDetails?.modelIdentification || {};
  const pwr = r?.modelDetails?.powertrain || {};

  const year = pick(vid?.yearOfManufacture,
                    typeof vid?.dateOfManufacture === 'string' ? vid.dateOfManufacture.slice(0,4) : '');

  return {
    year: t(year),
    make: pick(mid?.make,  vid?.dvlaMake),
    model: pick(mid?.model, vid?.dvlaModel),
    fuelType: pick(vid?.dvlaFuelType, pwr?.fuelType),
    colour: pick(vhist?.colourDetails?.currentColour),
    variant: t(mid?.modelVariant) // ONLY source we trust for variant
  };
}

/* ---------- PROVIDERS ---------- */
async function tryDVLA(vrm, attempts) {
  const url = process.env.DVLA_API_URL || 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
  const key = process.env.DVLA_API_KEY;
  if (!url || !key) return null;

  const r = await fetchBody(url, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ registrationNumber: vrm })
  });
  attempts.push({ provider: 'DVLA', url, status: r.status, sample: (r.text || '').slice(0, SAMPLE_LEN) });
  if (!r.ok || !r.json) return null;
  return mapDVLA(r.json);
}

async function tryDVSA_Legacy(vrm, attempts) {
  const key = process.env.DVSA_API_KEY;
  const base = process.env.DVSA_API_URL || 'https://beta.check-mot.service.gov.uk/trade/vehicles/mot-tests';
  if (!key || !base) return null;

  const u = new URL(base);
  u.searchParams.set('registration', vrm);

  const r = await fetchBody(u.toString(), {
    method: 'GET',
    headers: { 'x-api-key': key, 'Accept': 'application/json' }
  });
  attempts.push({ provider: 'DVSA-legacy', url: u.toString(), status: r.status, sample: (r.text || '').slice(0, SAMPLE_LEN) });
  if (!r.ok || !r.json) return null;
  return mapDVSA_Legacy(r.json);
}

async function tryDVSA_TAPI(vrm, attempts) {
  const tokenUrl = process.env.DVSA_TOKEN_URL;
  const clientId = process.env.DVSA_CLIENT_ID;
  const clientSecret = process.env.DVSA_CLIENT_SECRET;
  const scope = process.env.DVSA_SCOPE_URL;
  const apiUrl = process.env.DVSA_TAPI_URL; // set this if you're using TAPI

  if (!tokenUrl || !clientId || !clientSecret || !scope || !apiUrl) return null;

  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  form.set('client_id', clientId);
  form.set('client_secret', clientSecret);
  form.set('scope', scope);

  const tok = await fetchBody(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  attempts.push({ provider: 'DVSA-token', url: tokenUrl, status: tok.status, sample: (tok.text || '').slice(0, SAMPLE_LEN) });
  const accessToken = tok.json?.access_token;
  if (!accessToken) return null;

  const u = new URL(apiUrl);
  u.searchParams.set('vrm', vrm);

  const r = await fetchBody(u.toString(), {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
  });
  attempts.push({ provider: 'DVSA-TAPI', url: u.toString(), status: r.status, sample: (r.text || '').slice(0, SAMPLE_LEN) });
  if (!r.ok || !r.json) return null;
  return mapDVSA_TAPI(r.json);
}

function vdgSuccess(j) {
  return Boolean(j?.responseInformation?.isSuccessStatusCode === true && j?.results);
}

async function tryVDG(vrm, attempts) {
  const base = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
  const key = process.env.VDG_API_KEY;
  const pkg = process.env.VDG_PACKAGE || 'VehicleDetails';
  if (!key) return null;

  // Try POST JSON first
  const url = `${base}/r2/lookup`;
  const body = { apiKey: key, packageName: pkg, searchType: 'Registration', searchTerm: vrm };

  let r = await fetchBody(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  attempts.push({ provider: 'VDG', method: 'POST', url, status: r.status, sample: (r.text || '').slice(0, SAMPLE_LEN) });
  if (r.ok && r.json && vdgSuccess(r.json)) return mapVDG(r.json);

  // Fallback: GET with PascalCase query params
  const u = new URL(url);
  u.searchParams.set('apiKey', key);
  u.searchParams.set('packageName', pkg);
  u.searchParams.set('SearchType', 'Registration');
  u.searchParams.set('SearchTerm', vrm);

  r = await fetchBody(u.toString(), { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' });
  attempts.push({ provider: 'VDG', method: 'GET', url: u.toString().replace(/(apiKey=)[^&]+/, '$1***'), status: r.status, sample: (r.text || '').slice(0, SAMPLE_LEN) });
  if (r.ok && r.json && vdgSuccess(r.json)) return mapVDG(r.json);

  return null;
}

/* ---------- ROUTE ---------- */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCORS(res); return res.status(204).end(); }
  setCORS(res);

  try {
    const plate = t(req.query?.vrm || '').toUpperCase();
    const debugMode = req.query?.debug === '1';
    if (!plate) return res.status(400).json({ error: 'Missing vrm' });

    let payload = { vrm: plate, year:'', make:'', model:'', fuelType:'', colour:'', variant:'' };
    const attempts = [];

    // 1) DVLA
    const dvla = await tryDVLA(plate, attempts);
    if (dvla) payload = mergeBase(payload, dvla);

    // 2) DVSA legacy -> TAPI
    const dvsaLegacy = await tryDVSA_Legacy(plate, attempts);
    if (dvsaLegacy) payload = mergeBase(payload, dvsaLegacy);
    else {
      const dvsaTapi = await tryDVSA_TAPI(plate, attempts);
      if (dvsaTapi) payload = mergeBase(payload, dvsaTapi);
    }

    // 3) VDG (variant)
    const vdg = await tryVDG(plate, attempts);
    if (vdg) payload = mergeBase(payload, vdg);

    // IMPORTANT: DO NOT compose "variant". Leave empty if none found.
    // (No change here — we intentionally avoid making up a variant.)

    if (debugMode) return res.status(200).json({ ...payload, _debug: { attempts } });
    return res.status(200).json(payload);

  } catch {
    return res.status(200).json({
      vrm: t(req.query?.vrm || '').toUpperCase(),
      year:'', make:'', model:'', fuelType:'', colour:'', variant:'',
      note:'Minimal return due to server error'
    });
  }
}
