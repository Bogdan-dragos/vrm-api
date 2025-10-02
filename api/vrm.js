// api/vrm.js
// Partsworth VRM lookup (v: clean-vdg-2shapes-baseline)
//
// WHAT IT DOES
// - Always returns DVLA fields (year, make, fuelType, colour) when DVLA succeeds.
// - Gets model + variant ONLY from VDG (no composing). Tries 2 shapes that
//   sandbox accounts commonly require.
// - Never throws; returns 200 even if upstreams fail. Use &debug=1 to inspect.
//
// REQUIRED ENVs (Vercel Project -> Settings -> Environment Variables)
// - DVLA_API_KEY            (string)
// - VDG_API_KEY             (string)
// - VDG_BASE                (string, default: https://uk.api.vehicledataglobal.com)
// - VDG_PACKAGE             (string, default: VehicleDetails)
//
// Example call:  /api/vrm?vrm=AB12CDE
// Debug:         /api/vrm?vrm=AB12CDE&debug=1

/* -------------------------- tiny helpers -------------------------- */
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
  // strip leading year
  v = v.replace(/^\s*(19|20)\d{2}\s+/, '');
  // strip leading make
  if (make) v = v.replace(new RegExp(`^\\s*${make.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')}\\s+`, 'i'), '');
  // strip common fuel tokens at edges
  const fuel = ['DIESEL','PETROL','ELECTRIC','HYBRID','PHEV','HEV','MHEV','GAS','LPG'];
  const R = new RegExp(`\\b(${fuel.join('|')})\\b`, 'i');
  v = v.replace(new RegExp(`^\\s*${R.source}\\s+`, 'i'), '');
  v = v.replace(new RegExp(`\\s+${R.source}\\s*$`, 'i'), '');
  return v.replace(/\s{2,}/g, ' ').trim();
}

/* -------------------------- mappers -------------------------- */
function mapDVLA(j) {
  const v = j?.data || j || {};
  return {
    year:     pick(v.yearOfManufacture, v.year),
    make:     pick(v.make, v.dvlaMake),
    model:    pick(v.model, v.dvlaModel), // DVLA often blank
    fuelType: pick(v.fuelType, v.dvlaFuelType),
    colour:   pick(v.colour, v.color),
  };
}
function mapVDG(j) {
  const r   = j?.results || {};
  const vid = r?.vehicleDetails?.vehicleIdentification || {};
  const vhist = r?.vehicleDetails?.vehicleHistory || {};
  const mid = r?.modelDetails?.modelIdentification || {};
  const pwr = r?.modelDetails?.powertrain || {};
  const sad = r?.specAndOptionsDetails || r?.specAndOptions || {};

  return {
    year:     pick(vid?.yearOfManufacture, typeof vid?.dateOfManufacture === 'string' ? vid.dateOfManufacture.slice(0,4) : ''),
    make:     pick(mid?.make, vid?.dvlaMake),
    model:    pick(mid?.model, vid?.dvlaModel),
    fuelType: pick(vid?.dvlaFuelType, pwr?.fuelType),
    colour:   pick(vhist?.colourDetails?.currentColour),
    variant:  pick(mid?.modelVariant, sad?.modelVariant, sad?.variant, r?.modelVariant),
  };
}
const vdgOK = j => Boolean(j?.responseInformation?.isSuccessStatusCode === true && j?.results);

/* -------------------------- providers -------------------------- */
// DVLA (POST)
async function getDVLA(plate, attempts) {
  const url = process.env.DVLA_API_URL || 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
  const key = process.env.DVLA_API_KEY;
  if (!key) {
    attempts.push({ provider:'DVLA', status:0, sample:'Missing DVLA_API_KEY' });
    return null;
  }
  const r = await fetchBody(url, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ registrationNumber: plate })
  });
  attempts.push({ provider:'DVLA', url, status:r.status, sample:(r.text||'').slice(0,SLICE) });
  if (!r.ok || !r.json) return null;
  return mapDVLA(r.json);
}

// VDG (GET, 2 shapes) — ONLY for model/variant (no composing)
async function getVDG(plate, attempts) {
  const base = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
  const key  = process.env.VDG_API_KEY;
  const pkg  = process.env.VDG_PACKAGE || 'VehicleDetails';
  if (!key) {
    attempts.push({ provider:'VDG', status:0, sample:'Missing VDG_API_KEY' });
    return null;
  }

  // Two common sandbox-friendly shapes we’ll try in order:
  const urls = [
    // Shape A: query string
    new URL(`${base}/r2/lookup`),
    // Shape B: path param
    new URL(`${base}/r2/lookup/RegistrationNumber/${encodeURIComponent(plate)}`)
  ];
  // Fill query params for Shape A
  urls[0].searchParams.set('apiKey', key);
  urls[0].searchParams.set('packageName', pkg);
  urls[0].searchParams.set('SearchType', 'RegistrationNumber');
  urls[0].searchParams.set('SearchTerm', plate);
  // Fill query params for Shape B
  urls[1].searchParams.set('apiKey', key);
  urls[1].searchParams.set('packageName', pkg);

  for (const [i, u] of urls.entries()) {
    const shape = i === 0 ? 'query-RegistrationNumber' : 'path-RegistrationNumber';
    const masked = u.toString().replace(/(apiKey=)[^&]+/,'$1***');

    const r = await fetchBody(u.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
    attempts.push({ provider:'VDG', method:'GET', shape, url: masked, status:r.status, sample:(r.text||'').slice(0,SLICE) });

    if (r.ok && r.json && vdgOK(r.json)) {
      return mapVDG(r.json);
    }
  }
  return null;
}

/* -------------------------- route -------------------------- */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCORS(res); return res.status(204).end(); }
  setCORS(res);

  try {
    const plate = s(req.query?.vrm || '').toUpperCase();
    const debugMode = req.query?.debug === '1';
    if (!plate) return res.status(400).json({ error: 'Missing vrm' });

    const attempts = [];

    // 1) DVLA baseline (year/make/fuel/colour)
    const dvla = await getDVLA(plate, attempts);

    let out = {
      vrm: plate,
      year: s(dvla?.year),
      make: s(dvla?.make),
      model: '',                 // filled from VDG if available
      fuelType: s(dvla?.fuelType),
      colour: s(dvla?.colour),
      variant: '',               // only from VDG (no composing)
      _version: 'clean-vdg-2shapes-baseline'
    };

    // 2) VDG for model + variant
    try {
      const vdg = await getVDG(plate, attempts);
      if (vdg) {
        if (!out.model && s(vdg.model)) out.model = s(vdg.model);
        if (!out.variant && s(vdg.variant)) out.variant = cleanVariant(vdg.variant, out.make || vdg.make);
      }
    } catch (e) {
      attempts.push({ provider:'VDG', status:0, sample:`threw: ${String(e?.message || e)}` });
    }

    if (debugMode) return res.status(200).json({ ...out, _debug: { attempts } });
    const { _version, ...publicOut } = out;
    return res.status(200).json(publicOut);

  } catch {
    // Never hard-fail the route; return minimal structure
    return res.status(200).json({
      vrm: s(req.query?.vrm || '').toUpperCase(),
      year:'', make:'', model:'', fuelType:'', colour:'', variant:'',
      note:'Minimal return due to server error',
      _version:'clean-vdg-2shapes-baseline'
    });
  }
}
