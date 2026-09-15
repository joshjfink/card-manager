/* cm-stub-game.js — a placeholder game, for proving the shell.
 *
 * It is deliberately NOT Card Manager. Its whole job is to touch every part
 * of the CM_SHELL surface once, so a bundle built with it proves the host
 * end to end before the real game is extracted:
 *
 *   rr · drawChar · drawBall · colors · W/H     drawing helpers
 *   sfx.select/point/thud/whistle/fanfare       the synth
 *   music.play/stop                             the sequencer
 *   shake · burst · floatText                   the juice
 *   rnd · clamp · lerp                          the maths
 *   over({win,score,lines})                     the results presenter
 *   input.px/py/clicked/pressed                 pointer + keys
 *
 * It also publishes window.__MG_SCREEN and window.__MG_HOTS in the same shape
 * the real game does, so tools/mg-tap-suite.js can drive it with expectScreen
 * and tapId exactly as it drives Card Manager.
 */
(() => {
  'use strict';
  const S = window.CM_SHELL;
  if (!S) return;

  S.register({
    id: 'stub', title: 'SHELL CHECK', icon: '🧪',
    create(env) {
      const { W, H, colors: C, rr, drawChar, drawBall } = env;
      let screen = 'home';
      let t = 0, pulses = 0, spin = 0;
      let hots = [];
      const hot = (id, x, y, w, h, cb) => { hots.push({ id, x, y, w, h, cb }); };
      const publish = () => {
        window.__MG_SCREEN = 'stub/' + screen;
        window.__MG_HOTS = hots.map(r => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h,
                                            cx: r.x + r.w / 2, cy: r.y + r.h / 2 }));
      };
      const hitAt = (x, y) => {
        for (let i = hots.length - 1; i >= 0; i--) {
          const r = hots[i];
          if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
        }
        return null;
      };

      /* the frame's controls are declared once per update, then drawn */
      function build() {
        hots = [];
        if (screen === 'home') {
          hot('stub-juice', 350, 300, 260, 68, () => {
            pulses++;
            env.sfx.point();
            env.shake(env.clamp(6 + pulses * 2, 6, 14));
            env.burst(480, 300, C.gold, 22);
            env.floatText(480, 280, '+' + Math.round(env.rnd(10, 99)), C.gold);
          });
          hot('stub-detail', 350, 388, 260, 68, () => {
            screen = 'detail'; env.sfx.select();
          });
        } else {
          hot('stub-back', 60, 500, 200, 68, () => { screen = 'home'; env.sfx.move(); });
          hot('stub-finish', 560, 500, 340, 68, () => {
            env.sfx.whistle();
            env.over({
              win: true, score: 100 + pulses * 25,
              title: 'SHELL OK',
              lines: ['Every CM_SHELL helper answered.',
                      pulses + ' juice ' + (pulses === 1 ? 'pulse' : 'pulses') + ' fired.'],
              cta: 'TAP TO RUN IT AGAIN',
            });
          });
        }
        publish();
      }

      env.music.play('menu');

      return {
        update(dt, input) {
          t += dt; spin += dt * 2.2;
          build();
          if (input.clicked) {
            const r = hitAt(input.px, input.py);
            if (r) r.cb();
            else env.sfx.thud();
          }
          if (input.pressed('enter') || input.pressed('action')) {
            const r = hots[hots.length - 1];
            if (r) r.cb();
          }
          if (input.pressed('esc') && screen === 'detail') { screen = 'home'; env.sfx.move(); }
        },
        draw(g) {
          /* ground */
          g.fillStyle = C.pitch; g.fillRect(0, 0, W, H);
          g.fillStyle = 'rgba(234,242,230,.02)';
          for (let x = ((t * 8) % 200) - 200; x < W; x += 200) g.fillRect(x, 0, 100, H);

          g.textAlign = 'center';
          g.font = 'bold 46px ui-rounded, system-ui';
          g.fillStyle = C.gold;
          g.fillText('CARD MANAGER', W / 2, 96);
          g.font = 'bold 16px ui-rounded, system-ui';
          g.fillStyle = C.fade;
          g.fillText('standalone shell check · v' + S.version, W / 2, 126);

          /* live readout of the host, so a screenshot is evidence */
          const d = S.debug();
          g.font = 'bold 15px ui-rounded, system-ui';
          g.fillStyle = C.chalk;
          const read = 'scale ' + d.s + '  ·  ' + d.profile
            + '  ·  ' + (d.rotated ? 'ROTATED' : 'flat')
            + '  ·  dpr ' + d.dpr + '  ·  ' + (d.legacyMap ? 'legacy map' : 'true map');
          g.fillText(read, W / 2, 162);
          g.fillStyle = C.fade;
          g.font = 'bold 14px ui-rounded, system-ui';
          g.fillText('save namespace: ' + (window.CM_SAVE ? window.CM_SAVE.key() : 'n/a')
            + (window.CM_SAVE && window.CM_SAVE.bridged ? '  (bridged)' : ''), W / 2, 186);

          if (screen === 'home') {
            drawChar(g, 'Gibson', 250, 300, 1.6, 'cheer', t);
            drawChar(g, 'Phoenix', 710, 300, 1.5, 'run', t);
            drawBall(g, 480, 232, 18, spin);
          } else {
            g.font = 'bold 26px ui-rounded, system-ui';
            g.fillStyle = C.chalk;
            g.fillText('THE HOST IS UP', W / 2, 260);
            g.font = 'bold 16px ui-rounded, system-ui';
            g.fillStyle = C.fade;
            const rows = ['canvas + loop + crash armour', 'touch / pointer / keys',
                          'synth + music sequencer', 'particles, shake, floating text',
                          'transitions + results presenter'];
            rows.forEach((r, i) => g.fillText('· ' + r, W / 2, 300 + i * 28));
            drawChar(g, 'Ellis', 160, 300, 1.4, 'idle', t);
          }

          for (const r of hots) {
            const on = env.lerp(0.55, 1, 0.5 + 0.5 * Math.sin(t * 3));
            g.fillStyle = C.turf2; g.strokeStyle = C.gold; g.lineWidth = 2.5;
            rr(g, r.x, r.y, r.w, r.h, 12); g.fill(); g.stroke();
            g.globalAlpha = on;
            g.fillStyle = C.gold;
            g.font = 'bold 20px ui-rounded, system-ui';
            g.fillText(LABEL[r.id] || r.id, r.x + r.w / 2, r.y + r.h / 2 + 7);
            g.globalAlpha = 1;
          }
          g.font = 'bold 14px ui-rounded, system-ui';
          g.fillStyle = C.fade;
          g.fillText('tap a button · M mutes', W / 2, H - 14);
        },
      };
    },
  });

  const LABEL = {
    'stub-juice': 'MAKE SOME NOISE',
    'stub-detail': 'NEXT SCREEN',
    'stub-back': 'BACK',
    'stub-finish': 'FINISH THE RUN',
  };
})();
