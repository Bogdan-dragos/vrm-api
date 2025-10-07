// /api/vrm.js
// Returns: { vrm, year, make, model, fuelType, colour, variant, description, ... }
// Uses DVSA + DVLA like before, and adds CAP HPI VRMValuation (CAPDer = variant).

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const vrm = (req.query.vrm || "").trim().toUpperCase();
  const debug = String(req.query.debug || "") === "1";
  if (!vrm) return res.status(400).json({ error: "Missing vrm param ?vrm=AB12CDE" });

  const out = {
    vrm, year: "", make: "", model: "", fuelType: "", colour: "",
    variant: "", description: "", calls: {}
  };

  // ---------------- DVSA (token + vehicle) ----------------
  let token = "";
  try {
    const t = await fetch(process.env.DVSA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DVSA_CLIENT_ID,
        client_secret: process.env.DVSA_CLIENT_SECRET,
        scope: process.env.DVSA_SCOPE_URL,
        grant_type: "client_credentials",
      }),
    });
    const tj = await t.json();
    if (!t.ok) throw new Error(`DVSA token ${t.status}`);
    token = tj.access_token;
    if (debug) out.calls.dvsaToken = { status: t.status };
  } catch (e) {
    out.calls.dvsaTokenError = e.message;
  }

  if (token) {
    try {
      const url = `https://history.mot.api.gov.uk/v1/trade/vehicles/registration/${encodeURIComponent(vrm)}`;
      const r = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "X-API-Key": process.env.DVSA_API_KEY,
          "Accept": "application/json"
        }
      });
      const j = await r.json().catch(()=>null);
      if (debug) out.calls.dvsaVehicle = { status: r.status };
      if (r.ok && j) {
        out.make     = j.make     || out.make;
        out.model    = j.model    || out.model;
        out.fuelType = j.fuelType || out.fuelType;
        out.colour   = j.colour   || out.colour;
        if (j.yearOfManufacture) out.year = String(j.yearOfManufacture);
      }
    } catch (e) {
      out.calls.dvsaVehicleError = e.message;
    }
  }

  // ---------------- DVLA fallback (year/make/fuel/colour) ----------------
  try {
    const r = await fetch("https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles", {
      method: "POST",
      headers: {
        "x-api-key": process.env.DVLA_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ registrationNumber: vrm })
    });
    const j = await r.json();
    if (debug) out.calls.dvla = { status: r.status };
    if (r.ok && j) {
      out.year     = String(j.yearOfManufacture || out.year || "");
      out.make     = j.make   || out.make;
      out.colour   = j.colour || out.colour;
      out.fuelType = j.fuelType || out.fuelType;
    }
  } catch (e) {
    out.calls.dvlaError = e.message;
  }

  // ---------------- CAP HPI VRMValuation (to get DERIVATIVE/VARIANT) ----------------
  // Docs list VRMValuation here and show CAPMan/CAPRange/CAPMod/CAPDer in the response. 
  // https://soap.cap.co.uk/vrm/capvrm.asmx/VRMValuation (SOAP).  [oai_citation:2‡developer.cap.co.uk](https://developer.cap.co.uk/webservices)

  if (process.env.CAP_SUBSCRIBER_ID && process.env.CAP_PASSWORD) {
    try {
      const soapUrl = "https://soap.cap.co.uk/vrm/capvrm.asmx/VRMValuation";
      const ns = "https://soap.cap.co.uk/vrm";
      const body = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <VRMValuation xmlns="${ns}">
      <SubscriberID>${escapeXml(process.env.CAP_SUBSCRIBER_ID)}</SubscriberID>
      <Password>${escapeXml(process.env.CAP_PASSWORD)}</Password>
      <VRM>${escapeXml(vrm)}</VRM>
      <Mileage>0</Mileage>
      <StandardEquipmentRequired>false</StandardEquipmentRequired>
    </VRMValuation>
  </soap:Body>
</soap:Envelope>`;

      const resp = await fetch(soapUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "SOAPAction": `${ns}/VRMValuation`
        },
        body
      });

      const xml = await resp.text();
      if (debug) out.calls.cap = { status: resp.status };

      if (resp.ok) {
        // naive XML pulls (enough for these tags)
        const capMan = tag(xml, "CAPMan");
        const capMod = tag(xml, "CAPMod");
        const capDer = tag(xml, "CAPDer");
        // prefer CAP's make/model if absent
        out.make   = out.make  || capMan || "";
        out.model  = out.model || capMod || "";
        out.variant = capDer || out.variant || "";
      } else {
        out.calls.capError = `HTTP ${resp.status}`;
      }
    } catch (e) {
      out.calls.capError = e.message;
    }
  } else {
    out.calls.capSkipped = "No CAP_SUBSCRIBER_ID/CAP_PASSWORD";
  }

  // ---------------- Build a nice description ----------------
  out.description = [out.year, out.make, out.model, out.variant, out.fuelType]
    .filter(Boolean).join(" ");

  return res.status(200).json(out);
}

// --- tiny XML extractor (no dependency) ---
function tag(xml, name) {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}
function escapeXml(s) {
  return String(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&apos;");
}
