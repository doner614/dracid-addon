// Lê uma página de lista (HTML) e extrai os filmes.
// Não depende de classes CSS: parte do link IMDb de cada filme e sobe na árvore
// até ao menor "cartão" que contenha uma data e um poster (e apenas um filme).
const cheerio = require("cheerio");

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const DATE_RE = /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/;
const GENRE_RE = /Action|Adventure|Animation|Comedy|Crime|Documentary|Drama|Family|Fantasy|History|Horror|Music|Mystery|Romance|Science Fiction|Thriller|TV Movie|War|Western/;
const IMDB_SEL = 'a[href*="imdb.com/title/tt"]';

const imdbId = (href = "") => (href.match(/tt\d+/) || [])[0];

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (stremio-custom-addon)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

function buildItem($, card, id) {
  const text = card.text().replace(/\s+/g, " ").trim();

  const m = text.match(DATE_RE);
  const date = new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1])).toISOString();

  // O texto logo a seguir à data é "<plataforma><géneros...>"; cortamos no primeiro género.
  const afterDate = text.slice(m.index + m[0].length).trim();
  const platform = afterDate.split(GENRE_RE)[0].replace(/\s+/g, " ").trim() || null;

  const title = card.find('a[href*="themoviedb.org/movie"]').first().text().trim();

  let poster = card
    .find("img")
    .filter((_, i) => !/flagcdn/.test($(i).attr("src") || ""))
    .first()
    .attr("src");
  if (poster) poster = poster.replace(/(image\.tmdb\.org\/t\/p\/)w\d+/, "$1w500");

  const synopsis = (text.match(/SYNOPSIS\s*(.*?)\s*▸\s*FULL CAST/) || [])[1] || "";

  return { id, title, poster, date, platform, synopsis };
}

function parseList(html) {
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
      if (ids.size > 1) break; // já apanhámos mais do que um filme
      if (DATE_RE.test(el.text()) && el.find("img").length) best = el;
      el = el.parent();
    }
    if (!best) return;

    seen.add(id);
    items.push(buildItem($, best, id));
  });

  return items;
}

async function scrapeList(url) {
  return parseList(await fetchHtml(url));
}

module.exports = { scrapeList, parseList };
