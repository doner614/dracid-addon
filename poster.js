// Gera o poster com badge (plataforma + data) por cima da imagem original.
const sharp = require("sharp");

const W = 500, H = 750;
const MON = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];

const COLORS = {
  "netflix": ["#E50914", "#fff"],
  "prime video": ["#00A8E1", "#fff"],
  "apple tv+": ["#2b2b2b", "#fff"],
  "disney+": ["#113CCF", "#fff"],
  "hbo max": ["#5B2BD6", "#fff"],
  "max": ["#5B2BD6", "#fff"],
  "hulu": ["#1CE783", "#111"],
  "paramount+": ["#0064FF", "#fff"],
  "peacock": ["#111", "#fff"],
  "shudder": ["#C8102E", "#fff"],
  "vod": ["#F5A623", "#111"],
  "fx": ["#1a1a1a", "#fff"],
  "crave": ["#0AA0E6", "#fff"],
  "mgm+": ["#B8860B", "#fff"],
  "amc+": ["#1F6FEB", "#fff"],
  "starz": ["#111", "#fff"],
  "showtime": ["#B80000", "#fff"],
  "vix": ["#F26A21", "#fff"]
};

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function dateLabel(iso) {
  const d = new Date(iso);
  let label = `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) label += ` ${String(d.getUTCFullYear()).slice(2)}`;
  return label;
}

function makeSvg(platform, iso) {
  const barH = 100, y0 = H - barH;
  const date = dateLabel(iso);
  let pill = "";
  let dateX = 20;

  if (platform) {
    const name = platform.toUpperCase().slice(0, 16);
    const [bg, fg] = COLORS[platform.toLowerCase()] || ["#444", "#fff"];
    const fs = name.length > 11 ? 24 : 30;          // nomes longos usam letra mais pequena
    const pw = Math.round(name.length * fs * 0.7) + 34;
    pill = `<rect x="16" y="${y0 + 18}" width="${pw}" height="64" rx="14" fill="${bg}"/>
      <text x="${16 + pw / 2}" y="${y0 + 60}" text-anchor="middle" font-size="${fs}" font-weight="700" fill="${fg}">${esc(name)}</text>`;
    dateX = 16 + pw + 18;
  }

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="DejaVu Sans, Arial, Helvetica, sans-serif">
    <rect x="0" y="${y0}" width="${W}" height="${barH}" fill="rgba(0,0,0,0.80)"/>
    ${pill}
    <text x="${dateX}" y="${y0 + 62}" font-size="34" font-weight="700" fill="#fff">${esc(date)}</text>
  </svg>`;
}

async function badgePoster(posterUrl, platform, iso) {
  const res = await fetch(posterUrl);
  if (!res.ok) throw new Error(`poster HTTP ${res.status}`);
  const input = Buffer.from(await res.arrayBuffer());

  const base = await sharp(input).resize(W, H, { fit: "cover" }).toBuffer();
  return sharp(base)
    .composite([{ input: Buffer.from(makeSvg(platform, iso)), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

module.exports = { badgePoster };
