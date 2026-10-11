const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { scrapeList } = require("./scraper");
const { badgePoster } = require("./poster");
const gist = require("./gist");

const PORT = process.env.PORT || 7000;
// URL público do addon (tem de ser alcançável pelo Stremio, é daqui que saem os posters com badge)
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const CACHE_MS = (parseInt(process.env.CACHE_MINUTES, 10) || 30) * 60 * 1000;
const PAGE_SIZE = 100;

const SITE = "https://dracid77.github.io/lists";
const LISTS = {
  "upcoming-movies": { url: `${SITE}/upcoming-movies`, name: "Upcoming Movies (badges)" },
  "released-movies": { url: `${SITE}/released-movies`, name: "2026 Released Movies (Streaming/VOD)" }
};

// ---------- Histórico (store) ----------
// Guarda todos os títulos que o site marcou com plataforma (streaming ou VOD).
// Um título entra na lista "Released" no dia da sua data de lançamento digital.
const store = { items: {}, loadOk: false, lastSaved: null, error: null };

async function ensureLoaded() {
  if (store.loadOk || !gist.enabled) return;
  try {
    const data = await gist.load();
    (data.items || []).forEach(i => { if (!store.items[i.id]) store.items[i.id] = i; });
    store.loadOk = true;
    store.error = null;
  } catch (e) {
    store.error = "load: " + e.message;
    console.error("Erro a carregar o histórico:", e.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (!gist.enabled) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await ensureLoaded();
    if (!store.loadOk) return; // nunca grava sem ter carregado antes (evita apagar o histórico)
    try {
      await gist.save({ version: 1, items: Object.values(store.items) });
      store.lastSaved = new Date().toISOString();
      store.error = null;
    } catch (e) {
      store.error = "save: " + e.message;
      console.error("Erro a gravar o histórico:", e.message);
    }
  }, 5000);
}

const FIELDS = ["tmdbId", "title", "poster", "platform", "date", "synopsis"];
function mergeIntoStore(items) {
  let changed = false;
  for (const it of items) {
    if (!it.platform) continue; // sem plataforma = cinema, não entra
    const prev = store.items[it.id];
    if (!prev || FIELDS.some(f => prev[f] !== it[f])) {
      store.items[it.id] = { id: it.id, ...Object.fromEntries(FIELDS.map(f => [f, it[f]])), firstSeen: prev ? prev.firstSeen : new Date().toISOString() };
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

// ---------- Cache das listas (scraping) ----------
const cache = {};
async function getRawList(key) {
  const c = cache[key];
  if (c && Date.now() - c.time < CACHE_MS) return c.items;
  try {
    const items = await scrapeList(LISTS[key].url);
    cache[key] = { items, time: Date.now() };
    mergeIntoStore(items); // tanto a Upcoming como a Released alimentam o histórico
    return items;
  } catch (e) {
    console.error(`Erro a ler ${key}:`, e.message);
    return c ? c.items : [];
  }
}

const isPast = i => new Date(i.date).getTime() <= Date.now();

async function getList(key) {
  await ensureLoaded();
  const [upcoming] = await Promise.all([getRawList("upcoming-movies"), getRawList("released-movies")]);

  // Upcoming: só datas futuras (no dia do lançamento, o título passa para Released)
  if (key === "upcoming-movies") return upcoming.filter(i => !isPast(i));

  // Released: tudo o que o histórico tem com data já passada, do mais recente para o mais antigo
  return Object.values(store.items)
    .filter(isPast)
    .sort((a, b) => b.date.localeCompare(a.date) || (a.title || "").localeCompare(b.title || ""));
}

// ---------- Manifest ----------
const manifest = {
  id: "community.dracid.lists.custom",
  version: "2.0.0",
  name: "Dracid's Lists (custom)",
  description: "Listas de lançamentos digitais com badges de plataforma/data; os títulos passam para Released no dia do lançamento",
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
    poster: i.poster ? `${BASE_URL}/poster/${id}/${i.id}.jpg` : i.poster, // badge em ambas as listas
    description: [i.platform, i.synopsis].filter(Boolean).join(" — "),
    releaseInfo: new Date(i.date).getUTCFullYear().toString()
    // sem "released": no Stremio esse campo é a estreia em cinema e faz aparecer a etiqueta "IN CINEMA"
  }));

  return { metas, cacheMaxAge: 1800 };
});

// ---------- Servidor ----------
const app = express();

// Poster com badge
const posterCache = new Map();
app.get("/poster/:list/:imdb.jpg", async (req, res) => {
  const { list, imdb } = req.params;
  if (!LISTS[list]) return res.sendStatus(404);

  await ensureLoaded();
  const item = store.items[imdb] || (await getRawList(list)).find(i => i.id === imdb);
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
  const all = Object.values(store.items);
  const platforms = {};
  kept.forEach(i => { const p = i.platform || "(nenhuma)"; platforms[p] = (platforms[p] || 0) + 1; });

  res.json({
    rawCount: raw.length,        // o que o scraper leu da página
    keptCount: kept.length,      // o que o catálogo mostra
    platforms,
    history: {
      total: all.length,
      released: all.filter(isPast).length,
      waitingForReleaseDate: all.filter(i => !isPast(i)).length,
      persistence: { enabled: gist.enabled, loaded: store.loadOk, lastSaved: store.lastSaved, error: store.error }
    },
    sample: kept.slice(0, 3).map(i => ({ id: i.id, title: i.title, platform: i.platform, date: i.date }))
  });
});

app.use(getRouter(builder.getInterface()));

app.listen(PORT, async () => {
  console.log(`Addon em ${BASE_URL}/manifest.json (histórico ${gist.enabled ? "no Gist" : "só em memória"})`);
  await ensureLoaded();
  getList("released-movies").catch(() => {});
  setInterval(() => getList("released-movies").catch(() => {}), CACHE_MS + 1000); // mantém o histórico a atualizar
});
