// Lê uma página de lista (HTML) e extrai os títulos (filmes ou séries).
// Não depende de classes CSS: parte do link IMDb de cada título e sobe na árvore
// até ao menor "cartão" que contenha uma data e um poster (e apenas um título).
const cheerio = require("cheerio");

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const MON = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const DATE_RE = new RegExp(`(\\d+)\\s+${MON}[a-z]*\\s+(\\d{4})`);        // no texto do cartão (ano/temporada podem estar colados ao dia)
const CLEAN_DATE_RE = new RegExp(`(\\d{1,2})\\s+${MON}[a-z]*\\s+(\\d{4})`); // numa linha só com a data

const KINDS = {
  movie: {
    tmdbSel: 'a[href*="themoviedb.org/movie"]',
    tmdbRe: /movie\/(\d+)/,
    genres: /Action|Adventure|Animation|Comedy|Crime|Documentary|Drama|Family|Fantasy|History|Horror|Music|Mystery|Romance|Science Fiction|Thriller|TV Movie|War|Western/
  },
  series: {
    tmdbSel: 'a[href*="themoviedb.org/tv"]',
    tmdbRe: /tv\/(\d+)/,
    genres: /Action & Adventure|Animation|Comedy|Crime|Documentary|Drama|Family|Kids|Mystery|News|Reality|Sci-Fi & Fantasy|Soap|Talk|War & Politics|Western/
  }
};
const IMDB_SEL = 'a[href*="imdb.com/title/tt"]';

const imdbId = (href = "") => (href.match(/tt\d+/) || [])[0];
const toIso = (y, monthName, day) => new Date(Date.UTC(+y, MONTHS[monthName.toLowerCase()], day)).toISOString();

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (stremio-custom-addon)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

// Data a partir do texto corrido do cartão. O ano do título e a temporada ("S02") ficam colados ao dia:
//  "Flush2025(1h 10min)9 Oct 2026" | "Crystal Lake202615 Oct 2026" | "Stick2025S024 Nov 2026"
function dateFromText(text) {
  const m = text.match(DATE_RE);
  if (!m) return null;
  let run = m[1];
  const prev = text[m.index - 1] || "";
  if (run.length > 2) {
    if (prev === "S") run = run.slice(2);                        // "S024" -> temporada 02, dia 4
    else if (/^(19|20)\d\d/.test(run)) run = run.slice(4);       // "202615" -> ano 2026, dia 15
    else run = run.slice(-2);
  }
  let day = parseInt(run, 10);
  if (!(day >= 1 && day <= 31)) day = parseInt(run.slice(-1), 10) || 1;
  return { iso: toIso(m[3], m[2], day), end: m.index + m[0].length };
}

// Séries: a "linha" com data + bandeira do país + plataforma/canal. Lê data e plataforma da própria linha.
function rowInfo($, card) {
  const flag = card.find("img").filter((_, i) => /flagcdn/.test($(i).attr("src") || "")).first();
  if (!flag.length) return null;
  const cardNode = card.get(0);
  let el = flag.parent();
  while (el.length && el.get(0) !== cardNode) {
    const t = el.text().replace(/\s+/g, " ").trim();
    const m = t.match(CLEAN_DATE_RE);
    if (m) {
      if (t.length > 90) return null; // apanhou mais do que a linha
      const rest = t.slice(m.index + m[0].length).trim();
      return { iso: toIso(m[3], m[2], parseInt(m[1], 10)), platform: rest && rest.length <= 40 ? rest : null };
    }
    el = el.parent();
  }
  return null;
}

// Limpa o nome da plataforma/canal (inclui gralhas e variantes que existem nas listas do site)
const FIXES = [[/^Dsiney\+$/i, "Disney+"], [/^Channel\s?4$/i, "Channel 4"], [/^CraveTV$/i, "Crave"]];
const cleanPlatform = p => {
  if (!p) return null;
  let n = p.replace(/\s+/g, " ").replace(/\s+with\s+Showtime$/i, "").trim();
  for (const [re, to] of FIXES) if (re.test(n)) n = to;
  return n || null;
};

function buildItem($, card, id, kind) {
  const cfg = KINDS[kind];
  const text = card.text().replace(/\s+/g, " ").trim();

  const textDate = dateFromText(text);
  const row = kind === "series" ? rowInfo($, card) : null;
  const iso = row ? row.iso : textDate && textDate.iso;
  if (!iso) return null;

  // Plataforma: pela linha (séries) ou, em alternativa, o texto logo a seguir à data, até ao primeiro género
  const afterDate = textDate ? text.slice(textDate.end).trim() : "";
  const textPlatform = afterDate.split(cfg.genres)[0].replace(/\s+/g, " ").trim() || null;
  const platform = cleanPlatform((row && row.platform) || textPlatform);

  const tmdbLink = card.find(cfg.tmdbSel).first();
  const title = tmdbLink.text().trim();
  const tmdbId = ((tmdbLink.attr("href") || "").match(cfg.tmdbRe) || [])[1] || null;

  let poster = card
    .find("img")
    .filter((_, i) => !/flagcdn/.test($(i).attr("src") || ""))
    .first()
    .attr("src");
  if (poster) poster = poster.replace(/(image\.tmdb\.org\/t\/p\/)w\d+/, "$1w500");

  const synopsis = (text.match(/SYNOPSIS\s*(.*?)\s*▸\s*FULL CAST/) || [])[1] || "";

  return { id, tmdbId, title, poster, date: iso, platform, synopsis, rawText: text.slice(0, 400) };
}

function parseList(html, kind = "movie") {
  const $ = cheerio.load(html);
  const seen = new Set();
  const items = [];

  $(IMDB_SEL).each((_, a) => {
    const id = imdbId($(a).attr("href"));
    if (!id || seen.has(id)) return;

    let el = $(a);
    let best = null;
    while (el.length && !el.is("body")) {
      const ids = new Set();
      el.find(IMDB_SEL).each((_, x) => ids.add(imdbId($(x).attr("href"))));
      if (ids.size > 1) break; // já apanhámos mais do que um título
      if (DATE_RE.test(el.text()) && el.find("img").length) best = el;
      el = el.parent();
    }
    if (!best) return;

    const item = buildItem($, best, id, kind);
    if (!item) return;
    seen.add(id);
    items.push(item);
  });

  return items;
}

async function scrapeList(url, kind = "movie") {
  return parseList(await fetchHtml(url), kind);
}

module.exports = { scrapeList, parseList, dateFromText };
