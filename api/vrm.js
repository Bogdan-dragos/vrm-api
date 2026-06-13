// /api/vrm.js
// Partsworth VRM lookup. VDG-only (DVSA + DVLA disabled by default).
// Returns the customer's vehicle profile for the chat agent's lookup_vehicle tool.
//
// Usage:
//   /api/vrm?vrm=E4BOG
//   /api/vrm?vrm=E4BOG&debug=1            -> include call statuses
//   /api/vrm?vrm=E4BOG&debug=2            -> ALSO dump the full VDG Results object
//   /api/vrm?vrm=E4BOG&sources=dvsa,dvla,vdg  -> re-enable the others if ever needed
//   /api/vrm?vrm=E4BOG&sources=none       -> self-test, no external calls
//
// Each VDG lookup is charged (~£0.15). The warm cache below avoids paying twice
// for the same reg within an hour while the serverless instance stays warm.
//
// Env required: VDG_BASE, VDG_PACKAGE, VDG_API_KEY
// Env optional: ALLOWED_ORIGINS (comma-separated list of your own domains)
//               DVSA_* and DVLA_API_KEY only needed if you re-enable those sources.

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
    // DVSA + DVLA are OFF by default now. VDG only.
    const sourcesParam = String(req.query.sources || "vdg").toLowerCase();
    const useDVSA = sourcesParam.includes("dvsa");
    const useDVLA = sourcesParam.includes("dvla");
    const useVDG  = sourcesParam.includes("vdg");
    const skipAll = sourcesParam === "none";

    if (!vrm) return res.status(400).json({ error: "Missing vrm param ?vrm=AB12CDE" });

    const VRM_RE = /^[A-Z0-9]{2,8}$/;
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
      // fitment-critical fields for the chat agent's scoring:
      engineSize: "", engineCode: "", engineDescription: "",
      transmission: "", gears: "", bodyType: "", doors: "",
      drivetrain: "", chassis: "", platform: "", platformShared: "",
      yearStart: "", yearEnd: "", yearRange: "",
      fuelType: "", colour: "", description: "",
      calls: { sources: sourcesParam }
    };

    // ---------- helpers ----------
    const setIfEmpty = (key, val) => {
      if (val === undefined || val === null || val === "") return;
      if (!out[key]) out[key] = (typeof val === "number" || typeof val === "boolean") ? String(val) : String(val);
    };

    // first non-empty value from candidate getter functions (never throws)
    const pick = (...fns) => {
      for (const fn of fns) {
        try { const v = fn(); if (v !== undefined && v !== null && v !== "") return v; }
        catch { /* keep trying */ }
      }
      return "";
    };

    const yearOf = (iso) => {
      const s = String(iso || "");
      const m = s.match(/^(\d{4})/);
      return m ? m[1] : "";
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
        VDG_BASE: !!process.env.VDG_BASE,
        VDG_PACKAGE: !!process.env.VDG_PACKAGE,
        VDG_API_KEY: !!process.env.VDG_API_KEY,
      };
    }

    if (skipAll) {
      out.description = [out.year, out.make, out.model, out.variant || out.variantDerived, out.fuelType]
        .filter(Boolean).join(" ");
      return res.status(200).json(out);
    }

    // ---------- DVSA (disabled by default; behind flag) ----------
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
          headers: { "Authorization": `Bearer ${token}`, "X-API-Key": process.env.DVSA_API_KEY || "", "Accept": "application/json" }
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

    // ---------- DVLA (disabled by default; behind flag) ----------
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
        if (r.json.engineCapacity) setIfEmpty("engineSize", r.json.engineCapacity);
      }
    }

    // ---------- VDG (primary source; field paths confirmed against live payload) ----------
    if (useVDG) {
      const vdgBase = ((process.env.VDG_BASE || "https://uk.api.vehicledataglobal.com")
        .trim().split(/\s+/)[0] || "https://uk.api.vehicledataglobal.com").replace(/\/+$/, "");
      const vdgUrl = `${vdgBase}/r2/lookup?packagename=${encodeURIComponent(process.env.VDG_PACKAGE || "VehicleDetails")}&apikey=${encodeURIComponent(process.env.VDG_API_KEY || "")}&vrm=${encodeURIComponent(vrm)}`;
      const r = await fetchWithTimeout(vdgUrl, { method: "GET", headers: { "Accept": "application/json" } }, 8000);

      if (debug1) {
        out.calls.vdgRequest = { url: `${vdgBase}/r2/lookup?packagename=${encodeURIComponent(process.env.VDG_PACKAGE || "VehicleDetails")}&vrm=${encodeURIComponent(vrm)}&apikey=***` };
        out.calls.vdg = { status: r.status, ok: r.ok, err: r.error };
      }

      if (r.ok && r.json && r.json.Results) {
        const R   = r.json.Results;
        const VD  = R.VehicleDetails || {};
        const VI  = VD.VehicleIdentification || {};
        const DTD = VD.DvlaTechnicalDetails || {};
        const VH  = VD.VehicleHistory || R.VehicleHistory || {};
        const MD  = R.ModelDetails || {};
        const MI  = MD.ModelIdentification || {};
        const BDY = MD.BodyDetails || {};
        const PWR = MD.Powertrain || {};
        const ICE = PWR.IceDetails || {};
        const TRN = PWR.Transmission || {};

        // identity
        setIfEmpty("make", pick(() => VI.DvlaMake, () => MI.Make));
        setIfEmpty("model", pick(() => MI.Range, () => MI.Model, () => VI.DvlaModel));
        setIfEmpty("variant", pick(() => MI.ModelVariant, () => MI.Series));
        setIfEmpty("year", pick(() => VI.YearOfManufacture, () => yearOf(MI.IntroductionDate)));
        setIfEmpty("fuelType", pick(() => PWR.FuelType, () => VI.DvlaFuelType));
        setIfEmpty("colour", pick(() => VH?.ColourDetails?.CurrentColour, () => VI.DvlaColour));

        const dvlaModelFull = String(VI.DvlaModel || "");
        if (dvlaModelFull) out.dvlaModel = dvlaModelFull;
        if (!out.variant && dvlaModelFull) {
          const base = String(MI.Range || out.model || "").trim();
          let tail = dvlaModelFull;
          if (base && new RegExp(`^${base}\\b`, "i").test(dvlaModelFull)) {
            tail = dvlaModelFull.replace(new RegExp(`^${base}\\s*`, "i"), "").trim();
          }
          tail = tail.replace(/\s{2,}/g, " ").trim();
          if (tail && tail.length >= 3) out.variantDerived = tail;
        }

        // engine
        setIfEmpty("engineSize", pick(() => ICE.EngineCapacityCc, () => DTD.EngineCapacityCc));
        setIfEmpty("engineCode", pick(() => VI.EngineNumber, () => ICE.EngineFamily));
        setIfEmpty("engineDescription", pick(() => ICE.EngineDescription));

        // drivetrain / transmission
        setIfEmpty("transmission", pick(() => TRN.TransmissionType));
        setIfEmpty("gears", pick(() => TRN.NumberOfGears));
        setIfEmpty("drivetrain", pick(() => TRN.DriveType, () => TRN.DrivingAxle));

        // body
        setIfEmpty("bodyType", pick(() => BDY.BodyStyle, () => VI.DvlaBodyType));
        setIfEmpty("doors", pick(() => BDY.NumberOfDoors));
        setIfEmpty("chassis", pick(() => MI.Series, () => MI.SeriesDescription));

        // PLATFORM: the key cross-fitment signal (panels shared across fuel/engine variants)
        setIfEmpty("platform", pick(() => BDY.PlatformName));
        setIfEmpty("platformShared", pick(() => BDY.PlatformIsSharedAcrossModels));

        // model production year range (use for compatible-years matching)
        out.yearStart = yearOf(MI.StartDate) || yearOf(MI.IntroductionDate) || "";
        out.yearEnd   = yearOf(MI.EndDate) || "";
        if (out.yearStart || out.yearEnd) {
          out.yearRange = `${out.yearStart || "?"}-${out.yearEnd || "present"}`;
        }

        if (debug2) out.calls.vdgResultsFull = R;
        if (debug1) out.calls.vdgSource = "nested";
      } else if (debug1) {
        out.calls.vdgStatus = r.status;
        out.calls.vdgBodyPreview = (r.text || "").slice(0, 400);
      }
    }

    // ---------- final description ----------
    const variantForDesc = out.variant || out.variantDerived || "";
    out.description = [out.year, out.make, out.model, variantForDesc, out.fuelType]
      .filter(Boolean).join(" ");

    CACHE.set(vrm, { t: Date.now(), data: out });
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(out);

  } catch (e) {
    return res.status(500).json({ error: "Unhandled error", message: String(e?.message || e) });
  }
}
