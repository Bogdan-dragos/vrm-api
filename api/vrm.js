// /api/vrm.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const vrm = (req.query.vrm || '').trim().toUpperCase();
  const debug = String(req.query.debug || '') === '1';

  if (!vrm) {
    return res.status(400).json({ error: 'Missing vrm param ?vrm=AB12CDE' });
  }

  const out = {
    vrm, year: '', make: '', model: '', fuelType: '', colour: '', firstUsedDate: '',
    calls: {}
  };

  // Helper to log safely
  const log = (...args) => { if (debug) console.log(...args); };

  // --- 1) DVSA: get OAuth token ---
  async function getDvsaToken() {
    const body = new URLSearchParams({
      client_id: process.env.DVSA_CLIENT_ID,
      client_secret: process.env.DVSA_CLIENT_SECRET,
      scope: process.env.DVSA_SCOPE_URL,
      grant_type: 'client_credentials',
    });

    const resp = await fetch(process.env.DVSA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    const text = await resp.text();
    log('DVSA token status:', resp.status, 'body:', text.slice(0, 400));
    if (!resp.ok) throw new Error(`DVSA token failed ${resp.status}`);
    try { return JSON.parse(text).access_token; } catch { throw new Error('DVSA token parse error'); }
  }

  // --- 2) DVSA: vehicle details (if token works) ---
  async function fromDvsa() {
    try {
      const token = await getDvsaToken();
      const url = `https://beta.check-mot.service.gov.uk/trade/vehicles?registration=${encodeURIComponent(vrm)}`;
      const r = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-api-key': process.env.DVSA_API_KEY,
          'Accept': 'application/json'
        }
      });
      const text = await r.text();
      log('DVSA vehicles status:', r.status, 'body:', text.slice(0, 800));
      out.calls.dvsa = { status: r.status };

      if (r.ok) {
        // DVSA returns an array; we'll pick the first
        const arr = JSON.parse(text);
        const v = Array.isArray(arr) ? arr[0] : arr;
        if (v) {
          out.year = String(v.yearOfManufacture || out.year);
          out.make = v.make || out.make;
          out.model = v.model || out.model;
          out.fuelType = v.fuelType || out.fuelType;
          out.colour = v.colour || out.colour;
          out.firstUsedDate = v.monthOfFirstRegistration || out.firstUsedDate;
        }
      } else {
        out.calls.dvsaError = 'fetch failed';
      }
    } catch (e) {
      log('DVSA error:', e?.message || e);
      out.calls.dvsaError = e?.message || String(e);
    }
  }

  // --- 3) DVLA (VES) as a fallback for make/year/colour ---
  async function fromDvla() {
    try {
      const r = await fetch('https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.DVLA_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ registrationNumber: vrm })
      });

      const text = await r.text();
      log('DVLA status:', r.status, 'body:', text.slice(0, 800));
      out.calls.dvla = { status: r.status };

      if (r.ok) {
        const v = JSON.parse(text);
        out.year = String(v.yearOfManufacture || out.year);
        out.make = v.make || out.make;
        out.colour = v.colour || out.colour;
        out.fuelType = v.fuelType || out.fuelType;
      }
    } catch (e) {
      log('DVLA error:', e?.message || e);
      out.calls.dvlaError = e?.message || String(e);
    }
  }

  // Run DVSA first (for model), DVLA second (extras)
  await fromDvsa();
  await fromDvla();

  // Return aggregated view
  return res.status(200).json(out);
}
