// api/vrm.js
// Partsworth VRM lookup with VDG path-shape fixes.
// - MODEL: DVSA -> VDG -> DVLA
// - VARIANT: VDG.modelVariant -> DVSA.derivative/trim (never composed)
// - VDG tries these in order (stop at first success with non-empty variant):
//    1) GET  /r2/lookup/Registration/{vrm}?apiKey=...&packageName=...
//    2) GET  /r2/lookup?apiKey=...&packageName=...&SearchType=Registration&SearchTerm={vrm}
//    3) POST /r2/lookup (JSON body, PascalCase keys)
//    4) POST /r2/lookup (JSON body, lowercase keys)
// Always returns 200; add &debug=1 for provider attempts.

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
const SLICE = 800;
const s = v => (v == null ? '' : String(v)).trim();
const pick = (...vals) => { for (const v of vals) { const x = s(v); if (x) return x; } return ''; };

async function fetchBody(url, init = {}, timeoutMs = 12000) {
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

/* ------------------ MAPPERS ------------------ */
function mapDVLA(j) {
  const v = j?.data || j || {};
  return {
    year: pick(v.yearOfManufacture, v.year),
    make: pick(v.make, v.dvlaMake),
    model: pick(v.model, v.dvlaModel),
    fuelType: pick(v.fuelType, v.dvlaFuelType),
    colour: pick(v.colour, v.color),
    variant: '' // DVLA doesn't provide trim/variant reliably
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
    variant: pick(v.derivative, v.trim) // fallback variant if VDG has none
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
  const r   = j?.results || {};
  const vid = r?.vehicleDetails?.vehicleIdentification || {};
  const vhist = r?.vehicleDetails?.vehicleHistory || {};
  const mid = r?.modelDetails?.modelIdentification || {};
  const pwr = r?.modelDetails?.powertrain || {};
  const sad = r?.specAndOptionsDetails || r?.specAndOptions || {};
  return {
    year: pick(vid?.yearOfManufacture, typeof vid?.dateOfManufacture === 'string' ? vid.dateOfManufacture.slice(0,4) : ''),
    make: pick(mid?.make,  vid?.dvlaMake),
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
  attempts.push({ provider:'DVLA', url, status:r.status, sample:(r.text||'').slice(0,SLICE) });
  if (!r.ok || !r.json) return null;
  return mapDVLA(r.json);
}
async function tryDVSA_Legacy(vrm, attempts) {
  const key = process.env.DVSA_API_KEY;
  const base = process.env.DVSA_API_URL || 'https://beta.check-mot.service.gov.uk/trade/vehicles/mot-tests';
  if (!key || !base) return null;
  const u = new URL(base); u.searchParams.set('registration', vrm);
  const r = await fetchBody(u.toString(), { method:'GET', headers:{ 'x-api-key': key, 'Accept':'application/json' } });
  attempts.push({ provider:'DVSA-legacy', url:u.toString(), status:r.status, sample:(r.text||'').slice(0,SLICE) });
  if (!r.ok || !r.json) return null;
  return mapDVSA_Legacy(r.json);
}
async function tryDVSA_TAPI(vrm, attempts) {
  const tokenUrl = process.env.DVSA_TOKEN_URL;
  const clientId = process.env.DVSA_CLIENT_ID;
  const clientSecret = process.env.DVSA_CLIENT_SECRET;
  const scope = process.env.DVSA_SCOPE_URL;
  const apiUrl = process.env.DVSA_TAPI_URL; // optional; set if using TAPI
  if (!tokenUrl || !clientId || !clientSecret || !scope || !apiUrl) return null;

  const form = new URLSearchParams();
  form.set('grant_type','client_credentials');
  form.set('client_id',clientId);
  form.set('client_secret',clientSecret);
  form.set('scope',scope);
  const tok = await fetchBody(tokenUrl, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: form.toString() });
  attempts.push({ provider:'DVSA-token', url: tokenUrl, status: tok.status, sample:(tok.text||'').slice(0,SLICE) });
  const at = tok.json?.access_token; if (!at) return null;

  const u = new URL(apiUrl); u.searchParams.set('vrm', vrm);
  const r = await fetchBody(u.toString(), { method:'GET', headers:{ 'Authorization':`Bearer ${at}`, 'Accept':'application/json' } });
  attempts.push({ provider:'DVSA-TAPI', url:u.toString(), status:r.status, sample:(r.text||'').slice(0,SLICE) });
  if (!r.ok || !r.json) return null;
  return mapDVSA_TAPI(r.json);
}

/* ------------------ VDG (tight shapes) ------------------ */
async function tryVDG_ForVariant(vrm, attempts) {
  const base = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
  const key = process.env.VDG_API_KEY; if (!key) return null;
  const pkg = process.env.VDG_PACKAGE || 'VehicleDetails';

  // 1) GET /r2/lookup/Registration/{vrm}?apiKey=...&packageName=...
  {
    const url = new URL(`${base}/r2/lookup/Registration/${encodeURIComponent(vrm)}`);
    url.searchParams.set('apiKey', key);
    url.searchParams.set('packageName', pkg);
    const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
    attempts.push({ provider:'VDG', method:'GET', shape:'path-Registration', url:url.toString().replace(/(apiKey=)[^&]+/, '$1***'), status:r.status, sample:(r.text||'').slice(0,SLICE) });
    if (r.ok && r.json && vdgOK(r.json)) {
      const m = mapVDG_Generic(r.json);
      if (s(m.variant)) return m;
    }
  }

  // 2) GET /r2/lookup?apiKey=...&packageName=...&SearchType=Registration&SearchTerm=VRM
  {
    const url = new URL(`${base}/r2/lookup`);
    url.searchParams.set('apiKey', key);
    url.searchParams.set('packageName', pkg);
    url.searchParams.set('SearchType', 'Registration');
    url.searchParams.set('SearchTerm', vrm);
    const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
    attempts.push({ provider:'VDG', method:'GET', shape:'query-Pascal', url:url.toString().replace(/(apiKey=)[^&]+/, '$1***'), status:r.status, sample:(r.text||'').slice(0,SLICE) });
    if (r.ok && r.json && vdgOK(r.json)) {
      const m = mapVDG_Generic(r.json);
      if (s(m.variant)) return m;
    }
  }

  // 3) POST JSON, PascalCase keys
  {
    const url = `${base}/r2/lookup`;
    const body = { apiKey: key, packageName: pkg, SearchType:'Registration', SearchTerm: vrm };
    const r = await fetchBody(url, { method:'POST', headers:{ 'Content-Type':'application/json','Accept':'application/json' }, body: JSON.stringify(body) });
    attempts.push({ provider:'VDG', method:'POST', shape:'body-Pascal', url, status:r.status, sample:(r.text||'').slice(0,SLICE) });
    if (r.ok && r.json && vdgOK(r.json)) {
      const m = mapVDG_Generic(r.json);
      if (s(m.variant)) return m;
    }
  }

  // 4) POST JSON, lowercase keys
  {
    const url = `${base}/r2/lookup`;
    const body = { apiKey: key, packageName: pkg, searchType:'Registration', searchTerm: vrm };
    const r = await fetchBody(url, { method:'POST', headers:{ 'Content-Type':'application/json','Accept':'application/json' }, body: JSON.stringify(body) });
    attempts.push({ provider:'VDG', method:'POST', shape:'body-lower', url, status:r.status, sample:(r.text||'').slice(0,SLICE) });
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

    // MODEL path
    const dvsaLegacy = await tryDVSA_Legacy(plate, attempts);
    if (dvsaLegacy) payload = { ...payload, ...{ model: s(payload.model) ? payload.model : dvsaLegacy.model } };

    if (!s(payload.model)) {
      const dvla = await tryDVLA(plate, attempts);
      if (dvla) {
        // DVLA can also fill model if DVSA failed
        if (!s(payload.model) && s(dvla.model)) payload.model = dvla.model;
        // Keep make/year anyway
        payload.make = s(payload.make) ? payload.make : dvla.make;
        payload.year = s(payload.year) ? payload.year : dvla.year;
        payload.fuelType = s(payload.fuelType) ? payload.fuelType : dvla.fuelType;
        payload.colour   = s(payload.colour)   ? payload.colour   : dvla.colour;
      }
    }

    if (!s(payload.model)) {
      // Ask VDG for model too (it often has model in modelDetails)
      const vdgModelTry = await tryVDG_ForVariant(plate, attempts);
      if (vdgModelTry && s(vdgModelTry.model)) payload.model = vdgModelTry.model;
      // we won't take its variant yet (tryVDG again below for freshest)
    }

    // VARIANT path (strict, never composed)
    const vdg = await tryVDG_ForVariant(plate, attempts);
    if (vdg && s(vdg.variant)) {
      payload.variant = vdg.variant;
      // also allow VDG to backfill model if still empty
      if (!s(payload.model) && s(vdg.model)) payload.model = vdg.model;
      // keep make/year/fuel/colour if missing
      payload.make = s(payload.make) ? payload.make : vdg.make;
      payload.year = s(payload.year) ? payload.year : vdg.year;
      payload.fuelType = s(payload.fuelType) ? payload.fuelType : vdg.fuelType;
      payload.colour   = s(payload.colour)   ? payload.colour   : vdg.colour;
    } else if (!s(payload.variant) && dvsaLegacy && s(dvsaLegacy.variant)) {
      payload.variant = dvsaLegacy.variant; // fallback only
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
