// Fælles konstanter. Alt, der skal justeres på spilfølelsen, står i TUNING.

export const VERSION = '0.4.0-pub';

// Offentlig udgave til promovering. Alle kan spille, vælge fisker og skrive et navn.

// Spillets interne opløsning. Skaleres op til skærmen med skarpe pixels.
export const GAME_W = 640;
export const GAME_H = 360;

export const GROUND_Y = 300;        // jordlinjen (fiskerens fødder)
export const COL = 48;              // bredden på én kolonne i banerne
export const PLAYER_SCREEN_X = 150; // hvor på skærmen fiskeren løber

// De tre højder, ting kan stå i (se src/data/levels.js)
export const ROW_Y = {
  hi: GROUND_Y - 118,   // kræver et hop
  mid: GROUND_Y - 62,   // hovedhøjde: slide under eller slå
  lo: GROUND_Y,         // på jorden
};

// Under vand (Den Blå Planet) er de tre rækker tre svømmebaner i disse højder
export const SWIM_Y = { hi: 104, mid: 176, lo: 248 };

export const TUNING = {
  gravity: 1500,
  jumpV: -600,            // giver ca. 120 px hophøjde og 0,8 sek. i luften
  fastFallV: 720,         // swipe ned i luften
  coyoteMs: 90,           // man kan stadig hoppe lige efter kanten
  jumpBufferMs: 130,      // et hop lige før landing huskes
  slideMs: 560,
  swingMs: 260,           // hvor længe slaget vises
  swingActiveMs: 190,     // hvor længe slaget rammer
  swingCooldownMs: 340,
  invulnMs: 900,          // usårlig efter et slag
  shotMs: 6000,           // så længe giver et shot dobbelt point og ombyttet styring
  maxHearts: 4,
  beersForSuper: 10,
};

export const SCORE = {
  beer: 100,
  quiz: 500,
  heartBonus: 250,        // pr. hjerte, når banen er klaret
  bossHit: 1000,
  boss: 3000,
};

export const DEPTH = { sky: 0, far: 1, mid: 2, ground: 5, pit: 6, ent: 10, boss: 15, player: 20, fx: 30, snow: 40 };

// Afsender og reklame. Vises på forsiden og på slutskærmen.
export const PROMO = {
  presents: 'ai-workshop.dk præsenterer',
  credit: 'Bygget med AI af ai-workshop.dk',
  pitch: 'Vil du lære at bygge sådan noget med AI?',
  url: 'https://ai-workshop.dk',
  label: 'AI-WORKSHOP.DK',
};

// Fælles topscorerliste. null = listen gemmes kun på den enkelte enhed.
// Sæt til adressen på Cloudflare Workeren i server/worker-public.js,
// fx 'https://amager-spil-scores.<konto>.workers.dev'.
// På localhost kan den sættes med ?scores=http://localhost:8788 (kun til test).
const LOCAL_TEST = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? new URLSearchParams(location.search).get('scores') : null;
export const SCORES_URL = LOCAL_TEST || null;

// Navne på listen
export const NAME_MAX = 12;

// Checkpoints i banerne. false = en bane skal klares i ét hug, ellers starter man forfra.
export const CHECKPOINTS = true;

export const SAVE_KEY = 'amager-spil-offentlig-v1';
