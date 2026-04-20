require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const cron = require("node-cron");
const twilio = require("twilio");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "changeme";
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// ─── DHMZ PARSER ─────────────────────────────────────────────────────────────

async function fetchNavtex() {
  const url = "https://meteo.hr/prognoze.php?section=prognoze_specp&param=pomorci";

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AdriaBrief/1.0)",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "hr,en;q=0.9",
    },
    timeout: 15000,
  });

  if (!res.ok) throw new Error(`DHMZ HTTP ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const result = {
    izdano: null,
    upozorenje: null,
    stanje: null,
    sj_jadran: null,
    sr_jadran: null,
    j_jadran: null,
  };

  // Issue datetime — "dan 20.04.2026 u 18:00 sati"
  $("h4").each((_, el) => {
    const text = $(el).text().trim();
    if (text.includes("dan") && text.includes("sati")) {
      result.izdano = text.replace("Prognoza za pomorce (NAVTEX),", "").trim();
    }
  });

  // Forecast sections by h5 headings
  $("h5").each((_, el) => {
    const heading = $(el).text().trim().toLowerCase();
    const chunks = [];
    let next = $(el).next();
    while (next.length && !next.is("h5") && !next.is("table") && !next.is("h4")) {
      const t = next.text().trim();
      if (t) chunks.push(t);
      next = next.next();
    }
    const text = chunks.join(" ").trim();
    if (!text) return;

    if (heading.includes("upozorenje"))                              result.upozorenje = text;
    else if (heading.includes("stanje"))                             result.stanje = text;
    else if (heading.includes("sjeverni jadran"))                    result.sj_jadran = text;
    else if (heading.includes("srednji jadran"))                     result.sr_jadran = text;
    else if (heading.includes("južni jadran") || heading.includes("juzni jadran")) result.j_jadran = text;
  });

  if (!result.sj_jadran && !result.sr_jadran) {
    throw new Error("DHMZ sekcije niso bile najdene na strani");
  }

  return result;
}

// ─── SEA TEMPS ───────────────────────────────────────────────────────────────

async function fetchSeaTemps() {
  const locs = [
    { name: "Rijeka",    lat: 45.33, lng: 14.44 },
    { name: "Split",     lat: 43.50, lng: 16.44 },
    { name: "Dubrovnik", lat: 42.65, lng: 18.09 },
  ];
  const hour = new Date().getHours();

  const results = await Promise.all(locs.map(async ({ name, lat, lng }) => {
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lng}&hourly=sea_surface_temperature&timezone=Europe/Zagreb&forecast_days=1`;
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status} (${name})`);
    const d = await res.json();
    const temps = d.hourly?.sea_surface_temperature;
    if (!temps?.length) throw new Error(`Manjka temperatura za ${name}`);
    return `${name} ${Math.round(temps[hour] ?? temps[0])}°C`;
  }));

  return results.join(" · ");
}

// ─── SUN TIMES ───────────────────────────────────────────────────────────────

function calcSunTimes() {
  const now = new Date();
  const lat = 43.5 * Math.PI / 180;
  const lng = 16.44;
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const B = (360 / 365) * (dayOfYear - 81) * Math.PI / 180;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const solarNoon = 720 - lng * 4 - eot;
  const declination = 23.45 * Math.sin(B) * Math.PI / 180;
  const cosHA = (Math.cos(90.833 * Math.PI / 180) - Math.sin(lat) * Math.sin(declination)) / (Math.cos(lat) * Math.cos(declination));
  const ha = Math.acos(Math.max(-1, Math.min(1, cosHA))) * 180 / Math.PI;
  const fmt = (m) => {
    const t = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(t / 60)).padStart(2,"0")}:${String(Math.floor(t % 60)).padStart(2,"0")}`;
  };
  return { rise: fmt(solarNoon - ha * 4 + 120), set: fmt(solarNoon + ha * 4 + 120) };
}

// ─── BUILD MESSAGE ────────────────────────────────────────────────────────────

