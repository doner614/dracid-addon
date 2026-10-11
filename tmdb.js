// Consulta o TMDB para saber se um filme já está em streaming ou VOD (aluguer/compra digital).
const KEY = process.env.TMDB_API_KEY || "";
const enabled = !!KEY;
const isToken = KEY.length > 40; // "API Read Access Token" (JWT) vs chave v3 (32 caracteres)

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Serviços de TV em direto: não são streaming a pedido, por isso não contam como plataforma
const LIVE_TV = /^(Philo|fuboTV|Sling TV|DIRECTV|YouTube TV|Spectrum On Demand|Hulu \+ Live TV)$/i;

function normalize(name) {
  return name
    .replace(/\s+Amazon Channel$/i, "")       // "HBO Max Amazon Channel" -> "HBO Max"
    .replace(/\s+(Standard\s+)?with Ads$/i, "")
    .replace(/\s+Premium$/i, "")              // "Paramount Plus Premium", "Peacock Premium"
    .replace(/^Amazon (Prime )?Video$/i, "Prime Video")
    .replace(/\s+Plus$/i, "+")                // "Apple TV Plus" -> "Apple TV+"
    .trim();
}

// data = resposta do TMDB com append_to_response=release_dates,watch/providers
// Devolve o nome da plataforma de streaming, "VOD", ou null se ainda não há versão digital.
function classify(data, country, now = new Date()) {
  const providers = (data["watch/providers"] || {}).results || {};
  const p = providers[country] || {};
  const stream = (p.flatrate || []).find(x => !LIVE_TV.test(x.provider_name));
  if (stream) return normalize(stream.provider_name);
  if ((p.rent && p.rent.length) || (p.buy && p.buy.length)) return "VOD";

  const rd = ((data.release_dates || {}).results || []).find(r => r.iso_3166_1 === country);
  const digital = rd && rd.release_dates.some(d => d.type === 4 && new Date(d.release_date) <= now); // 4 = Digital
  return digital ? "VOD" : null;
}

async function lookup(tmdbId, country, attempt = 0) {
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}?append_to_response=release_dates,watch/providers`
    + (isToken ? "" : `&api_key=${KEY}`);
  const res = await fetch(url, { headers: isToken ? { Authorization: `Bearer ${KEY}` } : {} });

  if (res.status === 404) return null;
  if (res.status === 429 && attempt < 3) {
    await sleep((parseInt(res.headers.get("retry-after"), 10) || 1) * 1000);
    return lookup(tmdbId, country, attempt + 1);
  }
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  return classify(await res.json(), country);
}

module.exports = { enabled, lookup, classify };
