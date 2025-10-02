// api/vrm.js
// Partsworth VRM lookup — DVLA (year/make/fuel/colour) + DVSA (model) + VDG (variant only)
// Usage: /api/vrm?vrm=AB12CDE            // normal
//        /api/vrm?vrm=AB12CDE&debug=1    // with upstream attempt logs

/* -------------------------- shared utils -------------------------- */
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
const s = v => (v == null ? '' : String(v)).trim();
const SLICE = 900;

async function fetchBody(url, init = {}, timeoutMs = 15000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctl.signal });
    const text = await resp.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: resp.ok, status: resp.status, json, text, headers: resp.headers };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e?.message || e) };
  } finally { clearTimeout(to); }
}

/* -------------------------- DVLA (make/year/fuel/colour) -------------------------- */
async function getDVLA(plate, attempts) {
  const url = process.env.DVLA_API_URL || 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
  const key = process.env.DVLA_API_KEY;
  if (!key) {
    attempts.push({ provider:'DVLA', status:0, sample:'Missing DVLA_API_KEY' });
    return null;
  }
  const r = await fetchBody(url, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ registrationNumber: plate })
  });
  attempts.push({ provider:'DVLA', url, status:r.status, sample:(r.text||'').slice(0,SLICE) });
  if (!r.ok || !r.json) return null;

  const v = r.json;
  return {
    year: s(v.yearOfManufacture || v.year),
    make: s(v.make),
    fuelType: s(v.fuelType),
    colour: s(v.colour)
  };
}

/* -------------------------- DVSA (model) --------------------------
   Strategy:
   1) Try legacy x-api-key GET (what you used before).
   2) If 401/403 and OAuth creds exist, get token and retry with Authorization: Bearer.
   3) If you have a different OAuth-protected URL, set DVSA_TAPI_URL to override.
-------------------------------------------------------------------- */
async function dvsaLegacy(plate, attempts, headers) {
  const legacyUrl = `https://beta.check-mot.service.gov.uk/trade/vehicles/mot-tests?registration=${encodeURIComponent(plate)}`;
  const r = await fetchBody(legacyUrl, { method:'GET', headers });
  attempts.push({ provider:'DVSA', url: legacyUrl, status:r.status, sample:(r.text||'').slice(0,SLICE) });
  if (!r.ok || !r.json || !Array.isArray(r.json) || !r.json[0]) return { model:'' , status:r.status };
  const v = r.json[0];
  return { model: s(v?.model), status:r.status };
}

async function getDVSAModel(plate, attempts) {
  const apiKey = process.env.DVSA_API_KEY;
  const clientId = process.env.DVSA_CLIENT_ID;
  const clientSecret = process.env.DVSA_CLIENT_SECRET;
  const tokenUrl = process.env.DVSA_TOKEN_URL;
  const scope = process.env.DVSA_SCOPE_URL;
  const tapiUrl = process.env.DVSA_TAPI_URL; // optional override

  // 1) try legacy x-api-key
  if (apiKey) {
    const legacy = await dvsaLegacy(plate, attempts, { 'x-api-key': apiKey, 'Accept': 'application/json' });
    if (legacy.status !== 401 && legacy.status !== 403) return legacy.model; // worked or other non-auth error
    // else fall through to OAuth if creds exist
  }

  // 2) OAuth token if we have creds
  if (clientId && clientSecret && tokenUrl && scope) {
    const tokenResp = await fetchBody(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: scope,
        grant_type: 'client_credentials'
      })
    });
    attempts.push({ provider:'DVSA-OAuth', url: tokenUrl, status: tokenResp.status, sample:(tokenResp.text||'').slice(0,SLICE) });
    const token = tokenResp.json?.access_token ? String(tokenResp.json.access_token) : '';

    if (token) {
      // Retry legacy URL with Bearer (works for some deployments), or use DVSA_TAPI_URL if provided.
      if (tapiUrl) {
        const u = new URL(tapiUrl);
        u.searchParams.set('registration', plate);
        const r = await fetchBody(u.toString(), { method:'GET', headers:{ 'Authorization': `Bearer ${token}`, 'Accept':'application/json' } });
        attempts.push({ provider:'DVSA-TAPI', url: u.toString(), status:r.status, sample:(r.text||'').slice(0,SLICE) });
        if (r.ok && r.json) {
          // try common shapes
          if (Array.isArray(r.json) && r.json[0]?.model) return s(r.json[0].model);
          if (r.json?.model) return s(r.json.model);
        }
      } else {
        const withBearer = await dvsaLegacy(plate, attempts, { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
        if (withBearer.model) return withBearer.model;
      }
    }
  }

  return '';
}

