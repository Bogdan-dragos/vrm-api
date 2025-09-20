// /api/vrm.js  — Vercel Serverless Function
export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  // --- Read query ---
  const vrm = String((req.query?.vrm || req.query?.VRM || "")).toUpperCase().replace(/\s+/g, "");
  const debug = String(req.query?.debug || "") === "1";
  if (!/^[A-Z0-9]{2,8}$/.test(vrm)) return res.status(400).json({ error: "Invalid VRM" });

  // --- Env keys (set these in Vercel > Settings > Environment Variables) ---
  const {
    DVSA_CLIENT_ID,
    DVSA_CLIENT_SECRET,
    DVSA_API_KEY,
    DVLA_API_KEY, // optional but recommended
  } = process.env;

  const calls = {}; // for debug output

  let make = "", model = "", fuelType = "", colour = "", firstUsedDate = "", year = "";

  // --- 1) DVSA OAuth token ---
  try {
    const tokenRes = await fetch(
      "https://login.microsoftonline.com/a455b827-244f-4c97-b5b4-ce5d13b4d00c/oauth2/v2.0/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: DVSA_CLIENT_ID,
          client_secret: DVSA_CLIENT_SECRET,
          scope: "https://tapi.dvsa.gov.uk/.default",
          grant_type: "client_credentials",
        }),
      }
    );

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      calls.token = { status: tokenRes.status, body };
      return res.status(502).json({ error: "DVSA token error", calls: debug ? calls : undefined });
    }

    const { access_token } = await tokenRes.json();

    // --- 2) DVSA vehicles (primary) ---
    const vRes = await fetch(
      `https://tapi.dvsa.gov.uk/trade/vehicles?registration=${encodeURIComponent(vrm)}`,
      { headers: { Authorization: `Bearer ${access_token}`, "x-api-key": DVSA_API_KEY } }
    );

    calls.dvsaVehicles = { status: vRes.status };
    if (vRes.ok) {
      const arr = await vRes.json();
      const v = Array.isArray(arr) && arr[0] ? arr[0] : null;
      if (v) {
        make          = (v.make || "").trim();
        model         = (v.model || "").trim();
        fuelType      = (v.fuelType || "").trim();
        colour        = (v.primaryColour || v.colour || "").trim();
        firstUsedDate = v.firstUsedDate || firstUsedDate;
      }
    } else {
      calls.dvsaVehicles.body = await vRes.text();
    }

    // --- 3) Fallback DVSA MOT tests (often contains model) ---
    if (!model) {
      const mRes = await fetch(
        `https://tapi.dvsa.gov.uk/trade/vehicles/mot-tests?registration=${encodeURIComponent(vrm)}&pageSize=1`,
        { headers: { Authorization: `Bearer ${access_token}`, "x-api-key": DVSA_API_KEY } }
      );
      calls.dvsaMotTests = { status: mRes.status };
      if (mRes.ok) {
        const arr = await mRes.json();
        const v = Array.isArray(arr) && arr[0] ? arr[0] : null;
        if (v) {
          model ||= (v.model || "").trim();
          make  ||= (v.make || "").trim();
        }
      } else {
        calls.dvsaMotTests.body = await mRes.text();
      }
    }
  } catch (e) {
    calls.dvsaError = String(e?.message || e);
  }

  // --- 4) DVLA VES for year/confirm make ---
  if (DVLA_API_KEY) {
    try {
      const dRes = await fetch(
        "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles",
        {
          method: "POST",
          headers: { "x-api-key": DVLA_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ registrationNumber: vrm }),
        }
      );
      calls.dvla = { status: dRes.status };
      if (dRes.ok) {
        const d = await dRes.json();
        year      = String(d.yearOfManufacture || year || "");
        make    ||= (d.make || "").trim();
        fuelType ||= (d.fuelType || "").trim();
        colour   ||= (d.colour || "").trim();
      } else {
        calls.dvla.body = await dRes.text();
      }
    } catch (e) {
      calls.dvlaError = String(e?.message || e);
    }
  }

  // --- Normalise model (simple tidy) ---
  const tidy = s => (s || "").toString().trim();
  const cap  = s => tidy(s).split(" ").map(w => w[0] ? (w[0].toUpperCase()+w.slice(1).toLowerCase()) : "").join(" ");
  if (model) model = cap(model);

  // --- Response ---
  const result = { vrm, year, make: cap(make), model, fuelType, colour, firstUsedDate };
  if (debug) result.calls = calls;
  return res.json(result);
}
