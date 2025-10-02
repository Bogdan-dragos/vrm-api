// api/vrm.js
// Partsworth VRM lookup with robust VDG variant:
// - DVLA -> make/year (+ fuel/colour if present)
// - DVSA -> model (+ derivative/trim if present)
// - VDG  -> variant (tries VehicleDetails -> SpecAndOptionsDetails -> VehicleDetailsWithImage)
// Always returns 200; &debug=1 shows all attempts.

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
const SLICE = 800;
const s = v => (v == null ? '' : String(v)).trim();
const pick = (...vals) => { for (const v of vals) { const x = s(v); if (x) return x; } return ''; };

async function fetchBody(url, init = {}, timeoutMs = 10000) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctl.signal });
    const text = await resp.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: resp.ok, status: resp.status, json, text, ct: resp.headers.get('content-type') || '' };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e?.message || e) };
  } finally { clearTimeout(to); }
}

function mergeBase(base, add) {
  const out = { ...base };
  for (const k of ['year','make','model','fuelType','colour']) if (!s(out[k]) && s(add[k])) out[k] = s(add[k]);
  if (!s(out.variant) && s(add.variant)) out.variant = s(add.variant); // variant only from providers
  return out;
}

/* ------------------ MAPPERS ------------------ */
function mapDVLA(j) {
  const v = j?.data || j || {};
  return {
    year: pick(v.yearOfManufacture, v.year),
    make: pick(v.make, v.dvlaMake),
    model: pick(v.model, v.dvlaModel),
    fuelType: pick(v.fuelType, v.dvlaFuelType),
    colour: pick(v.colour, v.color),
    variant: ''
  };
}
function mapDVSA_Legacy(j) {
  const arr = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : []);
  const first = arr[0] || {}; const v = first?.vehicle || first || {};
  return {
    year: pick(v.year, v.firstUsedDate?.slice?.(0,4)),
    make: pick(v.make),
    model: pick(v.model),
    fuelType: pick(v.fuelType),
    colour: pick(v.colour),
    variant: pick(v.derivative, v.trim)
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

// Pull variant from any VDG package shape
function mapVDG_Generic(j) {
  const r = j?.results || {};
  const vid = r?.vehicleDetails?.vehicleIdentification || {};
  const vhist = r?.vehicleDetails?.vehicleHistory || {};
  const mid  = r?.modelDetails?.modelIdentification || {};
  const pwr  = r?.modelDetails?.powertrain || {};
  // SpecAndOptionsDetails variant candidates
  const sad  = r?.specAndOptionsDetails || r?.specAndOptions || {};
  const year = pick(vid?.yearOfManufacture, typeof vid?.dateOfManufacture === 'string' ? vid.dateOfManufacture.slice(0,4) : '');
  const variant = pick(
    mid?.modelVariant,
    sad?.modelVariant,
    sad?.variant,
    r?.modelVariant
  );
  return {
    year: s(year),
    make: pick(mid?.make, vid?.dvlaMake),
    model: pick(mid?.model, vid?.dvlaModel),
    fuelType: pick(vid?.dvlaFuelType, pwr?.fuelType),
    colour: pick(vhist?.colourDetails?.currentColour),
    variant
  };
}
const vdgOK = j => Boolean(j?.responseInformation?.isSuccessStatusCode === true && j?.results);

/* ------------------ PROVIDERS ------------------ */
async function tryDVLA(vrm, attempts) {
  const url = process.env.DVLA_API_URL || 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
  const key = process.env.DVLA_API_KEY; if (!url || !key) return null;
  const r = await fetchBody(url, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ registrationNumber: vrm })
  });
  attempts.push({ provider: 'DVLA', url, status: r.status, sample: (r.text||'').slice(0,SLICE) });
  if (!r.ok || !r.json) return null;
  return mapDVLA(r.json);
}

async function tryDVSA_Legacy(vrm, attempts) {
  const key = process.env.DVSA_API_KEY;
  const base = process.env.DVSA_API_URL || 'https://beta.check-mot.service.gov.uk/trade/vehicles/mot-tests';
  if (!key || !base) return null;
  const u = new URL(base); u.searchParams.set('registration', vrm);
  const r = await fetchBody(u.toString(), { method: 'GET', headers: { 'x-api-key': key, 'Accept': 'application/json' } });
  attempts.push({ provider: 'DVSA-legacy', url: u.toString(), status: r.status, sample: (r.text||'').slice(0,SLICE) });
  if (!r.ok || !r.json) return null;
  return mapDVSA_Legacy(r.json);
}

