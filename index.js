const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { scrapeList } = require("./scraper");
const { badgePoster } = require("./poster");
const gist = require("./gist");
const tmdb = require("./tmdb");

const PORT = process.env.PORT || 7000;
// URL público do addon (tem de ser alcançável pelo Stremio, é daqui que saem os posters com badge)
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const CACHE_MS = (parseInt(process.env.CACHE_MINUTES, 10) || 30) * 60 * 1000;
const PAGE_SIZE = 100;
const COUNTRY = (process.env.COUNTRY || "US").toUpperCase(); // país usado no TMDB para plataformas e lançamento digital
const CHECK_MS = (parseInt(process.env.CHECK_HOURS, 10) || 24) * 60 * 60 * 1000;

const SITE = "https://dracid77.github.io/lists";
const LISTS = {
  "upcoming-movies": { url: `${SITE}/upcoming-movies`, name: "Upcoming Movies (badges)" },
  "released-movies": { url: `${SITE}/released-movies`, name: "2026 Released Movies (Streaming/VOD)" }
};

// ---------- Histórico (store) ----------
// Guarda todos os títulos que o site marcou com plataforma (streaming ou VOD).
// Um título entra na lista "Released" no dia da sua data de lançamento digital.
const store = { items: {}, checked: {}, loadOk: false, lastSaved: null, error: null };

async function ensureLoaded() {
  if (store.loadOk || !gist.enabled) return;
  try {
    const data = await gist.load();
    (data.items || []).forEach(i => { if (!store.items[i.id]) store.items[i.id] = i; });
    Object.entries(data.checked || {}).forEach(([id, t]) => { if (!store.checked[id]) store.checked[id] = t; });
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
      await gist.save({ version: 2, items: Object.values(store.items), checked: store.checked });
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
    if (!prev || prev.source === "tmdb" || FIELDS.some(f => prev[f] !== it[f])) { // o que o site marca tem prioridade sobre o TMDB
      store.items[it.id] = { id: it.id, ...Object.fromEntries(FIELDS.map(f => [f, it[f]])), source: "site", firstSeen: prev ? prev.firstSeen : new Date().toISOString() };
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

// ---------- Recuperar o que já saiu em VOD/streaming (TMDB) ----------
// A lista Released do site não marca VOD. Para os títulos dela sem plataforma, o TMDB diz se já há
// versão digital (streaming, aluguer ou compra) e em que data. Quem tiver entra no histórico com essa data.
const info = { enriching: false, done: 0, total: 0, lastError: null };

async function enrichReleased(raw) {
  if (!tmdb.enabled || info.enriching) return;
  const now = Date.now();
  const todo = raw.filter(i => !i.platform && i.tmdbId && !store.items[i.id] && !(store.checked[i.id] && now - store.checked[i.id] < CHECK_MS));
  if (!todo.length) return;

  Object.assign(info, { enriching: true, done: 0, total: todo.length });
  let idx = 0, changed = false;
  const worker = async () => {
    while (idx < todo.length) {
      const it = todo[idx++];
      try {
        const r = await tmdb.lookup(it.tmdbId, COUNTRY);
        store.checked[it.id] = Date.now();
        changed = true;
        if (r.platform) {
          store.items[it.id] = {
            id: it.id, tmdbId: it.tmdbId, title: it.title, poster: it.poster, platform: r.platform,
            date: r.digitalDate || it.date, synopsis: it.synopsis, source: "tmdb", firstSeen: new Date().toISOString()
          };
        }
      } catch (e) {
        info.lastError = e.message;
        if (/HTTP 40[13]/.test(e.message)) idx = todo.length; // chave inválida: pára
      }
      info.done++;
    }
  };
  try { await Promise.all(Array.from({ length: 8 }, worker)); }
  finally { info.enriching = false; }
  if (changed) scheduleSave();
}

const isPast = i => new Date(i.date).getTime() <= Date.now();

async function getList(key) {
  await ensureLoaded();
  const [upcoming, released] = await Promise.all([getRawList("upcoming-movies"), getRawList("released-movies")]);
  enrichReleased(released); // em segundo plano; o catálogo vai enchendo

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

  return { metas, cacheMaxAge: info.enriching ? 60 : 1800 };
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
    tmdb: { enabled: tmdb.enabled, country: COUNTRY, ...info },
    history: {
      total: all.length,
      released: all.filter(isPast).length,
      fromTmdb: all.filter(i => i.source === "tmdb").length,   // recuperados pelo TMDB (já saíram em VOD/streaming)
      checkedWithTmdb: Object.keys(store.checked).length,
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
