# Dracid's Lists (custom)

Addon Stremio que lê https://dracid77.github.io/lists e:
- **Upcoming Movies**: poster com badge (plataforma + data de lançamento).
- **Released Movies**: só títulos com plataforma (streaming ou VOD).

## Arrancar
```
npm install
npm start
```
1. Abre http://127.0.0.1:7000/debug/upcoming-movies — deve mostrar `count` > 0 e itens com `platform` e `date`.
2. Adiciona http://127.0.0.1:7000/manifest.json no Stremio (Addons).

## Deploy
O Stremio exige HTTPS fora do localhost. Define `BASE_URL=https://o-teu-dominio` (é o endereço dos posters com badge).

Variáveis: `PORT` (7000), `BASE_URL`, `CACHE_MINUTES` (30), `TMDB_API_KEY`, `COUNTRY` (US).

## TMDB (para a lista de lançados)
O site só marca plataforma em ~10% dos filmes lançados. Com `TMDB_API_KEY` definida, o addon consulta o TMDB e
mantém os filmes que já estão em streaming ou VOD (aluguer/compra digital) no país `COUNTRY` (ex.: US, PT).
Serve a chave "API Key" (v3) ou o "API Read Access Token". O enriquecimento corre em segundo plano
(~1–2 min após arrancar), por isso o catálogo vai crescendo. Sem chave, só aparecem os títulos que o site já marca.

## Notas
- Os posters usam a fonte DejaVu Sans/Arial. Se o servidor não tiver fontes instaladas, o texto do badge pode aparecer em quadrados (em Docker: `apt-get install -y fontconfig fonts-dejavu-core`).
- Itens sem link IMDb na lista são ignorados (o Stremio precisa do ID `tt...`).
