# Julefrokost på Amager (offentlig udgave)

Lille 16-bit pixelspil fra ai-workshop.dk. Spilles i browseren, også på mobilen. Skriv dit navn, vælg en fisker og kom på topscorerlisten. Klar alle elleve baner og lås hemmeligheden op: en personlig rabatkode til en workshop fra ai-workshop.

Spil: https://rapsak5.github.io/amager-spillet/

- Spillet: almindelig JavaScript med Phaser 4, uden build-trin. Start i `index.html`.
- Topscorerlisten: Cloudflare Worker i `server/worker-public.js` med D1-databasen `amager-spil-scores` bundet som `DB`. Variabler: `ALLOWED_ORIGIN` og secret `ADMIN_TOKEN`.
- Snyd: point kommer kun ind gennem et løb, som serveren selv har startet og taget tid på (`/run/start` og `/run/finish`). Et løb, der er hurtigere end banen kan løbes, eller giver flere point end banen har, bliver afvist. Der er grænser for, hvor tit man kan kalde serveren, og kun spillets egen side må sende.
- Rabatkoder: `POST /claim` giver en kode til spillere med godkendte løb på alle elleve baner. Én kode pr. mail, højst 3 pr. enhed. `GET /admin/codes` viser koderne, og `POST /admin/used` med `{ "code": "AMA-..." }` markerer en kode som brugt. Valgfrit til mail og nyhedsbrev: `BREVO_API_KEY` (secret), `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME` og `BREVO_LIST_ID`.
- Skjul et navn: `POST /admin/hide` med `{ "pid": "...", "hidden": true }` og headeren `Authorization: Bearer <ADMIN_TOKEN>`. `GET /admin/players` viser alle spillere med pid, og `GET /admin/rejected` viser afviste løb. Uden `ADMIN_TOKEN` (mindst 16 tegn) er admin slået fra.
