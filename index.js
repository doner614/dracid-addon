const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { scrapeList } = require("./scraper");
const { badgePoster } = require("./poster");
const tmdb = require("./tmdb");

const PORT = process.env.PORT || 7000;
// URL público do addon (tem de ser alcançável pelo Stremio, é daqui que saem os posters com badge)
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const CACHE_MS = (parseInt(process.env.CACHE_MINUTES, 10) || 30) * 60 * 1000;
const COUNTRY = (process.env.COUNTRY || "US").toUpperCase(); // país usado para plataformas/lançamento digital no TMDB
const TMDB_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;

const SITE = "https://dracid77.github.io/lists";
const LISTS = {
  "upcoming-movies": { url: `${SITE}/upcoming-movies`, name: "Upcoming Movies (badges)", badge: true,  onlyStreamingVod: false },
  "released-movies": { url: `${SITE}/released-movies`, name: "2026 Released Movies (Streaming/VOD)", badge: false, onlyStreamingVod: true }
};

// ---------- Cache das listas (scraping) ----------
const cache = {};
async function getRawList(key) {
  const c = cache[key];
  if (c && Date.now() - c.time < CACHE_MS) return c.items;
  try {
    const items = await scrapeList(LISTS[key].url);
    cache[key] = { items, time: Date.now() };
    return items;
  } catch (e) {
    console.error(`Erro a ler ${key}:`, e.message);
    return c ? c.items : [];
  }
}

// ---------- Enriquecimento com o TMDB (em segundo plano) ----------
const tmdbCache = new Map(); // tmdbId -> { platform, time }
const info = { enriching: false, done: 0, total: 0, lastError: null };

const platformOf = i => i.platform || (tmdbCache.get(i.tmdbId) || {}).platform || null;

async function enrich(raw) {
  if (!tmdb.enabled || info.enriching) return;
  const now = Date.now();
  const todo = raw.filter(i => !i.platform && i.tmdbId && !(tmdbCache.get(i.tmdbId) && now - tmdbCache.get(i.tmdbId).time < TMDB_TTL_MS));
  if (!todo.length) return;

  Object.assign(info, { enriching: true, done: 0, total: todo.length });
  let idx = 0;
  const worker = async () => {
    while (idx < todo.length) {
      const it = todo[idx++];
      try {
        tmdbCache.set(it.tmdbId, { platform: await tmdb.lookup(it.tmdbId, COUNTRY), time: Date.now() });
      } catch (e) {
        info.lastError = e.message;
        if (/HTTP 40[13]/.test(e.message)) idx = todo.length; // chave inválida: pára
      }
      info.done++;
    }
  };
  try { await Promise.all(Array.from({ length: 8 }, worker)); }
  finally { info.enriching = false; }
}

// Lista final de cada catálogo
async function getList(key) {
  const raw = await getRawList(key);
  if (!LISTS[key].onlyStreamingVod) return raw;
  enrich(raw); // não espera: o catálogo vai enchendo à medida que o TMDB responde
  return raw.map(i => ({ ...i, platform: platformOf(i) })).filter(i => i.platform);
}

// ---------- Manifest ----------
const manifest = {
  id: "community.dracid.lists.custom",
  version: "1.1.0",
  name: "Dracid's Lists (custom)",
  description: "Listas de lançamentos digitais com badges de plataforma/data e filtro streaming/VOD",
  resources: ["catalog"],
  types: ["movie"],
  catalogs: Object.entries(LISTS).map(([id, l]) => ({
    type: "movie",
    id,
    name: l.name,
    extra: [{ name: "skip" }]
  }))
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "movie" || !LISTS[id]) return { metas: [] };

  const skip = parseInt(extra && extra.skip, 10) || 0;
  const items = (await getList(id)).slice(skip, skip + PAGE_SIZE);

  const metas = items.map(i => ({
    id: i.id, // IMDb ID → o Stremio vai buscar o resto dos detalhes ao Cinemeta
    type: "movie",
    name: i.title,
    poster: LISTS[id].badge && i.poster ? `${BASE_URL}/poster/${id}/${i.id}.jpg` : i.poster,
    description: [i.platform, i.synopsis].filter(Boolean).join(" — "),
    releaseInfo: new Date(i.date).getUTCFullYear().toString(),
    released: i.date
  }));

  // Enquanto o TMDB ainda está a responder, o Stremio volta a pedir mais cedo
  return { metas, cacheMaxAge: info.enriching ? 60 : 3600 };
});

// ---------- Servidor ----------
const app = express();

// Poster com badge
const posterCache = new Map();
app.get("/poster/:list/:imdb.jpg", async (req, res) => {
  const { list, imdb } = req.params;
  if (!LISTS[list]) return res.sendStatus(404);

  const item = (await getList(list)).find(i => i.id === imdb);
  if (!item || !item.poster) return res.sendStatus(404);

  const key = `${imdb}|${item.platform}|${item.date}`;
  try {
    let buf = posterCache.get(key);
    if (!buf) {
      buf = await badgePoster(item.poster, item.platform, item.date);
      if (posterCache.size > 600) posterCache.delete(posterCache.keys().next().value);
      posterCache.set(key, buf);
    }
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" });
    res.send(buf);
  } catch (e) {
    console.error("Erro no poster:", e.message);
    res.redirect(item.poster); // fallback: poster original
  }
});

// Diagnóstico: /debug/released-movies
app.get("/debug/:list", async (req, res) => {
  const key = req.params.list;
  if (!LISTS[key]) return res.sendStatus(404);

  const raw = await getRawList(key);
  const kept = await getList(key);
  const effective = LISTS[key].onlyStreamingVod ? raw.map(i => ({ ...i, platform: platformOf(i) })) : raw;

  const platforms = {};
  effective.forEach(i => { const p = i.platform || "(nenhuma)"; platforms[p] = (platforms[p] || 0) + 1; });
  const dropped = effective.filter(i => !i.platform);

  res.json({
    rawCount: raw.length,
    keptCount: kept.length,
    tmdb: { enabled: tmdb.enabled, country: COUNTRY, ...info, cached: tmdbCache.size },
    platforms,
    droppedSample: Array.from({ length: Math.min(4, dropped.length) }, (_, n) => dropped[Math.floor(n * dropped.length / 4)])
      .map(i => ({ id: i.id, title: i.title, date: i.date, tmdbId: i.tmdbId })),
    sample: kept.slice(0, 2).map(i => ({ id: i.id, title: i.title, platform: i.platform, date: i.date }))
  });
});

app.use(getRouter(builder.getInterface()));

app.listen(PORT, () => {
  console.log(`Addon em ${BASE_URL}/manifest.json (TMDB ${tmdb.enabled ? "ativo, país " + COUNTRY : "desligado"})`);
  Object.keys(LISTS).forEach(k => getList(k)); // aquece a cache e arranca o enriquecimento
});
