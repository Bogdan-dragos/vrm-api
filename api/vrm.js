// api/vrm.js
// Partsworth VRM lookup tuned for: reliable model + clean variant.
// - model: DVSA -> VDG -> DVLA
// - variant: VDG.modelVariant -> DVSA.derivative/trim (never composed)
// - variant cleaner removes year/make/fuel tokens.
// - Always 200; add &debug=1 for provider attempts.

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

/* ------------------ HELPERS ------------------ */
function mergeBase(target, src) {
  const out = { ...target };
  // fill model/make/year/fuel/colour if missing
  for (const k of ['model','make','year','fuelType','colour']) {
    if (!s(out[k]) && s(src[k])) out[k] = s(src[k]);
  }
  // variant only from real sources; never compose
  if (!s(out.variant) && s(src.variant)) out.variant = s(src.variant);
  return out;
}

// Remove leading year, make name, and fuel tokens from variant
function cleanVariant(variant, make) {
  let v = s(variant);
  if (!v) return v;

  // 1) strip leading 4-digit year
  v = v.replace(/^\s*(19|20)\d{2}\s+/i, '');

  // 2) strip exact make at start (AUDI, BMW, etc.)
  if (make) {
    const esc = make.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    v = v.replace(new RegExp(`^\\s*${esc}\\s+`, 'i'), '');
  }

  // 3) remove lone fuel tokens at start/end
  const fuelTokens = ['DIESEL','PETROL','ELECTRIC','HYBRID','PHEV','HEV','MHEV','GAS','LPG'];
  const tokRegex = new RegExp(`\\b(${fuelTokens.join('|')})\\b`, 'i');
  // leading
  v = v.replace(new RegExp(`^\\s*${tokRegex.source}\\s+`, 'i'), '');
  // trailing
  v = v.replace(new RegExp(`\\s+${tokRegex.source}\\s*$`, 'i'), '');

  // collapse extra spaces
  v = v.replace(/\s{2,}/g, ' ').trim();
  return v;
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
    variant: '' // DVLA doesn't provide a true variant
  };
}

function mapDVSA_Legacy(j) {
  // DVSA legacy returns an array (tests) with embedded vehicle info
  const arr = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : []);
  const first = arr[0] || {};
  const v = first?.vehicle || first || {};
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

function mapVDG_Generic(j) {
  const r = j?.results || {};
  const vid = r?.vehicleDetails?.vehicleIdentification || {};
  const vhist = r?.vehicleDetails?.vehicleHistory || {};
  const mid  = r?.modelDetails?.modelIdentification || {};
  const pwr  = r?.modelDetails?.powertrain || {};
  const sad  = r?.specAndOptionsDetails || r?.specAndOptions || {};

  return {
    year: pick(vid?.yearOfManufacture, typeof vid?.dateOfManufacture === 'string' ? vid.dateOfManufacture.slice(0,4) : ''),
    make: pick(mid?.make, vid?.dvlaMake),
    model: pick(mid?.model, vid?.dvlaModel),
    fuelType: pick(vid?.dvlaFuelType, pwr?.fuelType),
    colour: pick(vhist?.colourDetails?.currentColour),
    variant: pick(mid?.modelVariant, sad?.modelVariant, sad?.variant, r?.modelVariant)
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
  const apiUrl = process.env.DVSA_TAPI_URL; // optional
  if (!tokenUrl || !clientId || !clientSecret || !scope || !apiUrl) return null;

  const form = new URLSearchParams();
  form.set('grant_type','client_credentials');
  form.set('client_id',clientId);
  form.set('client_secret',clientSecret);
  form.set('scope',scope);

  const tok = await fetchBody(tokenUrl, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: form.toString() });
  attempts.push({ provider:'DVSA-token', url: tokenUrl, status: tok.status, sample: (tok.text||'').slice(0,SLICE) });
  const at = tok.json?.access_token; if (!at) return null;

  const u = new URL(apiUrl); u.searchParams.set('vrm', vrm);
  const r = await fetchBody(u.toString(), { method:'GET', headers:{ 'Authorization':`Bearer ${at}`, 'Accept':'application/json' } });
  attempts.push({ provider:'DVSA-TAPI', url: u.toString(), status: r.status, sample: (r.text||'').slice(0,SLICE) });
  if (!r.ok || !r.json) return null;
  return mapDVSA_TAPI(r.json);
}

// VDG with multiple packages + POST/GET fallback; returns ONLY if it finds a non-empty variant
async function tryVDG_ForVariant(vrm, attempts) {
  const base = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
  const key = process.env.VDG_API_KEY; if (!key) return null;
  const pkgEnv = process.env.VDG_PACKAGE || 'VehicleDetails';
  const packages = [pkgEnv, 'SpecAndOptionsDetails', 'VehicleDetailsWithImage']
    .filter((v, i, a) => a.indexOf(v) === i);

  for (const pkg of packages) {
    const url = `${base}/r2/lookup`;

    // POST JSON
    let r = await fetchBody(url, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Accept':'application/json' },
      body: JSON.stringify({ apiKey: key, packageName: pkg, searchType: 'Registration', searchTerm: vrm })
    });
    attempts.push({ provider:'VDG', pkg, method:'POST', url, status:r.status, sample:(r.text||'').slice(0,SLICE) });
    if (r.ok && r.json && vdgOK(r.json)) {
      const m = mapVDG_Generic(r.json);
      if (s(m.variant)) return m;
    }

    // GET PascalCase
    const u = new URL(url);
    u.searchParams.set('apiKey', key);
    u.searchParams.set('packageName', pkg);
    u.searchParams.set('SearchType', 'Registration');
    u.searchParams.set('SearchTerm', vrm);
    r = await fetchBody(u.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
    attempts.push({ provider:'VDG', pkg, method:'GET', url:u.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,SLICE) });
    if (r.ok && r.json && vdgOK(r.json)) {
      const m = mapVDG_Generic(r.json);
      if (s(m.variant)) return m;
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

    // 1) DVSA (model)
    const dvsaLegacy = await tryDVSA_Legacy(plate, attempts);
    if (dvsaLegacy) payload = mergeBase(payload, dvsaLegacy);
    else {
      const dvsaTapi = await tryDVSA_TAPI(plate, attempts);
      if (dvsaTapi) payload = mergeBase(payload, dvsaTapi);
    }

    // 2) DVLA (make/year and sometimes model fallback)
    const dvla = await tryDVLA(plate, attempts);
    if (dvla) payload = mergeBase(payload, dvla);

    // 3) VDG (variant only if real)
    const vdg = await tryVDG_ForVariant(plate, attempts);
    if (vdg) payload = mergeBase(payload, vdg);

    // CLEAN the variant to remove year/make/fuel tokens
    if (s(payload.variant)) {
      payload.variant = cleanVariant(payload.variant, payload.make);
    }

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
