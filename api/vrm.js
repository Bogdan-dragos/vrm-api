// api/vrm.js
// Partsworth VRM lookup — STABLE BASELINE (v: stable-baseline-1)
// - Always returns DVLA (year, make, fuelType, colour).
// - model/variant only if DVSA/VDG are explicitly enabled via env flags.
// - Never composes/guesses variant. Only takes real values from VDG (or DVSA fallback).
// - Add &debug=1 to inspect attempts.

// ---------------- basic utils ----------------
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
const SLICE = 900;
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

function cleanVariant(variant, make) {
  let v = s(variant);
  if (!v) return v;
  v = v.replace(/^\s*(19|20)\d{2}\s+/, '');
  if (make) v = v.replace(new RegExp(`^\\s*${make.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\\s+`, 'i'), '');
  const fuel = ['DIESEL','PETROL','ELECTRIC','HYBRID','PHEV','HEV','MHEV','GAS','LPG'];
  const R = new RegExp(`\\b(${fuel.join('|')})\\b`, 'i');
  v = v.replace(new RegExp(`^\\s*${R.source}\\s+`, 'i'), '');
  v = v.replace(new RegExp(`\\s+${R.source}\\s*$`, 'i'), '');
  return v.replace(/\s{2,}/g, ' ').trim();
}

// ---------------- mappers ----------------
function mapDVLA(j) {
  const v = j?.data || j || {};
  return {
    year: pick(v.yearOfManufacture, v.year),
    make: pick(v.make, v.dvlaMake),
    model: pick(v.model, v.dvlaModel), // often missing in DVLA
    fuelType: pick(v.fuelType, v.dvlaFuelType),
    colour: pick(v.colour, v.color),
    variant: ''                         // DVLA doesn’t give trim reliably
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
    make: pick(mid?.make, vid?.dvlaMake),
    model: pick(mid?.model, vid?.dvlaModel),
    fuelType: pick(vid?.dvlaFuelType, pwr?.fuelType),
    colour: pick(vhist?.colourDetails?.currentColour),
    variant: pick(mid?.modelVariant, sad?.modelVariant, sad?.variant, r?.modelVariant)
  };
}
const vdgOK = j => Boolean(j?.responseInformation?.isSuccessStatusCode === true && j?.results);

// ---------------- providers (all error-safe) ----------------
async function getDVLA(plate, attempts) {
  const url = process.env.DVLA_API_URL || 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
  const key = process.env.DVLA_API_KEY;
  if (!key) return null;
  const r = await fetchBody(url, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ registrationNumber: plate })
  });
  attempts.push({ provider:'DVLA', url, status:r.status, sample:(r.text||'').slice(0,SLICE) });
  if (!r.ok || !r.json) return null;
  return mapDVLA(r.json);
}

async function getDVSA_Legacy(plate, attempts) {
  if (process.env.DVSA_ENABLED !== '1') return null;
  const key = process.env.DVSA_API_KEY;
  const base = process.env.DVSA_API_URL || 'https://beta.check-mot.service.gov.uk/trade/vehicles/mot-tests';
  if (!key) return null;
  const u = new URL(base); u.searchParams.set('registration', plate);
  const r = await fetchBody(u.toString(), { method:'GET', headers:{ 'x-api-key': key, 'Accept':'application/json' } });
  attempts.push({ provider:'DVSA-legacy', url:u.toString(), status:r.status, sample:(r.text||'').slice(0,SLICE) });
  if (!r.ok || !r.json) return null;
  return mapDVSA_Legacy(r.json);
}

