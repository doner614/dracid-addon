const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { scrapeList } = require("./scraper");
const { badgePoster } = require("./poster");

const PORT = process.env.PORT || 7000;
// URL público do addon (tem de ser alcançável pelo Stremio, é daqui que saem os posters com badge)
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const CACHE_MS = (parseInt(process.env.CACHE_MINUTES, 10) || 30) * 60 * 1000;
const PAGE_SIZE = 100;

const SITE = "https://dracid77.github.io/lists";
const LISTS = {
  "upcoming-movies": { url: `${SITE}/upcoming-movies`, name: "Upcoming Movies (badges)", badge: true,  onlyStreamingVod: false },
  "released-movies": { url: `${SITE}/released-movies`, name: "2026 Released Movies (Streaming/VOD)", badge: false, onlyStreamingVod: true }
};

// ---------- Cache das listas ----------
const cache = {};
async function getList(key) {
  const c = cache[key];
  if (c && Date.now() - c.time < CACHE_MS) return c.items;
  try {
    let items = await scrapeList(LISTS[key].url);
    if (LISTS[key].onlyStreamingVod) items = items.filter(i => i.platform); // só títulos com plataforma (streaming ou VOD)
    cache[key] = { items, time: Date.now() };
    return items;
  } catch (e) {
    console.error(`Erro a ler ${key}:`, e.message);
    return c ? c.items : [];
  }
}

// ---------- Manifest ----------
const manifest = {
  id: "community.dracid.lists.custom",
  version: "1.0.0",
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

  return { metas };
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

// Para verificar se o scraping está a funcionar: /debug/upcoming-movies
app.get("/debug/:list", async (req, res) => {
  if (!LISTS[req.params.list]) return res.sendStatus(404);
  const items = await getList(req.params.list);
  res.json({ count: items.length, withPlatform: items.filter(i => i.platform).length, sample: items.slice(0, 3) });
});

app.use(getRouter(builder.getInterface()));

app.listen(PORT, () => console.log(`Addon em ${BASE_URL}/manifest.json`));
