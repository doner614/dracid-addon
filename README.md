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

Variáveis: `PORT` (7000), `BASE_URL`, `CACHE_MINUTES` (30).

## Notas
- Os posters usam a fonte DejaVu Sans/Arial. Se o servidor não tiver fontes instaladas, o texto do badge pode aparecer em quadrados (em Docker: `apt-get install -y fontconfig fonts-dejavu-core`).
- Itens sem link IMDb na lista são ignorados (o Stremio precisa do ID `tt...`).
