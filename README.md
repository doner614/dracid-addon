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

## Como funciona a lista Released
O site marca com plataforma (streaming ou VOD) os títulos de **Upcoming**. O addon guarda esses títulos num histórico
e, **no dia da data de lançamento**, passam de Upcoming para Released. Os títulos que o site já marca na sua lista
Released também entram no histórico. Sem plataforma = cinema, nunca entra.

## Histórico persistente (Gist)
O Render gratuito apaga a memória e o disco quando reinicia, por isso o histórico fica num GitHub Gist:
1. Em https://gist.github.com cria um gist **secreto** com o ficheiro `released.json` e o conteúdo `{"items":[]}`.
   O ID do gist é a parte final do URL.
2. Em https://github.com/settings/tokens cria um token (classic) só com a permissão **gist**.
3. No Render, em Environment: `GIST_ID` (ID do gist) e `GITHUB_TOKEN` (o token).

Sem isto o addon funciona, mas o histórico perde-se sempre que o serviço reinicia.
Para o serviço não adormecer (e o histórico atualizar de 30 em 30 minutos), usa um ping gratuito (ex.: UptimeRobot)
a abrir `/manifest.json` de 5 em 5 minutos.
