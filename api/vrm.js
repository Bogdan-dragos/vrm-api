// api/vrm.js
// Non-breaking multi-provider VRM lookup for Partsworth.
// Order: DVLA -> DVSA -> VDG (sandbox). Returns 200 with best effort.
// Add &debug=1 to see attempts and short response samples.

// ---------- util ----------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
function sampleTxt(t, n = 600) { return (t || '').slice(0, n); }
async function fetchJSON(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: resp.ok, status: resp.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e?.message || e) };
  } finally { clearTimeout(to); }
}
async function postJSON(url, body, headers = {}, timeoutMs = 8000) {
  return fetchJSON(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body)
  }, timeoutMs);
}
function cleanStr(x) { return (x == null ? '' : String(x)).trim(); }

// Merge “best known” from multiple sources
function merge(base, add) {
  const out = { ...base };
  for (const k of ['year','make','model','fuelType','colour','variant']) {
    if (!cleanStr(out[k]) && cleanStr(add[k])) out[k] = cleanStr(add[k]);
  }
  return out;
}

// ---------- mappers ----------
function mapDVLA(j) {
  // Adjust to your DVLA shape if different
  // Common shapes: top-level or .data
  const src = j?.data || j || {};
  return {
    year: cleanStr(src.yearOfManufacture || src.year || ''),
    make: cleanStr(src.make || src.dvlaMake || ''),
    model: cleanStr(src.model || src.dvlaModel || ''),
    fuelType: cleanStr(src.fuelType || src.dvlaFuelType || ''),
    colour: cleanStr(src.colour || src.color || ''),
    variant: '' // DVLA rarely has trim/variant
  };
}
function mapDVSA(j) {
  const v = j?.vehicle || j?.data || j || {};
  return {
    year: cleanStr(v.year || v.yearOfManufacture || ''),
    make: cleanStr(v.make || ''),
    model: cleanStr(v.model || ''),
    fuelType: cleanStr(v.fuelType || ''),
    colour: cleanStr(v.colour || ''),
    variant: cleanStr(v.derivative || v.trim || '')
  };
}
function mapVDG(j) {
  const r = j?.results || {};
  const vid = r?.vehicleDetails?.vehicleIdentification || {};
  const vhist = r?.vehicleDetails?.vehicleHistory || {};
  const mid = r?.modelDetails?.modelIdentification || {};
  const pwr = r?.modelDetails?.powertrain || {};
  const year =
    vid?.yearOfManufacture ||
    (typeof vid?.dateOfManufacture === 'string' ? vid.dateOfManufacture.slice(0, 4) : '');
  return {
    year: cleanStr(year),
    make: cleanStr(mid?.make || vid?.dvlaMake || ''),
    model: cleanStr(mid?.model || vid?.dvlaModel || ''),
    fuelType: cleanStr(vid?.dvlaFuelType || pwr?.fuelType || ''),
    colour: cleanStr(vhist?.colourDetails?.currentColour || ''),
    variant: cleanStr(mid?.modelVariant || '')
  };
}

// ---------- providers (each returns {data, attempt}) ----------
async function tryDVLA(vrm) {
  const attempts = [];
  const url = process.env.DVLA_API_URL;     // e.g. https://your-dvla-proxy/lookup
  const key = process.env.DVLA_API_KEY;     // header x-api-key or Authorization, depending on your proxy
  if (!url || !key) return { data: null, attempts };

  const u = new URL(url);
  u.searchParams.set('vrm', vrm);

  const { ok, status, json, text } = await fetchJSON(u.toString(), {
    headers: { accept: 'application/json', 'x-api-key': key }
  });

  attempts.push({ provider: 'DVLA', url: u.toString(), status, sample: sampleTxt(text) });
  if (!ok || !json) return { data: null, attempts };

  return { data: mapDVLA(json), attempts };
}