async function tryDVSA_TAPI(vrm, attempts) {
  const tokenUrl = process.env.DVSA_TOKEN_URL;
  const clientId = process.env.DVSA_CLIENT_ID;
  const clientSecret = process.env.DVSA_CLIENT_SECRET;
  const scope = process.env.DVSA_SCOPE_URL;
  const apiUrl = process.env.DVSA_TAPI_URL; // set when you know the exact endpoint
  if (!tokenUrl || !clientId || !clientSecret || !scope || !apiUrl) return null;

  const form = new URLSearchParams();
  form.set('grant_type','client_credentials'); form.set('client_id',clientId);
  form.set('client_secret',clientSecret); form.set('scope',scope);
  const tok = await fetchBody(tokenUrl, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: form.toString() });
  attempts.push({ provider:'DVSA-token', url: tokenUrl, status: tok.status, sample: (tok.text||'').slice(0,SLICE) });
  const at = tok.json?.access_token; if (!at) return null;

  const u = new URL(apiUrl); u.searchParams.set('vrm', vrm);
  const r = await fetchBody(u.toString(), { method:'GET', headers:{ 'Authorization':`Bearer ${at}`, 'Accept':'application/json' } });
  attempts.push({ provider:'DVSA-TAPI', url: u.toString(), status: r.status, sample: (r.text||'').slice(0,SLICE) });
  if (!r.ok || !r.json) return null;
  return mapDVSA_TAPI(r.json);
}

// Try VDG with multiple packages & both POST and GET
async function tryVDG_All(vrm, attempts) {
  const base = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
  const key = process.env.VDG_API_KEY; if (!key) return null;
  const pkgEnv = process.env.VDG_PACKAGE || 'VehicleDetails';
  const packages = [pkgEnv, 'SpecAndOptionsDetails', 'VehicleDetailsWithImage']
    .filter((v, i, a) => a.indexOf(v) === i); // unique

  for (const pkg of packages) {
    const url = `${base}/r2/lookup`;

    // 1) POST JSON
    const body = { apiKey: key, packageName: pkg, searchType: 'Registration', searchTerm: vrm };
    let r = await fetchBody(url, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Accept':'application/json' },
      body: JSON.stringify(body)
    });
    attempts.push({ provider:'VDG', pkg, method:'POST', url, status:r.status, sample:(r.text||'').slice(0,SLICE) });
    if (r.ok && r.json && vdgOK(r.json)) {
      const mapped = mapVDG_Generic(r.json);
      if (s(mapped.variant)) return mapped; // we only care if variant appears
    }

    // 2) GET (PascalCase)
    const u = new URL(url);
    u.searchParams.set('apiKey', key);
    u.searchParams.set('packageName', pkg);
    u.searchParams.set('SearchType', 'Registration');
    u.searchParams.set('SearchTerm', vrm);
    r = await fetchBody(u.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
    attempts.push({ provider:'VDG', pkg, method:'GET', url:u.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,SLICE) });
    if (r.ok && r.json && vdgOK(r.json)) {
      const mapped = mapVDG_Generic(r.json);
      if (s(mapped.variant)) return mapped;
    }
  }
  return null;
}

/* ------------------ ROUTE ------------------ */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCORS(res); return res.status(204).end(); }
  setCORS(res);

  try {
    const plate = s(req.query?.vrm || '').toUpperCase();
    const debugMode = req.query?.debug === '1';
    if (!plate) return res.status(400).json({ error: 'Missing vrm' });

    let payload = { vrm: plate, year:'', make:'', model:'', fuelType:'', colour:'', variant:'' };
    const attempts = [];

    // DVLA
    const dvla = await tryDVLA(plate, attempts);
    if (dvla) payload = mergeBase(payload, dvla);

    // DVSA (legacy first, then TAPI if configured)
    const dvsaLegacy = await tryDVSA_Legacy(plate, attempts);
    if (dvsaLegacy) payload = mergeBase(payload, dvsaLegacy);
    else {
      const dvsaTapi = await tryDVSA_TAPI(plate, attempts);
      if (dvsaTapi) payload = mergeBase(payload, dvsaTapi);
    }

    // VDG (variant from any supported package)
    const vdg = await tryVDG_All(plate, attempts);
    if (vdg) payload = mergeBase(payload, vdg);

    // IMPORTANT: Do NOT fabricate variant. If none found, leave empty.

    if (debugMode) return res.status(200).json({ ...payload, _debug: { attempts } });
    return res.status(200).json(payload);

  } catch {
    return res.status(200).json({
      vrm: s(req.query?.vrm || '').toUpperCase(),
      year:'', make:'', model:'', fuelType:'', colour:'', variant:'',
      note:'Minimal return due to server error'
    });
  }
}
