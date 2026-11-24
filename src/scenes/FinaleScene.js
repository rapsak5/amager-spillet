// Slutskærmen, når alle ti baner er klaret: point, plads på listen og en hilsen fra afsenderen.

import { GAME_W, PROMO } from '../config.js';
import { txt, panel, button, pad, C } from '../game/ui.js';
import * as Scores from '../systems/scores.js';
import * as Save from '../systems/save.js';
import { sfx } from '../systems/audio.js';

export default class FinaleScene extends Phaser.Scene {
  constructor() { super('Finale'); }

  create() {
    this.add.rectangle(0, 0, GAME_W, 360, C.deep).setOrigin(0);
    txt(this, GAME_W / 2, 18, 'HELE AMAGER ER KLARET. TAXAEN VENTER.', { font: 'small_o', tint: C.soft });
    const big = txt(this, GAME_W / 2, 54, 'VELFORTJENT BAD!', { font: 'big_o', scale: 3, tint: C.yellow });
    this.tweens.add({ targets: big, scale: { from: 0.2, to: 1 }, duration: 500, ease: 'Back.easeOut' });
    this.add.image(8, 90, 'secret').setOrigin(0);

    const x0 = 400;
    const cx = x0 + 116;
    panel(this, x0, 90, 232, 216);
    txt(this, cx, 108, (Save.load().name || '').toUpperCase(), { font: 'small_o', scale: 2, tint: C.yellow });
    txt(this, cx, 130, 'POINT I ALT', { font: 'small', tint: C.soft });
    txt(this, cx, 152, pad(Scores.total()), { font: 'big_o', scale: 2 });
    const rank = txt(this, cx, 180, Scores.isShared() ? 'FINDER DIN PLADS ...' : '', { font: 'small_o', tint: C.soft });
    if (Scores.isShared()) {
      Scores.fetchBoard().then((b) => {
        if (!this.sys.isActive()) return;
        rank.setText(b && b.me ? `NR. ${b.me.rank} AF ${b.count} PÅ LISTEN` : '');
      });
    }
    txt(this, cx, 206, PROMO.pitch, { font: 'ui', maxWidth: 210, center: true });
    button(this, cx, 248, 190, 28, PROMO.label, () => openUrl(PROMO.url), { color: C.green, font: 'small_o' });
    button(this, cx, 284, 190, 28, 'TOPSCORERLISTEN', () => this.scene.start('Scores'));
    this.input.keyboard?.once('keydown-ENTER', () => this.scene.start('Scores'));
    sfx('win');
  }
}

function openUrl(url) {
  try {
    const w = window.open(url, '_blank', 'noopener');
    if (!w) window.location.href = url;
  } catch (e) {
    try { window.location.href = url; } catch (e2) { /* ikke muligt her */ }
  }
}