async function tryDVSA(vrm) {
  const attempts = [];
  // Optional OAuth client-credentials if you had it before; otherwise skip gracefully
  const apiUrl = process.env.DVSA_API_URL;       // e.g. https://your-dvsa-proxy/lookup
  const tokenUrl = process.env.DVSA_TOKEN_URL;   // if you used DVSA directly
  const clientId = process.env.DVSA_CLIENT_ID;
  const clientSecret = process.env.DVSA_CLIENT_SECRET;
  const scope = process.env.DVSA_SCOPE_URL;

  if (apiUrl && tokenUrl && clientId && clientSecret) {
    // Get token (client credentials)
    const tRes = await postJSON(tokenUrl, {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: scope || ''
    }, { 'content-type': 'application/json' }, 8000);

    attempts.push({ provider: 'DVSA-token', url: tokenUrl, status: tRes.status, sample: sampleTxt(tRes.text) });
    const accessToken = tRes.json?.access_token;
    if (!accessToken) return { data: null, attempts };

    const u = new URL(apiUrl);
    u.searchParams.set('vrm', vrm);

    const { ok, status, json, text } = await fetchJSON(u.toString(), {
      headers: { accept: 'application/json', Authorization: `Bearer ${accessToken}` }
    });

    attempts.push({ provider: 'DVSA', url: u.toString(), status, sample: sampleTxt(text) });
    if (!ok || !json) return { data: null, attempts };

    return { data: mapDVSA(json), attempts };
  }

  // If you had a simple proxy before:
  if (apiUrl) {
    const u = new URL(apiUrl);
    u.searchParams.set('vrm', vrm);
    const { ok, status, json, text } = await fetchJSON(u.toString(), { headers: { accept: 'application/json' } });
    attempts.push({ provider: 'DVSA', url: u.toString(), status, sample: sampleTxt(text) });
    if (!ok || !json) return { data: null, attempts };
    return { data: mapDVSA(json), attempts };
  }

  return { data: null, attempts };
}

async function tryVDG(vrm) {
  const attempts = [];
  const base = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
  const apiKey = process.env.VDG_API_KEY;
  const pkg = process.env.VDG_PACKAGE || 'VehicleDetails';
  if (!apiKey) return { data: null, attempts };

  const endpoint = `${base}/r2/lookup`;
  const body = { apiKey, packageName: pkg, searchType: 'Registration', searchTerm: vrm };

  const { ok, status, json, text } = await postJSON(endpoint, body);
  attempts.push({ provider: 'VDG', url: endpoint, status, sample: sampleTxt(text) });

  // VDG signals success via responseInformation.isSuccessStatusCode === true
  if (!ok || !json || json?.responseInformation?.isSuccessStatusCode !== true) {
    return { data: null, attempts };
  }
  return { data: mapVDG(json), attempts };
}

// ---------- route ----------
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { cors(res); return res.status(204).end(); }
  cors(res);

  try {
    const plate = String(req.query?.vrm || '').trim().toUpperCase();
    const debugMode = req.query?.debug === '1';
    if (!plate) return res.status(400).json({ error: 'Missing vrm' });

    let payload = { vrm: plate, year: '', make: '', model: '', fuelType: '', colour: '', variant: '' };
    const attempts = [];

    // 1) DVLA
    const dvla = await tryDVLA(plate);
    attempts.push(...dvla.attempts);
    if (dvla.data) payload = merge(payload, dvla.data);

    // 2) DVSA
    const dvsa = await tryDVSA(plate);
    attempts.push(...dvsa.attempts);
    if (dvsa.data) payload = merge(payload, dvsa.data);

    // 3) VDG (optional; good for variant)
    const vdg = await tryVDG(plate);
    attempts.push(...vdg.attempts);
    if (vdg.data) payload = merge(payload, vdg.data);

    // Fallback “display name” if variant still empty (Shopify UX)
    if (!payload.variant) {
      const composed = [payload.year, payload.make, payload.model, payload.fuelType].filter(Boolean).join(' ');
      payload.variant = composed || '';
    }

    if (debugMode) return res.status(200).json({ ...payload, _debug: { attempts } });
    return res.status(200).json(payload);

  } catch (e) {
    // Non-breaking fallback
    return res.status(200).json({
      vrm: String(req.query?.vrm || '').toUpperCase(),
      year: '', make: '', model: '', fuelType: '', colour: '', variant: '',
      note: 'Minimal return due to server error'
    });
  }
}