function buildMessage(navtex, seaTemps, sun) {
  const date = new Date().toLocaleDateString("hr-HR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  let prognoza = "";
  if (navtex.upozorenje) prognoza += `UPOZORENJE:\n${navtex.upozorenje}\n\n`;
  if (navtex.stanje)     prognoza += `STANJE:\n${navtex.stanje}\n\n`;
  if (navtex.sj_jadran)  prognoza += `SJEVERNI JADRAN:\n${navtex.sj_jadran}\n\n`;
  if (navtex.sr_jadran)  prognoza += `SREDNJI JADRAN:\n${navtex.sr_jadran}\n\n`;
  if (navtex.j_jadran)   prognoza += `JUŽNI JADRAN:\n${navtex.j_jadran}`;

  return (
    `🌊 JADRAN BRIEF — ${date}\n` +
    `📋 Izdano: ${navtex.izdano || "—"}\n` +
    `🌅 Izlaz: ${sun.rise} | Zalaz: ${sun.set}\n\n` +
    `🌡️ TEMPERATURA MORA\n${seaTemps}\n\n` +
    `⚓ PROGNOZA DHMZ/NAVTEX\n${prognoza.trim()}\n\n` +
    `📡 topsailor.yachting`
  );
}

// ─── SEND TO ALL ACTIVE SUBSCRIBERS ──────────────────────────────────────────

async function sendBriefToAll() {
  const { data: subs, error } = await supabase
    .from("subscribers")
    .select("*")
    .eq("active", true);

  if (error) throw new Error("Supabase error: " + error.message);
  if (!subs?.length) { console.log("Ni aktivnih naročnikov."); return { sent: 0, total: 0 }; }

  const [navtex, seaTemps] = await Promise.all([fetchNavtex(), fetchSeaTemps()]);
  const sun = calcSunTimes();
  const message = buildMessage(navtex, seaTemps, sun);

  if (!TWILIO_SID || !TWILIO_TOKEN) throw new Error("Twilio ni konfiguriran");

  const client = twilio(TWILIO_SID, TWILIO_TOKEN);
  const results = await Promise.allSettled(
    subs.map(sub =>
      client.messages.create({
        from: TWILIO_FROM,
        to: `whatsapp:${sub.whatsapp}`,
        body: message,
      })
    )
  );

  const sent = results.filter(r => r.status === "fulfilled").length;
  const failed = results
    .filter(r => r.status === "rejected")
    .map(r => r.reason?.message);

  console.log(`✅ Brief poslan: ${sent}/${subs.length}`);
  if (failed.length) console.error("❌ Napake:", failed);

  return { sent, total: subs.length, failed };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Preveri ali je DHMZ parser ok + vrni brief
app.get("/api/brief", async (req, res) => {
  try {
    const [navtex, seaTemps] = await Promise.all([fetchNavtex(), fetchSeaTemps()]);
    const sun = calcSunTimes();
    const message = buildMessage(navtex, seaTemps, sun);
    res.json({ ok: true, message, navtex, seaTemps, sun });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Ročno pošlji vsem
app.post("/api/send", requireAdmin, async (req, res) => {
  try {
    const result = await sendBriefToAll();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Seznam naročnikov
app.get("/api/subscribers", requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from("subscribers").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, subscribers: data });
});

// Dodaj naročnika
app.post("/api/subscribers", requireAdmin, async (req, res) => {
  const { name, whatsapp, company, language } = req.body;
  if (!name || !whatsapp) return res.status(400).json({ ok: false, error: "name in whatsapp sta obvezna" });

  const { data, error } = await supabase
    .from("subscribers")
    .insert([{ name, whatsapp, company: company || null, language: language || "hr" }])
    .select()
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, subscriber: data });
});

// Uredi naročnika (aktiviraj/deaktiviraj)
app.patch("/api/subscribers/:id", requireAdmin, async (req, res) => {
  const { active, name, whatsapp, company } = req.body;
  const { data, error } = await supabase
    .from("subscribers")
    .update({ active, name, whatsapp, company })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, subscriber: data });
});

// Briši naročnika
app.delete("/api/subscribers/:id", requireAdmin, async (req, res) => {
  const { error } = await supabase.from("subscribers").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// Health check
app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─── CRON — vsak dan ob 07:00 Europe/Zagreb ──────────────────────────────────

cron.schedule("0 7 * * *", async () => {
  console.log("⏰ Cron 07:00 — pošiljam jutranji brief...");
  try {
    const result = await sendBriefToAll();
    console.log(`✅ Cron zaključen: ${result.sent}/${result.total}`);
  } catch (err) {
    console.error("❌ Cron napaka:", err.message);
  }
}, { timezone: "Europe/Zagreb" });

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🌊 Adria Brief running on port ${PORT}`);
});
