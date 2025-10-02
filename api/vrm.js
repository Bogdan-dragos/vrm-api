// api/vrm.js
// Calls VehicleDataGlobal r2/lookup for VehicleDetails.
// Uses GET first; if VDG says SearchTerm missing, retries as POST JSON.
// Env: VDG_URL = full URL template with {VRM} placeholder.

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

function buildDisplayPayload(plate, json) {
  const payload = { vrm: plate, year: '', make: '', model: '', fuelType: '', colour: '', variant: '' };
  const r = json?.results || {};
  const vid = r?.vehicleDetails?.vehicleIdentification || {};
  const vhist = r?.vehicleDetails?.vehicleHistory || {};
  const mid = r?.modelDetails?.modelIdentification || {};
  const pwr = r?.modelDetails?.powertrain || {};

  payload.make   = String(mid?.make  || vid?.dvlaMake || '').trim();
  payload.model  = String(mid?.model || vid?.dvlaModel || '').trim();
  payload.variant= String(mid?.modelVariant || '').trim();

  const yom = vid?.yearOfManufacture;
  const dom = typeof vid?.dateOfManufacture === 'string' ? vid?.dateOfManufacture.slice(0,4) : '';
  payload.year   = String(yom || dom || '').trim();

  payload.fuelType = String(vid?.dvlaFuelType || pwr?.fuelType || '').trim();
  payload.colour   = String(vhist?.colourDetails?.currentColour || '').trim();

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

    const tmpl = process.env.VDG_URL || '';
    const basePayload = { vrm: plate, year: '', make: '', model: '', fuelType: '', colour: '', variant: '' };

    if (!tmpl) {
      return res.status(200).json(debug === '1' ? { ...basePayload, _debug: { error: 'VDG_URL not set' } } : basePayload);
    }

    // Build GET URL from template
    const getUrl = tmpl.includes('{VRM}') ? tmpl.replace('{VRM}', encodeURIComponent(plate)) : tmpl;
    const debugInfo = { requestGET: maskUrl(getUrl) };

    // ---- 1) Try GET
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 10000);
    let resp = await fetch(getUrl, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
    clearTimeout(to);

    let raw = await resp.text();
    debugInfo.statusGET = resp.status;
    debugInfo.sampleGET = raw.slice(0, 400);

    let json = null;
    try { json = JSON.parse(raw); } catch {}

    const noSearchTerm =
      json?.responseInformation?.isSuccessStatusCode === false &&
      /NoSearchTermFound/i.test(json?.responseInformation?.statusMessage || '') ||
      (json?.requestInformation?.searchTerm == null && json?.requestInformation?.searchType == null);

    // ---- 2) If GET didn’t carry the params, retry as POST JSON
    if (noSearchTerm) {
      const u = new URL(getUrl);
      const apiKey      = u.searchParams.get('apiKey') || u.searchParams.get('apikey') || '';
      const packageName = u.searchParams.get('packageName') || 'VehicleDetails';
      const searchType  = u.searchParams.get('SearchType') || u.searchParams.get('searchType') || 'Registration';
      const postUrl     = `${u.origin}${u.pathname}`;

      const body = JSON.stringify({
        apiKey,
        packageName,
        searchType,
        searchTerm: plate
      });

      const controller2 = new AbortController();
      const to2 = setTimeout(() => controller2.abort(), 10000);
      resp = await fetch(postUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal: controller2.signal
      });
      clearTimeout(to2);

      raw = await resp.text();
      debugInfo.requestPOST = `${postUrl} (JSON body)`;
      debugInfo.statusPOST = resp.status;
      debugInfo.samplePOST = raw.slice(0, 400);

      try { json = JSON.parse(raw); } catch { json = null; }
    }

    // If we have a JSON with results, map them
    if (json?.results) {
      const mapped = buildDisplayPayload(plate, json);
      return res.status(200).json(debug === '1' ? { ...mapped, _debug: debugInfo } : mapped);
    }

    // Fallback – return base payload (non-breaking)
    return res.status(200).json(debug === '1' ? { ...basePayload, _debug: debugInfo } : basePayload);
  } catch (e) {
    // Non-breaking fallback
    return res.status(200).json({
      vrm: String(req.query?.vrm || '').toUpperCase(),
      year: '', make: '', model: '', fuelType: '', colour: '', variant: '',
      note: 'Minimal return due to server error'
    });
  }
}
