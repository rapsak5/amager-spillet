# Julefrokost på Amager (offentlig udgave)

Lille 16-bit pixelspil fra ai-workshop.dk. Spilles i browseren, også på mobilen. Skriv dit navn, vælg en fisker og kom på topscorerlisten.

Spil: https://rapsak5.github.io/amager-spillet/

- Spillet: almindelig JavaScript med Phaser 4, uden build-trin. Start i `index.html`.
- Topscorerlisten: Cloudflare Worker i `server/worker-public.js` med D1-databasen `amager-spil-scores` bundet som `DB`. Variabler: `ALLOWED_ORIGIN` og secret `ADMIN_TOKEN`.
- Skjul et navn: `POST /admin/hide` med `{ "pid": "...", "hidden": true }` og headeren `Authorization: Bearer <ADMIN_TOKEN>`. `GET /admin/players` viser alle spillere med pid.
- Opdatering: læg en ny `site.zip` i roden af repoet. GitHub Actions pakker den ud og lægger siden online.
