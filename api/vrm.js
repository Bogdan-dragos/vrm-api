// api/vrm.js
// Partsworth VRM lookup (v: vdg-variants-locked-6)
// - model: DVSA -> VDG -> DVLA
// - variant: ONLY from VDG (fallback DVSA derivative/trim); never composed
// - Tries multiple VDG shapes, incl. *RegistrationNumber* variants
// - Always 200; add &debug=1 for attempts

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

/* helpers */
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
function merge(base, add, { allowVariant=true } = {}) {
  const out = { ...base };
  for (const k of ['year','make','model','fuelType','colour']) if (!s(out[k]) && s(add[k])) out[k] = s(add[k]);
  if (allowVariant && !s(out.variant) && s(add.variant)) out.variant = s(add.variant);
  return out;
}

/* mappers */
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

/* providers */
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
  const apiUrl = process.env.DVSA_TAPI_URL; // set this when you have it
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
  attempts.push({ provider:'DVSA-TAPI', url:u.toString(), status: r.status, sample:(r.text||'').slice(0,SLICE) });
  if (!r.ok || !r.json) return null;
  return mapDVSA_TAPI(r.json);
}

/* VDG – try MANY shapes; return only if variant present (we'll also grab model if available) */
async function tryVDG_ForVariant(vrm, attempts) {
  const base = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
  const key = process.env.VDG_API_KEY; if (!key) return null;
  const pkgEnv = process.env.VDG_PACKAGE || 'VehicleDetails';
  const packages = [pkgEnv, 'SpecAndOptionsDetails', 'VehicleDetailsWithImage'].filter((v,i,a)=>a.indexOf(v)===i);

  for (const pkg of packages) {
    // 1) GET /r2/lookup/Registration/{VRM}
    {
      const url = new URL(`${base}/r2/lookup/Registration/${encodeURIComponent(vrm)}`);
      url.searchParams.set('apiKey', key);
      url.searchParams.set('packageName', pkg);
      const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
      attempts.push({ provider:'VDG', pkg, method:'GET', shape:'path-Registration', url:url.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,SLICE) });
      if (r.ok && r.json && vdgOK(r.json)) { const m = mapVDG_Generic(r.json); if (s(m.variant)) return m; }
    }
    // 2) GET /r2/lookup/RegistrationNumber/{VRM}
    {
      const url = new URL(`${base}/r2/lookup/RegistrationNumber/${encodeURIComponent(vrm)}`);
      url.searchParams.set('apiKey', key);
      url.searchParams.set('packageName', pkg);
      const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
      attempts.push({ provider:'VDG', pkg, method:'GET', shape:'path-RegistrationNumber', url:url.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,SLICE) });
      if (r.ok && r.json && vdgOK(r.json)) { const m = mapVDG_Generic(r.json); if (s(m.variant)) return m; }
    }
    // 3) GET /r2/lookup?...&SearchType=Registration&SearchTerm=VRM
    {
      const url = new URL(`${base}/r2/lookup`);
      url.searchParams.set('apiKey', key);
      url.searchParams.set('packageName', pkg);
      url.searchParams.set('SearchType', 'Registration');
      url.searchParams.set('SearchTerm', vrm);
      const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
      attempts.push({ provider:'VDG', pkg, method:'GET', shape:'query-Pascal', url:url.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,SLICE) });
      if (r.ok && r.json && vdgOK(r.json)) { const m = mapVDG_Generic(r.json); if (s(m.variant)) return m; }
    }
    // 4) GET /r2/lookup?...&SearchType=RegistrationNumber&SearchTerm=VRM
    {
      const url = new URL(`${base}/r2/lookup`);
      url.searchParams.set('apiKey', key);
      url.searchParams.set('packageName', pkg);
      url.searchParams.set('SearchType', 'RegistrationNumber');
      url.searchParams.set('SearchTerm', vrm);
      const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
      attempts.push({ provider:'VDG', pkg, method:'GET', shape:'query-Pascal-RegNumber', url:url.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,SLICE) });
      if (r.ok && r.json && vdgOK(r.json)) { const m = mapVDG_Generic(r.json); if (s(m.variant)) return m; }
    }
    // 5) POST JSON PascalCase
    {
      const url = `${base}/r2/lookup`;
      const body = { apiKey:key, packageName:pkg, SearchType:'Registration', SearchTerm: vrm };
      const r = await fetchBody(url, { method:'POST', headers:{ 'Content-Type':'application/json','Accept':'application/json' }, body: JSON.stringify(body) });
      attempts.push({ provider:'VDG', pkg, method:'POST', shape:'body-Pascal', url, status:r.status, sample:(r.text||'').slice(0,SLICE) });
      if (r.ok && r.json && vdgOK(r.json)) { const m = mapVDG_Generic(r.json); if (s(m.variant)) return m; }
    }
    // 6) POST JSON lowercase
    {
      const url = `${base}/r2/lookup`;
      const body = { apiKey:key, packageName:pkg, searchType:'Registration', searchTerm: vrm };
      const r = await fetchBody(url, { method:'POST', headers:{ 'Content-Type':'application/json','Accept':'application/json' }, body: JSON.stringify(body) });
      attempts.push({ provider:'VDG', pkg, method:'POST', shape:'body-lower', url, status:r.status, sample:(r.text||'').slice(0,SLICE) });
      if (r.ok && r.json && vdgOK(r.json)) { const m = mapVDG_Generic(r.json); if (s(m.variant)) return m; }
    }
  }
  return null;
}

/* route */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCORS(res); return res.status(204).end(); }
  setCORS(res);

  try {
    const plate = s(req.query?.vrm || '').toUpperCase();
    const debugMode = req.query?.debug === '1';
    if (!plate) return res.status(400).json({ error: 'Missing vrm' });

    let out = { vrm: plate, year:'', make:'', model:'', fuelType:'', colour:'', variant:'', _version:'vdg-variants-locked-6' };
    const attempts = [];

    // 1) DVSA for model (will be 403 until IP-whitelist or TAPI)
    const dvsaLegacy = await tryDVSA_Legacy(plate, attempts);
    if (dvsaLegacy) out = merge(out, dvsaLegacy, { allowVariant:false });

    if (!s(out.model)) {
      const dvsaTapi = await tryDVSA_TAPI(plate, attempts);
      if (dvsaTapi) out = merge(out, dvsaTapi, { allowVariant:false });
    }

    // 2) DVLA for year/make(+ fuel/colour) + model fallback
    const dvla = await tryDVLA(plate, attempts);
    if (dvla) out = merge(out, dvla, { allowVariant:false });

    // 3) VDG strictly for variant; also fills model if DVSA failed
    const vdg = await tryVDG_ForVariant(plate, attempts);
    if (vdg) {
      if (s(vdg.variant)) out.variant = cleanVariant(vdg.variant, out.make || vdg.make);
      if (!s(out.model) && s(vdg.model)) out.model = vdg.model;
      out = merge(out, vdg, { allowVariant:false }); // backfill basics
    } else if (!s(out.variant) && dvsaLegacy && s(dvsaLegacy.variant)) {
      out.variant = cleanVariant(dvsaLegacy.variant, out.make);
    }

    if (debugMode) return res.status(200).json({ ...out, _debug: { attempts } });
    const { _version, ...publicOut } = out;
    return res.status(200).json(publicOut);

  } catch {
    return res.status(200).json({
      vrm: s(req.query?.vrm || '').toUpperCase(),
      year:'', make:'', model:'', fuelType:'', colour:'', variant:'',
      note:'Minimal return due to server error',
      _version:'vdg-variants-locked-6'
    });
  }
}
