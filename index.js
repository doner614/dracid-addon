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
// Responde também à "ficha" (meta) dos nossos títulos, devolvendo a do Cinemeta mas com o poster com badge.
// Desligar com META_PROXY=0 (variável no Render).
const META_PROXY = process.env.META_PROXY !== "0";
const COUNTRY = (process.env.COUNTRY || "US").toUpperCase(); // país usado no TMDB para plataformas e lançamento digital
// IDs IMDb a nunca mostrar na Released (para corrigir à mão um erro): EXCLUDE_IDS=tt1234567,tt7654321
const EXCLUDE = new Set((process.env.EXCLUDE_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
// IDs IMDb a incluir à mão na Released (ex.: títulos que o Dracid tinha como VOD na Upcoming e que se perderam):
// INCLUDE_IDS=tt1234567,tt7654321. Têm de constar na lista Released do Dracid; entram como "VOD" (ou com a plataforma que o site indicar).
const INCLUDE = new Set((process.env.INCLUDE_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
const CHECK_MS = (parseInt(process.env.CHECK_HOURS, 10) || 24) * 60 * 60 * 1000;

const SITE = "https://dracid77.github.io/lists";
// A ordem aqui é a ordem dos catálogos no Stremio
const LISTS = {
  "released-movies": { kind: "movie",  phase: "released", url: `${SITE}/released-movies`, name: "Released Movies" },
  "upcoming-movies": { kind: "movie",  phase: "upcoming", url: `${SITE}/upcoming-movies`, name: "Upcoming Movies" },
  "released-series": { kind: "series", phase: "released", url: `${SITE}/released-series`, name: "Released Series" },
  "upcoming-series": { kind: "series", phase: "upcoming", url: `${SITE}/upcoming-series`, name: "Upcoming Series" }
};
const listKey = (kind, phase) => `${phase}-${kind === "movie" ? "movies" : "series"}`;

// ---------- Histórico (store) ----------
// Guarda todos os títulos que o site marcou com plataforma (streaming, VOD ou canal de TV).
// Um título entra na lista "Released" no dia da sua data de lançamento.
const store = { items: {}, checked: {}, loadOk: false, lastSaved: null, error: null };

async function ensureLoaded() {
  if (store.loadOk || !gist.enabled) return;
  try {
    const data = await gist.load();
    (data.items || []).forEach(i => { if (!store.items[i.id]) store.items[i.id] = { kind: "movie", ...i }; });
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
const startOfTodayUtc = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

// fromReleased: os itens vêm da lista Released do site. Se a data ainda for futura, o site já a considera lançada
// (passou para Released antes da data): entra hoje, com data fixa, em vez de esperar pela data antiga.
function mergeIntoStore(items, kind, fromReleased = false) {
  let changed = false;
  for (const it of items) {
    if (!it.platform) continue; // sem plataforma = cinema, não entra
    const prev = store.items[it.id];
    const future = new Date(it.date).getTime() > Date.now();
    let date = it.date, fixedDate = false;
    if (fromReleased && future) { date = prev && prev.fixedDate ? prev.date : startOfTodayUtc(); fixedDate = true; }
    else if (prev && prev.fixedDate && !fromReleased) { date = prev.date; fixedDate = true; } // a Upcoming não repõe a data futura

    const next = { id: it.id, kind, ...Object.fromEntries(FIELDS.map(f => [f, it[f]])), date, source: "site" };
    if (fixedDate) next.fixedDate = true;
    if (!prev || prev.kind !== kind || prev.source === "tmdb" || !!prev.fixedDate !== fixedDate || FIELDS.some(f => prev[f] !== next[f])) {
      store.items[it.id] = { ...next, firstSeen: prev ? prev.firstSeen : new Date().toISOString() }; // o que o site marca tem prioridade sobre o TMDB
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

// Título que já guardámos (com plataforma, vindo da Upcoming) e que o site já listou como lançado,
// mesmo que lá apareça sem plataforma (acontece nos filmes): passa a lançado hoje.
function markReleasedEarly(kind, releasedRaw) {
  const ids = new Set(releasedRaw.map(i => i.id));
  let changed = false;
  for (const it of Object.values(store.items)) {
    if (it.kind !== kind || !ids.has(it.id)) continue;
    if (new Date(it.date).getTime() > Date.now()) { it.date = startOfTodayUtc(); it.fixedDate = true; delete it.missingSince; changed = true; }
  }
  if (changed) scheduleSave();
}

function applyIncludes(kind, releasedRaw) {
  if (!INCLUDE.size) return;
  let changed = false;
  for (const it of releasedRaw) {
    if (!INCLUDE.has(it.id)) continue;
    const prev = store.items[it.id];
    if (prev && prev.source === "site") continue; // o site já o marca com plataforma
    const date = new Date(it.date).getTime() > Date.now() ? startOfTodayUtc() : it.date;
    const next = { id: it.id, kind, tmdbId: it.tmdbId, title: it.title, poster: it.poster, platform: it.platform || "VOD", date, synopsis: it.synopsis, source: "manual" };
    if (!prev || prev.source !== "manual" || prev.date !== date || prev.platform !== next.platform) {
      store.items[it.id] = { ...next, firstSeen: prev ? prev.firstSeen : new Date().toISOString() };
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

// Título com data futura que desaparece da Upcoming sem aparecer na Released (adiado/retirado):
// só sai do histórico ao fim de 6 horas, para dar tempo à lista Released de o mostrar.
function pruneMissingFuture(kind, upcomingRaw) {
  if (upcomingRaw.length < 10) return; // leitura suspeita (página vazia/alterada): não apaga nada
  const present = new Set(upcomingRaw.map(i => i.id));
  const releasedIds = new Set(((cache[listKey(kind, "released")] || {}).items || []).map(i => i.id));
  const now = Date.now();
  const limit = now + 36 * 3600 * 1000;
  let changed = false;
  for (const [id, it] of Object.entries(store.items)) {
    if (it.kind !== kind || it.source === "tmdb") continue;
    const farFuture = new Date(it.date).getTime() > limit;
    if (!farFuture || present.has(id) || releasedIds.has(id)) {
      if (it.missingSince) { delete it.missingSince; changed = true; }
      continue;
    }
    if (!it.missingSince) { it.missingSince = new Date().toISOString(); changed = true; }
    else if (now - new Date(it.missingSince).getTime() >= 6 * 3600 * 1000) { delete store.items[id]; changed = true; }
  }
  if (changed) scheduleSave();
}

// ---------- Cache das listas (scraping) ----------
// - pedidos simultâneos à mesma página partilham uma única leitura;
// - com cache expirada, responde logo com o que tem e atualiza em segundo plano (só o 1.º pedido após o arranque espera).
const cache = {};
const inflight = {};

async function scrapeAndStore(key) {
  const L = LISTS[key];
  const items = await scrapeList(L.url, L.kind);
  cache[key] = { items, time: Date.now() };
  mergeIntoStore(items, L.kind, L.phase === "released"); // tanto a Upcoming como a Released alimentam o histórico
  if (L.phase === "upcoming") pruneMissingFuture(L.kind, items);
  else { markReleasedEarly(L.kind, items); applyIncludes(L.kind, items); }
  return items;
}

function refreshList(key) {
  if (!inflight[key]) inflight[key] = scrapeAndStore(key).finally(() => { delete inflight[key]; });
  return inflight[key];
}

async function getRawList(key) {
  const c = cache[key];
  if (c) {
    if (Date.now() - c.time >= CACHE_MS) refreshList(key).catch(e => console.error(`Erro a ler ${key}:`, e.message));
    return c.items;
  }
  try {
    return await refreshList(key);
  } catch (e) {
    console.error(`Erro a ler ${key}:`, e.message);
    return [];
  }
}

// ---------- Recuperar filmes que já saíram em VOD/streaming (TMDB) ----------
// A lista Released de filmes do site não marca VOD. Para os títulos dela sem plataforma, o TMDB diz se já há
// versão digital (streaming, aluguer ou compra) e em que data. Quem tiver entra no histórico com essa data.
const info = { enriching: false, done: 0, total: 0, lastError: null };

async function enrichReleased(raw) {
  if (!tmdb.enabled || info.enriching) return;
  const now = Date.now();
  // Candidatos: sem plataforma no site e (ainda não vistos, ou já vindos do TMDB e a precisar de nova verificação).
  // Os que vieram do TMDB com regras antigas (sem "rule: 2") voltam a ser verificados já.
  const todo = raw.filter(i => {
    if (i.platform || !i.tmdbId) return false;
    const stale = !(store.checked[i.id] && now - store.checked[i.id] < CHECK_MS);
    const s = store.items[i.id];
    if (!s) return stale;
    return s.source === "tmdb" && (s.rule !== 2 || stale);
  });
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
        const prev = store.items[it.id];
        if (r.platform) {
          store.items[it.id] = {
            id: it.id, kind: "movie", tmdbId: it.tmdbId, title: it.title, poster: it.poster, platform: r.platform,
            date: r.digitalDate || it.date, synopsis: it.synopsis, source: "tmdb", rule: 2,
            firstSeen: prev ? prev.firstSeen : new Date().toISOString()
          };
        } else if (prev && prev.source === "tmdb") {
          delete store.items[it.id]; // já não cumpre: sem versão digital confirmada
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
  const L = LISTS[key];
  const [upcoming, released] = await Promise.all([getRawList(listKey(L.kind, "upcoming")), getRawList(listKey(L.kind, "released"))]);
  if (L.kind === "movie") enrichReleased(released); // em segundo plano; o catálogo vai enchendo

  // Upcoming: só datas futuras (no dia do lançamento, o título passa para Released)
  if (L.phase === "upcoming") return upcoming.filter(i => !isPast(i));

  // Released: tudo o que o histórico tem com data já passada, do mais recente para o mais antigo
  return Object.values(store.items)
    .filter(i => i.kind === L.kind && isPast(i) && !EXCLUDE.has(i.id))
    .sort((a, b) => b.date.localeCompare(a.date) || (a.title || "").localeCompare(b.title || ""));
}

// ---------- Manifest ----------
const manifest = {
  id: "community.dracid.lists.custom",
  version: "3.2.0",
  name: "Dracid's Lists (custom)",
  description: "Listas de lançamentos digitais (filmes e séries) com badges de plataforma/data; os títulos passam para Released no dia do lançamento",
  resources: META_PROXY ? ["catalog", { name: "meta", types: ["movie", "series"], idPrefixes: ["tt"] }] : ["catalog"],
  types: ["movie", "series"],
  catalogs: Object.entries(LISTS).map(([id, l]) => ({
    type: l.kind,
    id,
    name: l.name,
    extra: [{ name: "skip" }]
  }))
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const L = LISTS[id];
  if (!L || L.kind !== type) return { metas: [] };

  const skip = parseInt(extra && extra.skip, 10) || 0;
  const items = (await getList(id)).slice(skip, skip + PAGE_SIZE);

  const metas = items.map(i => ({
    id: i.id, // IMDb ID → o Stremio vai buscar o resto dos detalhes ao Cinemeta
    type: L.kind,
    name: i.title,
    poster: i.poster ? `${BASE_URL}/poster/${id}/${i.id}.jpg` : i.poster, // badge em todas as listas
    description: [i.platform, i.synopsis].filter(Boolean).join(" — "),
    releaseInfo: new Date(i.date).getUTCFullYear().toString()
    // sem "released": no Stremio esse campo é a estreia em cinema e faz aparecer a etiqueta "IN CINEMA"
  }));

  return { metas, cacheMaxAge: info.enriching ? 60 : 1800 };
});

// ---------- Ficha (meta): Cinemeta + poster com badge ----------
const metaCache = new Map();
const metaLog = { total: 0, answered: 0, since: new Date().toISOString(), last: [] }; // para /debug/meta
const logMeta = (type, id, answered, source) => {
  metaLog.total++;
  if (answered) metaLog.answered++;
  metaLog.last.unshift({ time: new Date().toISOString(), type, id, answered, source });
  if (metaLog.last.length > 15) metaLog.last.pop();
};
async function cinemetaMeta(type, id) {
  const key = type + id;
  const c = metaCache.get(key);
  if (c && Date.now() - c.time < 6 * 3600 * 1000) return c.meta;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const meta = (await res.json()).meta || null;
    if (meta) {
      if (metaCache.size > 300) metaCache.delete(metaCache.keys().next().value);
      metaCache.set(key, { meta, time: Date.now() });
    }
    return meta;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

builder.defineMetaHandler(async ({ type, id }) => {
  if (!META_PROXY) return { meta: null };
  await ensureLoaded();

  // Só trata dos títulos das nossas listas; os outros ficam para os restantes addons (resposta imediata)
  let item = store.items[id];
  let list = null;
  if (item && item.kind === type) list = listKey(type, "released");
  else {
    const upcoming = (cache[listKey(type, "upcoming")] || {}).items || [];
    item = upcoming.find(i => i.id === id);
    if (item) list = listKey(type, "upcoming");
  }
  if (!item || !list || !item.poster) { logMeta(type, id, false, "fora das nossas listas"); return { meta: null }; }

  const poster = `${BASE_URL}/poster/${list}/${id}.jpg`;
  const base = await cinemetaMeta(type, id);
  const meta = base
    ? { ...base, poster }
    : { id, type, name: item.title, poster, description: [item.platform, item.synopsis].filter(Boolean).join(" — ") };
  logMeta(type, id, true, base ? "cinemeta + poster com badge" : "só dados do site (Cinemeta falhou)");
  return { meta, cacheMaxAge: 3600 };
});

// ---------- Servidor ----------
const app = express();

// Resposta mínima para o serviço de ping (não faz scraping nem usa a rede)
app.get("/health", (req, res) => res.type("text").send("ok"));

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
      if (posterCache.size > 800) posterCache.delete(posterCache.keys().next().value);
      posterCache.set(key, buf);
    }
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" });
    res.send(buf);
  } catch (e) {
    console.error("Erro no poster:", e.message);
    res.redirect(item.poster); // fallback: poster original
  }
});

// Diagnóstico dos pedidos de ficha: mostra se o Stremio pergunta ao nosso addon
app.get("/debug/meta", (req, res) => res.json({ metaProxy: META_PROXY, ...metaLog }));

// Procura um título: /debug/find?q=vision quest  (mostra onde está: histórico e listas do Dracid)
app.get("/debug/find", (req, res) => {
  const q = String(req.query.q || "").toLowerCase().trim();
  if (!q) return res.json({ erro: "usa /debug/find?q=parte-do-titulo" });
  const match = i => (i.title || "").toLowerCase().includes(q) || i.id === q;
  const short = i => ({ id: i.id, kind: i.kind, title: i.title, platform: i.platform, date: i.date, source: i.source, fixedDate: i.fixedDate, missingSince: i.missingSince });
  const onSiteLists = {};
  for (const k of Object.keys(LISTS)) onSiteLists[k] = ((cache[k] || {}).items || []).filter(match).map(short);
  res.json({
    query: q,
    history: Object.values(store.items).filter(match).map(short),
    onSiteLists, // o que o scraper leu de cada lista do Dracid (vazio = não aparece ou não tem link IMDb)
    tmdbChecked: Object.keys(store.checked).length
  });
});

// Auditoria: filmes que entraram na Released por via do TMDB (para confirmares que não há filmes só de cinema)
app.get("/debug/audit", (req, res) => {
  const list = Object.values(store.items).filter(i => i.source === "tmdb")
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .map(i => ({ id: i.id, title: i.title, platform: i.platform, digitalDate: i.date, tmdbId: i.tmdbId, rule: i.rule }));
  res.json({ fromTmdb: list.length, excluded: [...EXCLUDE], list });
});

// Diagnóstico: /debug/released-movies, /debug/upcoming-series, ...
app.get("/debug/:list", async (req, res) => {
  const key = req.params.list;
  const L = LISTS[key];
  if (!L) return res.sendStatus(404);

  const raw = await getRawList(key);
  const kept = await getList(key);
  const all = Object.values(store.items).filter(i => i.kind === L.kind);
  const platforms = {};
  kept.forEach(i => { const p = i.platform || "(nenhuma)"; platforms[p] = (platforms[p] || 0) + 1; });
  const short = i => ({ id: i.id, title: i.title, platform: i.platform, date: i.date });

  res.json({
    rawCount: raw.length,        // o que o scraper leu da página
    keptCount: kept.length,      // o que o catálogo mostra
    platforms,
    tmdb: L.kind === "movie" ? { enabled: tmdb.enabled, country: COUNTRY, ...info } : "não usado nas séries",
    history: {
      total: all.length,
      released: all.filter(isPast).length,
      waitingForReleaseDate: all.filter(i => !isPast(i)).length,
      fromTmdb: all.filter(i => i.source === "tmdb").length,
      persistence: { enabled: gist.enabled, loaded: store.loadOk, lastSaved: store.lastSaved, error: store.error }
    },
    sample: kept.slice(0, 3).map(short),
    rawSample: raw.slice(0, 2).map(i => ({ ...short(i), tmdbId: i.tmdbId, rawText: (i.rawText || "").slice(0, 140) })),
    untaggedSample: raw.filter(i => !i.platform).slice(0, 2).map(i => ({ ...short(i), rawText: (i.rawText || "").slice(0, 140) }))
  });
});

app.use(getRouter(builder.getInterface()));

app.listen(PORT, async () => {
  console.log(`Addon em ${BASE_URL}/manifest.json (histórico ${gist.enabled ? "no Gist" : "só em memória"})`);
  await ensureLoaded();
  const refresh = () => ["released-movies", "released-series"].forEach(k => getList(k).catch(() => {}));
  refresh();
  setInterval(refresh, CACHE_MS + 1000); // mantém o histórico a atualizar
});