/* -------------------------- VDG (variant only) --------------------------
   - GET only (sandbox often rejects POST)
   - Two shapes tried in order:
     A) /r2/lookup?apiKey=...&packageName=...&SearchType=RegistrationNumber&SearchTerm={VRM}
     B) /r2/lookup/RegistrationNumber/{VRM}?apiKey=...&packageName=...
   - Cleans year/make/fuel tokens out of the returned string.
-------------------------------------------------------------------------- */
function cleanVariant(variant, make) {
  let v = s(variant);
  if (!v) return v;
  v = v.replace(/^\s*(19|20)\d{2}\s+/, ''); // leading year
  if (make) v = v.replace(new RegExp(`^\\s*${make.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\\s+`, 'i'), '');
  const fuel = ['DIESEL','PETROL','ELECTRIC','HYBRID','PHEV','HEV','MHEV','GAS','LPG'];
  const R = new RegExp(`\\b(${fuel.join('|')})\\b`, 'i');
  v = v.replace(new RegExp(`^\\s*${R.source}\\s+`, 'i'), '');
  v = v.replace(new RegExp(`\\s+${R.source}\\s*$`, 'i'), '');
  return v.replace(/\s{2,}/g, ' ').trim();
}

async function getVDGVariant(plate, attempts) {
  const base = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
  const key  = process.env.VDG_API_KEY;
  const pkg  = process.env.VDG_PACKAGE || 'VehicleDetails';
  if (!key) {
    attempts.push({ provider:'VDG', status:0, sample:'Missing VDG_API_KEY' });
    return '';
  }

  const urlA = new URL(`${base}/r2/lookup`);
  urlA.searchParams.set('apiKey', key);
  urlA.searchParams.set('packageName', pkg);
  urlA.searchParams.set('SearchType', 'RegistrationNumber');
  urlA.searchParams.set('SearchTerm', plate);

  const urlB = new URL(`${base}/r2/lookup/RegistrationNumber/${encodeURIComponent(plate)}`);
  urlB.searchParams.set('apiKey', key);
  urlB.searchParams.set('packageName', pkg);

  const attemptsList = [
    { shape:'query-RegistrationNumber', url: urlA.toString() },
    { shape:'path-RegistrationNumber',  url: urlB.toString() }
  ];

  for (const att of attemptsList) {
    const masked = att.url.replace(/(apiKey=)[^&]+/,'$1***');
    const r = await fetchBody(att.url, { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
    attempts.push({ provider:'VDG', method:'GET', shape: att.shape, url: masked, status:r.status, sample:(r.text||'').slice(0,SLICE) });

    const variant = r.json?.results?.modelDetails?.modelIdentification?.modelVariant;
    const make = r.json?.results?.modelDetails?.modelIdentification?.make || r.json?.results?.vehicleDetails?.vehicleIdentification?.dvlaMake;
    if (r.ok && variant) return cleanVariant(variant, make);
  }

  return '';
}

/* -------------------------- Route -------------------------- */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCORS(res); return res.status(204).end(); }
  setCORS(res);

  try {
    const plate = s(req.query?.vrm || '').toUpperCase();
    const debug = req.query?.debug === '1';
    if (!plate) return res.status(400).json({ error: 'Missing vrm' });

    const attempts = [];

    // DVLA baseline
    const dvla = await getDVLA(plate, attempts);

    // DVSA model (legacy, then OAuth if needed)
    let model = '';
    try { model = await getDVSAModel(plate, attempts); } catch (e) {
      attempts.push({ provider:'DVSA', status:0, sample:`threw: ${String(e?.message || e)}` });
    }

    // VDG variant
    let variant = '';
    try { variant = await getVDGVariant(plate, attempts); } catch (e) {
      attempts.push({ provider:'VDG', status:0, sample:`threw: ${String(e?.message || e)}` });
    }

    const out = {
      vrm: plate,
      year: s(dvla?.year),
      make: s(dvla?.make),
      model: s(model),
      fuelType: s(dvla?.fuelType),
      colour: s(dvla?.colour),
      variant: s(variant)
    };

    if (debug) return res.status(200).json({ ...out, _debug: { attempts } });
    return res.status(200).json(out);

  } catch (e) {
    return res.status(200).json({
      vrm: s(req.query?.vrm || '').toUpperCase(),
      year:'', make:'', model:'', fuelType:'', colour:'', variant:'',
      error: String(e?.message || e)
    });
  }
}
