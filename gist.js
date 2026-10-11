// Guarda o histórico de lançamentos num GitHub Gist (o disco do Render gratuito apaga-se a cada reinício).
const GIST_ID = process.env.GIST_ID || "";
const TOKEN = process.env.GITHUB_TOKEN || "";
const FILE = "released.json";
const enabled = !!(GIST_ID && TOKEN);

const headers = () => ({
  "User-Agent": "stremio-dracid-addon",
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${TOKEN}`
});

async function load() {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: headers() });
  if (!res.ok) throw new Error(`Gist HTTP ${res.status}`);
  const file = (await res.json()).files[FILE];
  if (!file) throw new Error(`O gist não tem o ficheiro ${FILE}`);
  const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  return text && text.trim() ? JSON.parse(text) : { items: [] };
}

async function save(data) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(data) } } })
  });
  if (!res.ok) throw new Error(`Gist HTTP ${res.status}`);
}

module.exports = { enabled, load, save };
