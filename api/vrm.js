 // /api/vrm.js
// Partsworth VRM lookup: DVSA (MOT) + DVLA (VES) + VDG combiner.
// Returns the customer's vehicle profile for the chat agent's lookup_vehicle tool.
//
// Usage:
//   /api/vrm?vrm=OV17ANR
//   /api/vrm?vrm=OV17ANR&debug=1            -> include call statuses
//   /api/vrm?vrm=OV17ANR&debug=2            -> ALSO dump the full VDG Results object
//   /api/vrm?vrm=OV17ANR&sources=vdg        -> only hit VDG
//   /api/vrm?vrm=OV17ANR&sources=none       -> self-test, no external calls
//
// Env required: DVSA_CLIENT_ID, DVSA_CLIENT_SECRET, DVSA_API_KEY, DVSA_SCOPE_URL,
//               DVSA_TOKEN_URL, DVLA_API_KEY, VDG_BASE, VDG_PACKAGE, VDG_API_KEY
// Env optional: ALLOWED_ORIGINS (comma-separated list of your own domains)

// Best-effort warm cache. Survives only while the serverless instance is warm.
// For reliable caching across instances, move this to Upstash Redis.
const CACHE = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

export default async function handler(req, res) {
  // ---------- CORS (locked to an allowlist; falls back to * only if unset) ----------
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (allowed.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", "*"); // TODO: set ALLOWED_ORIGINS to stop credit abuse
  } else if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    // ---------- params ----------
    const vrm = String(req.query.vrm || "").trim().toUpperCase().replace(/\s+/g, "");
    const debug = String(req.query.debug || "");
    const debug1 = debug === "1" || debug === "2";
    const debug2 = debug === "2";
    const sourcesParam = String(req.query.sources || "dvsa,dvla,vdg").toLowerCase();
    const useDVSA = sourcesParam.includes("dvsa");
    const useDVLA = sourcesParam.includes("dvla");
    const useVDG  = sourcesParam.includes("vdg");
    const skipAll = sourcesParam === "none";

    if (!vrm) return res.status(400).json({ error: "Missing vrm param ?vrm=AB12CDE" });

    // ---------- cheap plate validation: reject junk before spending an API call ----------
    const VRM_RE = /^[A-Z0-9]{2,8}$/; // permissive; covers current, prefix, suffix and dateless
    if (!skipAll && !VRM_RE.test(vrm)) {
      return res.status(400).json({ error: "That doesn't look like a UK registration." });
    }

    // ---------- warm cache ----------
    const cached = CACHE.get(vrm);
    if (cached && !skipAll && Date.now() - cached.t < CACHE_TTL_MS) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(cached.data);
    }

    const out = {
      vrm,
      year: "", make: "", model: "", variant: "",
      variantDerived: "", dvlaModel: "",
      // fitment-critical fields the chat agent's scoring needs:
      engineSize: "", engineCode: "", transmission: "", bodyType: "",
      drivetrain: "", chassis: "",
      fuelType: "", colour: "", description: "",
      calls: { sources: sourcesParam }
    };

    // ---------- helpers ----------
    const setIfEmpty = (key, val) => {
      if (val === undefined || val === null || val === "") return;
      if (!out[key]) out[key] = typeof val === "number" ? String(val) : String(val);
    };

    // first non-empty value from a list of candidate getter functions (never throws)
    const pick = (...fns) => {
      for (const fn of fns) {
        try { const v = fn(); if (v !== undefined && v !== null && v !== "") return v; }
        catch { /* keep trying */ }
      }
      return "";
    };

    async function fetchWithTimeout(url, opt = {}, ms = 8000) {
      const ctrl = new AbortController();
      const id = setTimeout(() => ctrl.abort("timeout"), ms);
      try {
        const r = await fetch(url, { ...opt, signal: ctrl.signal });
        const txt = await r.text();
        let js = null;
        try { js = JSON.parse(txt); } catch { /* leave js null */ }
        return { ok: r.ok, status: r.status, json: js, text: txt };
      } catch (e) {
        return { ok: false, status: 0, error: String(e?.message || e) };
      } finally {
        clearTimeout(id);
      }
    }

    if (debug1) {
      out.calls.env = {
        DVSA_CLIENT_ID: !!process.env.DVSA_CLIENT_ID,
        DVSA_CLIENT_SECRET: !!process.env.DVSA_CLIENT_SECRET,
        DVSA_API_KEY: !!process.env.DVSA_API_KEY,
        DVSA_SCOPE_URL: !!process.env.DVSA_SCOPE_URL,
        DVSA_TOKEN_URL: !!process.env.DVSA_TOKEN_URL,
        DVLA_API_KEY: !!process.env.DVLA_API_KEY,
        VDG_BASE: !!process.env.VDG_BASE,
        VDG_PACKAGE: !!process.env.VDG_PACKAGE,
        VDG_API_KEY: !!process.env.VDG_API_KEY,
      };
    }

    // ---------- self-test: no external calls ----------
    if (skipAll) {
      out.description = [out.year, out.make, out.model, out.variant || out.variantDerived, out.fuelType]
        .filter(Boolean).join(" ");
      return res.status(200).json(out);
    }

    // ---------- DVSA (token + vehicle) ----------
    if (useDVSA) {
      let token = "";
      const tokenRes = await fetchWithTimeout(process.env.DVSA_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.DVSA_CLIENT_ID || "",
          client_secret: process.env.DVSA_CLIENT_SECRET || "",
          scope: process.env.DVSA_SCOPE_URL || "",
          grant_type: "client_credentials",
        }),
      }, 8000);
      if (debug1) out.calls.dvsaToken = { status: tokenRes.status, ok: tokenRes.ok, err: tokenRes.error };
      token = tokenRes.json?.access_token || "";

      if (token) {
        const url = `https://history.mot.api.gov.uk/v1/trade/vehicles/registration/${encodeURIComponent(vrm)}`;
        const r = await fetchWithTimeout(url, {
          headers: {
            "Authorization": `Bearer ${token}`,
            "X-API-Key": process.env.DVSA_API_KEY || "",
            "Accept": "application/json"
          }
        }, 8000);
        if (debug1) out.calls.dvsaVehicle = { status: r.status, ok: r.ok, err: r.error };
        if (r.ok && r.json) {
          setIfEmpty("make", r.json.make);
          setIfEmpty("model", r.json.model);
          setIfEmpty("fuelType", r.json.fuelType);
          setIfEmpty("colour", r.json.colour);
          if (r.json.yearOfManufacture) setIfEmpty("year", r.json.yearOfManufacture);
        }
      }
    }

    // ---------- DVLA VES (fills year/make/fuel/colour gaps) ----------
    if (useDVLA) {
      const r = await fetchWithTimeout("https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles", {
        method: "POST",
        headers: { "x-api-key": process.env.DVLA_API_KEY || "", "Content-Type": "application/json" },
        body: JSON.stringify({ registrationNumber: vrm })
      }, 8000);
      if (debug1) out.calls.dvla = { status: r.status, ok: r.ok, err: r.error };
      if (r.ok && r.json) {
        setIfEmpty("year", r.json.yearOfManufacture);
        setIfEmpty("make", r.json.make);
        setIfEmpty("colour", r.json.colour);
        setIfEmpty("fuelType", r.json.fuelType);
        // DVLA also gives engineCapacity (cc). Useful as a fallback engine signal.
        if (r.json.engineCapacity) setIfEmpty("engineSize", r.json.engineCapacity);
      }
    }

    // ---------- VDG (rich model/variant + fitment enrichment) ----------
    if (useVDG) {
      const vdgBase = ((process.env.VDG_BASE || "https://uk.api.vehicledataglobal.com")
        .trim().split(/\s+/)[0] || "https://uk.api.vehicledataglobal.com").replace(/\/+$/, "");
      const vdgUrl = `${vdgBase}/r2/lookup?packagename=${encodeURIComponent(process.env.VDG_PACKAGE || "VehicleDetails")}&apikey=${encodeURIComponent(process.env.VDG_API_KEY || "")}&vrm=${encodeURIComponent(vrm)}`;
      const r = await fetchWithTimeout(vdgUrl, { method: "GET", headers: { "Accept": "application/json" } }, 8000);

      if (debug1) {
        out.calls.vdgRequest = { url: `${vdgBase}/r2/lookup?packagename=${encodeURIComponent(process.env.VDG_PACKAGE || "VehicleDetails")}&vrm=${encodeURIComponent(vrm)}&apikey=***` };
        out.calls.vdg = { status: r.status, ok: r.ok, err: r.error };
        out.calls.vdgBodyPreview = (r.text || "").slice(0, 600);
      }

      if (r.ok && r.json) {
        let usedNested = false;

        if (r.json.Results) {
          const R  = r.json.Results;
          const VD = R.VehicleDetails || {};
          const VI = VD.VehicleIdentification || {};
          const VH = R.VehicleHistory || {};
          const MD = R.ModelDetails || {};
          const MI = MD.ModelIdentification || {};

          // proven extractions (unchanged) ----------------------------------
          setIfEmpty("make", pick(() => VI.DvlaMake, () => MI.Make));
          setIfEmpty("model", pick(() => MI.Range, () => VI.DvlaModel, () => MI.Model));
          setIfEmpty("variant", pick(() => MI.ModelVariant, () => MI.Series));
          setIfEmpty("fuelType", () => VI.DvlaFuelType);
          setIfEmpty("colour", () => VH?.ColourDetails?.CurrentColour);
          setIfEmpty("year", pick(() => (VI.YearOfManufacture ?? "") !== "" ? String(VI.YearOfManufacture) : ""));

          const dvlaModelFull = String(VI.DvlaModel || "");
          if (dvlaModelFull) out.dvlaModel = dvlaModelFull;
          if (!out.variant && dvlaModelFull) {
            const base = String(MI.Range || out.model || "").trim();
            let tail = dvlaModelFull;
            if (base && new RegExp(`^${base}\\b`, "i").test(dvlaModelFull)) {
              tail = dvlaModelFull.replace(new RegExp(`^${base}\\s*`, "i"), "").trim();
            } else if (out.model && new RegExp(`^${out.model}\\b`, "i").test(dvlaModelFull)) {
              tail = dvlaModelFull.replace(new RegExp(`^${out.model}\\s*`, "i"), "").trim();
            }
            tail = tail.replace(/\s{2,}/g, " ").trim();
            if (tail && tail.length >= 3) out.variantDerived = tail;
          }

          // ENRICHMENT: fitment-critical fields ------------------------------
          // NOTE: VDG nests these differently per package. The candidate paths
          // below are best guesses. Run ?debug=2 against a real reg, read
          // out.calls.vdgResultsFull, and correct the paths to match YOUR payload.
          const DTD = VD.DvlaTechnicalDetails || {};
          const PWR = MD.Powertrain || VD.Powertrain || {};
          const BDY = MD.BodyDetails || VD.BodyDetails || {};
          const TRN = PWR.Transmission || MD.Transmission || {};

          setIfEmpty("engineSize", pick(
            () => VI.EngineCapacityCc, () => DTD.EngineCapacityCc,
            () => PWR.IceDetails?.EngineCapacityCc, () => MI.EngineCapacity
          ));
          setIfEmpty("engineCode", pick(
            () => VI.EngineNumber, () => PWR.IceDetails?.EngineDescription, () => MI.EngineFamily
          ));
          setIfEmpty("transmission", pick(
            () => TRN.TransmissionType, () => PWR.TransmissionType, () => MI.Transmission
          ));
          setIfEmpty("bodyType", pick(
            () => BDY.BodyStyle, () => MI.BodyStyle, () => VI.DvlaBodyType
          ));
          setIfEmpty("drivetrain", pick(
            () => PWR.DriveType, () => MI.DriveType, () => BDY.DriveType
          ));
          setIfEmpty("chassis", pick(
            () => MI.SeriesDescription, () => MI.Series, () => MI.PlatformCode
          ));

          if (debug2) out.calls.vdgResultsFull = R; // full dump to locate real field names

          usedNested = true;
          if (debug1) out.calls.vdgSource = "nested";
        }

        // flat fallback ------------------------------------------------------
        const data = r.json.data || r.json;
        if (!usedNested && data && typeof data === "object") {
          setIfEmpty("make", data.Make);
          setIfEmpty("model", data.Model);
          setIfEmpty("variant", data.Variant || data.Derivative || data.Trim);
          setIfEmpty("year", data.YearOfManufacture);
          setIfEmpty("fuelType", data.FuelType);
          setIfEmpty("colour", data.Colour);
          setIfEmpty("engineSize", data.EngineCapacity || data.EngineSize);
          setIfEmpty("transmission", data.Transmission);
          setIfEmpty("bodyType", data.BodyStyle || data.BodyType);
          if (!out.variant && data.Model) {
            const base = String(out.model || "").trim();
            let tail = String(data.Model);
            if (base && new RegExp(`^${base}\\b`, "i").test(tail)) {
              tail = tail.replace(new RegExp(`^${base}\\s*`, "i"), "").trim();
            }
            tail = tail.replace(/\s{2,}/g, " ").trim();
            if (tail && tail.length >= 3) out.variantDerived = tail;
          }
          if (debug1) out.calls.vdgSource = "flat";
        }
      } else if (r.status === 404 && debug1) {
        out.calls.vdgNotFound = true;
      }
    }

    // ---------- final description ----------
    const variantForDesc = out.variant || out.variantDerived || "";
    out.description = [out.year, out.make, out.model, variantForDesc, out.fuelType]
      .filter(Boolean).join(" ");

    // ---------- cache + return ----------
    CACHE.set(vrm, { t: Date.now(), data: out });
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(out);

  } catch (e) {
    return res.status(500).json({ error: "Unhandled error", message: String(e?.message || e) });
  }
}
