// /api/vrm.js  — Vercel Serverless Function
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

  // --- 1) DVSA TOKEN ---
  let token = '';
  try {
    const tokenResp = await fetch(process.env.DVSA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DVSA_CLIENT_ID,
        client_secret: process.env.DVSA_CLIENT_SECRET,
        scope: process.env.DVSA_SCOPE_URL,
        grant_type: 'client_credentials',
      }),
    });

    const tokenData = await tokenResp.json();
    if (debug) out.calls.dvsaToken = { status: tokenResp.status, body: tokenData };

    if (!tokenResp.ok) throw new Error(`DVSA token failed (${tokenResp.status})`);
    token = tokenData.access_token;
  } catch (e) {
    out.calls.dvsaError = `Token error: ${e.message}`;
  }

  // --- 2) DVSA VEHICLE (production endpoint) ---
  if (token) {
    try {
      const url = `https://history.mot.api.gov.uk/v1/trade/vehicles/registration/${encodeURIComponent(vrm)}`;
      const vResp = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-API-Key': process.env.DVSA_API_KEY,
          'Accept': 'application/json'
        }
      });

      const vJson = await vResp.json().catch(() => null);
      if (debug) out.calls.dvsaVehicles = { status: vResp.status, body: vJson };

      if (vResp.ok && vJson) {
        out.make          = vJson.make          || out.make;
        out.model         = vJson.model         || out.model;
        out.fuelType      = vJson.fuelType      || out.fuelType;
        out.colour        = vJson.colour        || out.colour;
        out.firstUsedDate = vJson.firstUsedDate || out.firstUsedDate;
        if (vJson.yearOfManufacture) out.year = String(vJson.yearOfManufacture);
      }
    } catch (e) {
      out.calls.dvsaError = `Vehicle fetch error: ${e.message}`;
    }
  }

  // --- 3) DVLA VES fallback ---
  try {
    const dResp = await fetch('https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.DVLA_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ registrationNumber: vrm })
    });

    const dData = await dResp.json();
    if (debug) out.calls.dvla = { status: dResp.status, body: dData };

    if (dResp.ok) {
      out.year     = String(dData.yearOfManufacture || out.year || '');
      out.make     = dData.make   || out.make;
      out.colour   = dData.colour || out.colour;
      out.fuelType = dData.fuelType || out.fuelType;
    }
  } catch (e) {
    out.calls.dvlaError = e.message;
  }

  return res.status(200).json(out);
}