async function getVDG(plate, attempts) {
  if (process.env.VDG_ENABLED !== '1') return null;
  const base = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
  const key  = process.env.VDG_API_KEY;
  const pkgEnv = process.env.VDG_PACKAGE || 'VehicleDetails';
  if (!key) return null;

  const packages = [pkgEnv, 'SpecAndOptionsDetails', 'VehicleDetailsWithImage'].filter((v,i,a)=>a.indexOf(v)===i);

  for (const pkg of packages) {
    // 1) GET /r2/lookup/Registration/{VRM}
    {
      const url = new URL(`${base}/r2/lookup/Registration/${encodeURIComponent(plate)}`);
      url.searchParams.set('apiKey', key); url.searchParams.set('packageName', pkg);
      const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
      attempts.push({ provider:'VDG', pkg, method:'GET', shape:'path-Registration', url:url.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,SLICE) });
      if (r.ok && r.json && vdgOK(r.json)) return mapVDG_Generic(r.json);
    }
    // 2) GET /r2/lookup/RegistrationNumber/{VRM}
    {
      const url = new URL(`${base}/r2/lookup/RegistrationNumber/${encodeURIComponent(plate)}`);
      url.searchParams.set('apiKey', key); url.searchParams.set('packageName', pkg);
      const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
      attempts.push({ provider:'VDG', pkg, method:'GET', shape:'path-RegistrationNumber', url:url.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,SLICE) });
      if (r.ok && r.json && vdgOK(r.json)) return mapVDG_Generic(r.json);
    }
    // 3) GET /r2/lookup?… SearchType=Registration
    {
      const url = new URL(`${base}/r2/lookup`);
      url.searchParams.set('apiKey', key); url.searchParams.set('packageName', pkg);
      url.searchParams.set('SearchType', 'Registration'); url.searchParams.set('SearchTerm', plate);
      const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
      attempts.push({ provider:'VDG', pkg, method:'GET', shape:'query-Pascal', url:url.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,SLICE) });
      if (r.ok && r.json && vdgOK(r.json)) return mapVDG_Generic(r.json);
    }
    // 4) GET /r2/lookup?… SearchType=RegistrationNumber
    {
      const url = new URL(`${base}/r2/lookup`);
      url.searchParams.set('apiKey', key); url.searchParams.set('packageName', pkg);
      url.searchParams.set('SearchType', 'RegistrationNumber'); url.searchParams.set('SearchTerm', plate);
      const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
      attempts.push({ provider:'VDG', pkg, method:'GET', shape:'query-Pascal-RegNumber', url:url.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,SLICE) });
      if (r.ok && r.json && vdgOK(r.json)) return mapVDG_Generic(r.json);
    }
    // 5) POST PascalCase body
    {
      const url = `${base}/r2/lookup`;
      const body = { apiKey:key, packageName:pkg, SearchType:'Registration', SearchTerm: plate };
      const r = await fetchBody(url, { method:'POST', headers:{ 'Content-Type':'application/json','Accept':'application/json' }, body: JSON.stringify(body) });
      attempts.push({ provider:'VDG', pkg, method:'POST', shape:'body-Pascal', url, status:r.status, sample:(r.text||'').slice(0,SLICE) });
      if (r.ok && r.json && vdgOK(r.json)) return mapVDG_Generic(r.json);
    }
    // 6) POST lowercase body
    {
      const url = `${base}/r2/lookup`;
      const body = { apiKey:key, packageName:pkg, searchType:'Registration', searchTerm: plate };
      const r = await fetchBody(url, { method:'POST', headers:{ 'Content-Type':'application/json','Accept':'application/json' }, body: JSON.stringify(body) });
      attempts.push({ provider:'VDG', pkg, method:'POST', shape:'body-lower', url, status:r.status, sample:(r.text||'').slice(0,SLICE) });
      if (r.ok && r.json && vdgOK(r.json)) return mapVDG_Generic(r.json);
    }
  }
  return null;
}

// ---------------- route ----------------
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCORS(res); return res.status(204).end(); }
  setCORS(res);

  try {
    const plate = s(req.query?.vrm || '').toUpperCase();
    const debugMode = req.query?.debug === '1';
    if (!plate) return res.status(400).json({ error: 'Missing vrm' });

    const attempts = [];
    // Always get DVLA first (baseline output)
    const dvla = await getDVLA(plate, attempts);
    const base = {
      vrm: plate,
      year: s(dvla?.year),
      make: s(dvla?.make),
      model: '',                 // will try to fill below
      fuelType: s(dvla?.fuelType),
      colour: s(dvla?.colour),
      variant: '',               // never fabricated
      _version: 'stable-baseline-1'
    };

    // Optional DVSA (model + maybe variant/derivative) — won’t throw
    let dvsa = null;
    try { dvsa = await getDVSA_Legacy(plate, attempts); } catch {}
    if (dvsa?.model && !base.model) base.model = s(dvsa.model);

    // Optional VDG (variant + maybe model) — won’t throw
    let vdg = null;
    try { vdg = await getVDG(plate, attempts); } catch {}
    if (vdg) {
      if (!base.model && s(vdg.model)) base.model = s(vdg.model);
      if (!base.variant && s(vdg.variant)) base.variant = cleanVariant(vdg.variant, base.make || vdg.make);
    }
    // Fallback: if VDG gave no variant, allow DVSA derivative/trim
    if (!base.variant && dvsa?.variant) base.variant = cleanVariant(dvsa.variant, base.make);

    if (debugMode) return res.status(200).json({ ...base, _debug: { attempts } });
    const { _version, ...publicOut } = base;
    return res.status(200).json(publicOut);

  } catch {
    return res.status(200).json({
      vrm: s(req.query?.vrm || '').toUpperCase(),
      year:'', make:'', model:'', fuelType:'', colour:'', variant:'',
      note:'Minimal return due to server error',
      _version:'stable-baseline-1'
    });
  }
}
