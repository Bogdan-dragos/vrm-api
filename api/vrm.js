export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { vrm, debug } = req.query;
  if (!vrm) return res.status(400).json({ error: "Missing vrm parameter" });

  const dvlaApiKey = process.env.DVLA_API_KEY;
  const dvsaClientId = process.env.DVSA_CLIENT_ID;
  const dvsaClientSecret = process.env.DVSA_CLIENT_SECRET;
  const dvsaApiKey = process.env.DVSA_API_KEY;
  const dvsaScope = process.env.DVSA_SCOPE_URL;
  const dvsaTokenUrl = process.env.DVSA_TOKEN_URL;

  const vdgApiKey = process.env.VDG_API_KEY;
  const vdgBase = process.env.VDG_BASE;
  const vdgPackage = process.env.VDG_PACKAGE;

  let dvlaData = {};
  let dvsaData = {};
  let vdgData = {};
  let dvsaError = null;

  try {
    // 🟩 DVLA Lookup
    const dvlaRes = await fetch(
      `https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles`,
      {
        method: "POST",
        headers: {
          "x-api-key": dvlaApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ registrationNumber: vrm }),
      }
    );

    if (dvlaRes.ok) {
      dvlaData = await dvlaRes.json();
    } else {
      dvlaData = {};
    }

    // 🟦 DVSA Token
    let token = null;
    try {
      const tokenRes = await fetch(dvsaTokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: dvsaClientId,
          client_secret: dvsaClientSecret,
          scope: dvsaScope,
          grant_type: "client_credentials",
        }),
      });
      const tokenJson = await tokenRes.json();
      token = tokenJson.access_token;
    } catch (err) {
      dvsaError = "DVSA token fetch failed";
    }

    // 🟨 DVSA MOT Lookup (optional)
    if (token) {
      const dvsaRes = await fetch(
        `https://beta.check-mot.service.gov.uk/trade/vehicles/mot-tests?registration=${vrm}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "x-api-key": dvsaApiKey,
            Accept: "application/json+v6",
          },
        }
      );

      if (dvsaRes.ok) {
        dvsaData = await dvsaRes.json();
      } else {
        dvsaError = `DVSA fetch failed (${dvsaRes.status})`;
      }
    }

    // 🟪 Vehicle Data Global (Variant)
    try {
      const vdgRes = await fetch(
        `${vdgBase}/VehicleData?RegistrationNumber=${vrm}&Package=${vdgPackage}`,
        {
          headers: {
            "x-api-key": vdgApiKey,
            Accept: "application/json",
          },
        }
      );

      if (vdgRes.ok) {
        const vdgJson = await vdgRes.json();
        vdgData = vdgJson?.Response?.DataItems?.VehicleDetails || {};
      } else {
        vdgData = { error: `VDG fetch failed (${vdgRes.status})` };
      }
    } catch (err) {
      vdgData = { error: "VDG request failed" };
    }

    // 🧠 Combined Output
    const result = {
      vrm: vrm.toUpperCase(),
      make: dvlaData.make || vdgData.Make || "",
      model: dvlaData.model || vdgData.Model || "",
      variant:
        vdgData.Variant ||
        vdgData.VehicleModelVariant ||
        vdgData.Trim ||
        "",
      fuelType: dvlaData.fuelType || vdgData.FuelType || "",
      colour: dvlaData.colour || "",
      year: dvlaData.yearOfManufacture?.toString() || vdgData.Year || "",
      firstUsedDate: dvlaData.monthOfFirstRegistration || "",
      calls: {
        dvla: { status: dvlaRes.status },
        dvsa: { status: dvsaData ? 200 : 0, error: dvsaError },
        vdg: { status: vdgData.error ? "failed" : "ok" },
      },
    };

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}
