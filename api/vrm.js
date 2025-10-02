// api/vrm.js
// Robust VDG VehicleDetails lookup with multi-variant GET attempts.
// It tries several param name/value combos (SearchType/Registration vs VRM, caps vs lower)
// and returns the first successful payload. Add &debug=1 to see all attempts.
//
// Required env (set in Vercel → Settings → Environment Variables):
//   VDG_BASE = https://uk.api.vehicledataglobal.com
//   VDG_API_KEY = 656e7886-c004-4233-adbc-721d0112641b
// Optional (defaults shown):
//   VDG_PACKAGE = VehicleDetails
//
// Test:  https://vrm-api.vercel.app/api/vrm?vrm=AB12CDE&debug=1

function maskUrl(u) {
  try {
    const url = new URL(u);
    for (const [k] of url.searchParams) {
      const lk = k.toLowerCase();
      if (lk.includes('key') || lk.includes('token')) url.searchParams.set(k, '***');
    }
    return url.toString();
  } catch { return '***'; }
}

function mapPayload(plate, json) {
  const payload = { vrm: plate, year: '', make: '', model: '', fuelType: '', colour: '', variant: '' };
  const r = json?.results || {};
  const vid = r?.vehicleDetails?.vehicleIdentification || {};
  const vhist = r?.vehicleDetails?.vehicleHistory || {};
  const mid = r?.modelDetails?.modelIdentification || {};
  const pwr = r?.modelDetails?.powertrain || {};

  payload.make    = String(mid?.make  || vid?.dvlaMake  || '').trim();
  payload.model   = String(mid?.model || vid?.dvlaModel || '').trim();
  payload.variant = String(mid?.modelVariant || '').trim();
  const yom = vid?.yearOfManufacture;
  const dom = typeof vid?.dateOfManufacture === 'string' ? vid?.dateOfManufacture.slice(0,4) : '';
  payload.year    = String(yom || dom || '').trim();
  payload.fuelType= String(vid?.dvlaFuelType || pwr?.fuelType || '').trim();
  payload.colour  = String(vhist?.colourDetails?.currentColour || '').trim();

  return payload;
}

export default async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const { vrm = '', debug } = req.query;
    const plate = String(vrm).trim().toUpperCase();
    if (!plate) return res.status(400).json({ error: 'Missing vrm' });

    const BASE    = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
    const API_KEY = process.env.VDG_API_KEY || '';
    const PACKAGE = process.env.VDG_PACKAGE || 'VehicleDetails';

    const basePayload = { vrm: plate, year: '', make: '', model: '', fuelType: '', colour: '', variant: '' };
    if (!API_KEY) {
      return res.status(200).json(debug === '1' ? { ...basePayload, _debug:{ error:'VDG_API_KEY not set' } } : basePayload);
    }

    // Endpoint from docs
    const endpoint = `${BASE}/r2/lookup`;

    // Build a list of candidate query parameter combos to try (GET)
    const candidates = [
      // Official-looking (caps)
      { apiKey: API_KEY, packageName: PACKAGE, SearchType: 'Registration',   SearchTerm: plate },
      // lower-case
      { apiKey: API_KEY, packageName: PACKAGE, searchType: 'Registration',   searchTerm: plate },
      // Sometimes they call it VRM
      { apiKey: API_KEY, packageName: PACKAGE, SearchType: 'VRM',            SearchTerm: plate },
      { apiKey: API_KEY, packageName: PACKAGE, searchType: 'VRM',            searchTerm: plate },
      // Other synonyms seen in UK data APIs
      { apiKey: API_KEY, packageName: PACKAGE, SearchType: 'RegistrationNumber', SearchTerm: plate },
      { apiKey: API_KEY, packageName: PACKAGE, searchType: 'RegistrationNumber', searchTerm: plate }
    ];

    const attempts = [];
    let successJson = null;

    for (const params of candidates) {
      const u = new URL(endpoint);
      Object.entries(params).forEach(([k,v]) => u.searchParams.set(k, v));

      const urlStr = u.toString();
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 10000);
      let status = 0, raw = '', ct = '';
      let parsed = null, okFlag = false, statusMsg = '';

      try {
        const resp = await fetch(urlStr, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
        clearTimeout(to);
        status = resp.status;
        ct = resp.headers.get('content-type') || '';
        raw = await resp.text();

        // Try parse json if looks like json
        if (ct.includes('json') || raw.startsWith('{') || raw.startsWith('[')) {
          try { parsed = JSON.parse(raw); } catch {}
        }

        // Success criteria per their schema
        okFlag = Boolean(parsed?.responseInformation?.isSuccessStatusCode);
        statusMsg = parsed?.responseInformation?.statusMessage || '';

        attempts.push({
          url: maskUrl(urlStr),
          status,
          isJson: Boolean(parsed),
          isSuccessStatusCode: okFlag,
          statusMessage: statusMsg,
          sample: raw.slice(0, 220)
        });

        if (okFlag && parsed?.results) {
          successJson = parsed;
          break;
        }
      } catch (e) {
        attempts.push({
          url: maskUrl(urlStr),
          status,
          error: String(e?.message || e),
          sample: raw.slice(0, 180)
        });
      }
    }

    if (successJson) {
      const payload = mapPayload(plate, successJson);
      return res.status(200).json(debug === '1' ? { ...payload, _debug:{ attempts } } : payload);
    }

    // No variant worked – return non-breaking with debug
    return res.status(200).json(debug === '1' ? { ...basePayload, _debug:{ attempts } } : basePayload);

  } catch {
    return res.status(200).json({
      vrm: String(req.query?.vrm || '').toUpperCase(),
      year:'', make:'', model:'', fuelType:'', colour:'', variant:'',
      note:'Minimal return due to server error'
    });
  }
}
