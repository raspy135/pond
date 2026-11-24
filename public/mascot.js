// Pond mascot — the ink-splash slime, built from named layers so each part animates on its own.
// Usage: const el = PondMascot.create('happy'); PondMascot.setMood(el, 'thinking'); el.classList.add('pm-alive')
// Layers: drops · antennae (l/r) · body (+shine) · cheeks · eyes (+lids) · mouth · extras (thought dots, z, tear)
(function () {
  const MOODS = ['happy', 'thinking', 'wow', 'sleepy', 'sad'];
  let uid = 0;

  const CSS = `
.pm-icosa{color:inherit;--pm-wire:var(--pm-body)}
html[data-look=plate] .pm-icosa{--pm-wire:currentColor}
.pm-icosa line{stroke:var(--pm-wire);vector-effect:non-scaling-stroke}
.pm-icosa circle{fill:var(--pm-wire)}
.pm-icosa circle.pm-ico-lit{fill:var(--pm-stain,#e8749f)}
.pm-icosa .pm-move{transform-origin:50% 50%}
.pm-walker{color:inherit;--pm-wire:var(--pm-body)}
html[data-look=plate] .pm-walker{--pm-wire:currentColor}
.pm-walker line{stroke:var(--pm-wire);vector-effect:non-scaling-stroke;stroke-linecap:round}
.pm-walker circle{fill:var(--pm-wire)}
.pm-walker circle.pm-ico-lit{fill:var(--pm-stain,#e8749f)}
.pm-walker path.pm-wk-leg,.pm-walker circle.pm-wk-paw{fill:none;stroke:var(--pm-wire);vector-effect:non-scaling-stroke;stroke-linejoin:round}
.pm-walker .pm-wk-shadow{fill:var(--pm-wire);opacity:.13}
.pm-walker .pm-move{transform-origin:50% 70%}
.pond-mascot.pm-walker.pm-working svg{animation:none}
:root{--pm-body:#22c3e6;--pm-stem:#1aa6c8;--pm-tip:#ffd166;--pm-drop:#5fd8f0;--pm-on:#0f172a}
.pond-mascot{display:inline-block;width:100%;height:100%;line-height:0}
.pond-mascot svg{width:100%;height:100%;overflow:visible}
.pond-mascot .pm-move{display:block;width:100%;height:100%;transform-origin:50% 92%}
/* occasional moves (whole character) */
.pond-mascot.pm-jump .pm-move{animation:pmJump .85s cubic-bezier(.3,.7,.4,1)}
.pond-mascot.pm-spin .pm-move{animation:pmHop 1.3s ease-in-out}
@keyframes pmJump{0%{transform:none}14%{transform:scale(1.12,.86)}38%{transform:translateY(-34%) scale(.92,1.1)}55%{transform:translateY(-38%) scale(1,1)}78%{transform:translateY(0) scale(1.1,.9)}90%{transform:scale(.97,1.03)}100%{transform:none}}
@keyframes pmHop{0%,100%{transform:none}50%{transform:translateY(-8%) scale(1.02,.98)}}
.pond-mascot svg g,.pond-mascot svg circle,.pond-mascot svg ellipse{transform-box:fill-box;transform-origin:center}
.pond-mascot .pm-ant-l{transform-box:view-box;transform-origin:27px 17px}
.pond-mascot .pm-ant-r{transform-box:view-box;transform-origin:37px 16px}
.pond-mascot .pm-body{transform-origin:50% 90%}
.pond-mascot .pm-eyes,.pond-mascot .pm-face>*{transition:transform .25s ease,opacity .2s ease}
.pond-mascot .pm-mouth>*,.pond-mascot .pm-extra>*,.pond-mascot .pm-lids{opacity:0;transition:opacity .18s ease}
.pond-mascot[data-mood=happy] .m-happy,.pond-mascot[data-mood=thinking] .m-thinking,.pond-mascot[data-mood=wow] .m-wow,
.pond-mascot[data-mood=sleepy] .m-sleepy,.pond-mascot[data-mood=sad] .m-sad,
.pond-mascot[data-mood=thinking] .x-thinking,.pond-mascot[data-mood=sleepy] .x-sleepy,.pond-mascot[data-mood=sad] .x-sad{opacity:1}
.pond-mascot[data-mood=thinking] .pm-eyes{transform:translate(1.6px,-1.8px)}
.pond-mascot[data-mood=wow] .pm-eyes{transform:scale(1.06,1.16)}
.pond-mascot[data-mood=sad] .pm-eyes{transform:translateY(1px)}
.pond-mascot[data-mood=sleepy] .pm-eyes{opacity:0}
.pond-mascot[data-mood=sleepy] .pm-lids{opacity:1}
.pond-mascot[data-mood=sad] .pm-cheeks{opacity:.35}
/* idle life (only on the mascot marked pm-alive) */
.pond-mascot.pm-alive .pm-ant-l{animation:pmSwayL 3.2s ease-in-out infinite}
.pond-mascot.pm-alive .pm-ant-r{animation:pmSwayR 3.6s ease-in-out infinite}
.pond-mascot.pm-alive .pm-eye{animation:pmBlink 4.6s infinite}
.pond-mascot.pm-alive .pm-drop{animation:pmFloat 2.8s ease-in-out infinite}
.pond-mascot.pm-alive .pm-drop.d2{animation-delay:-.9s}.pond-mascot.pm-alive .pm-drop.d3{animation-delay:-1.8s}
.pond-mascot.pm-alive .pm-body{animation:pmBreathe 3.4s ease-in-out infinite}
.pond-mascot.pm-alive .x-sleepy{animation:pmFloat 2.4s ease-in-out infinite}
.pond-mascot.pm-alive .x-thinking circle{animation:pmPulse 1.2s ease-in-out infinite}
.pond-mascot.pm-alive .x-thinking circle+circle{animation-delay:.3s}
/* working: whole slime wobbles, antennae wiggle faster */
.pond-mascot.pm-working svg{animation:pmWobble 1.4s ease-in-out infinite;transform-origin:50% 90%}
.pond-mascot.pm-working .pm-ant-l{animation:pmSwayL .9s ease-in-out infinite}
.pond-mascot.pm-working .pm-ant-r{animation:pmSwayR .8s ease-in-out infinite}
.pond-mascot.pm-pop svg{animation:pmPop .35s ease}
@keyframes pmSwayL{0%,100%{transform:rotate(0)}50%{transform:rotate(-12deg)}}
@keyframes pmSwayR{0%,100%{transform:rotate(0)}50%{transform:rotate(12deg)}}
@keyframes pmBlink{0%,93%,100%{transform:scaleY(1)}95.5%{transform:scaleY(.08)}}
@keyframes pmFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.6px)}}
@keyframes pmBreathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.025,.975)}}
@keyframes pmPulse{0%,100%{opacity:.5}50%{opacity:1}}
@keyframes pmWobble{0%,100%{transform:scale(1,1) translateY(0)}25%{transform:scale(1.08,.92) translateY(1px)}50%{transform:scale(.94,1.07) translateY(-2px)}75%{transform:scale(1.04,.97)}}
@keyframes pmPop{0%{transform:scale(.82)}60%{transform:scale(1.08)}100%{transform:scale(1)}}
/* compact: simplified for small sizes (chat avatar) — fewer, bolder details */
.pond-mascot.pm-compact .pm-drops,.pond-mascot.pm-compact .pm-shine-dot{display:none}
.pond-mascot.pm-compact .pm-ant path{stroke-width:3.8}
.pond-mascot.pm-compact .pm-ant circle{transform:scale(1.3)}
.pond-mascot.pm-compact .pm-eyes-size{transform:scale(1.22);transform-origin:32px 37px;transform-box:view-box}
.pond-mascot.pm-compact .pm-mouth path{stroke-width:2.7}
.pond-mascot.pm-compact .pm-mouth ellipse{transform:scale(1.2)}
.pond-mascot.pm-compact .pm-cheeks ellipse{transform:scale(1.25)}
.pond-mascot.pm-compact .pm-shine{stroke-width:3.4}
.pond-mascot.pm-compact .x-thinking,.pond-mascot.pm-compact .x-sleepy{display:none}
/* spin = the ball turns around: face slides off one side, passes behind, comes back from the other */
.pond-mascot.pm-spin .pm-face{animation:pmTurnFace 1.3s ease-in-out}
.pond-mascot.pm-spin .pm-ant-l,.pond-mascot.pm-spin .pm-ant-r{animation:pmTurnAnt 1.3s ease-in-out}
.pond-mascot.pm-spin .pm-extra{animation:pmTurnFace 1.3s ease-in-out}
@keyframes pmTurnFace{
 0%{transform:none;opacity:1}
 22%{transform:translateX(11px) scaleX(.6);opacity:1}
 30%{transform:translateX(15px) scaleX(.2);opacity:0}
 31%,69%{transform:translateX(-15px) scaleX(.2);opacity:0}
 78%{transform:translateX(-11px) scaleX(.6);opacity:1}
 100%{transform:none;opacity:1}}
@keyframes pmTurnAnt{
 0%{transform:none}
 25%{transform:translateX(7px) scaleX(.7)}
 50%{transform:translateX(0) scaleX(-1)}
 75%{transform:translateX(-7px) scaleX(.7)}
 100%{transform:none}}
/* user-uploaded image instead of the mascot: same moves, no face layers */
.pond-mascot.pm-image .pm-move>img{width:100%;height:100%;object-fit:contain;display:block;user-select:none;-webkit-user-drag:none}
.pond-mascot.pm-image.pm-circle .pm-move>img{object-fit:cover;border-radius:50%}
.pond-mascot.pm-image.pm-working .pm-move>img{animation:pmWobble 1.4s ease-in-out infinite;transform-origin:50% 90%}
.pond-mascot.pm-image.pm-pop .pm-move>img{animation:pmPop .35s ease}
@media (prefers-reduced-motion:reduce){.pond-mascot *,.pond-mascot svg{animation:none!important}}`;

  function injectCss() {
    if (document.getElementById('pond-mascot-css')) return;
    const s = document.createElement('style');
    s.id = 'pond-mascot-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  const INK = '#0f172a';
  function svg(g) {
    const eye = (cx, side) => `<g class="pm-eye pm-eye-${side}"><ellipse cx="${cx}" cy="35" rx="4.2" ry="5.2" fill="${INK}"/><circle cx="${cx + 1.6}" cy="33" r="1.6" fill="#fff"/><circle cx="${cx - 1}" cy="37.2" r=".8" fill="#fff" opacity=".8"/></g>`;
    const line = `stroke="${INK}" fill="none" stroke-linecap="round"`;
    return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<g class="pm-drops"><circle class="pm-drop d1" cx="57.5" cy="16.5" r="2.4" style="fill:var(--pm-drop)"/><circle class="pm-drop d2" cx="7.5" cy="29" r="1.9" style="fill:var(--pm-drop)"/><circle class="pm-drop d3" cx="49" cy="58.5" r="1.7" style="fill:var(--pm-stem)"/></g>
<g class="pm-ant pm-ant-l"><path d="M27 17 Q24 10 21 7.5" style="stroke:var(--pm-stem)" stroke-width="2.6" stroke-linecap="round" fill="none"/><circle cx="20.5" cy="7" r="3.1" style="fill:var(--pm-tip)"/></g>
<g class="pm-ant pm-ant-r"><path d="M37 16 Q40 9 43.5 6.5" style="stroke:var(--pm-stem)" stroke-width="2.6" stroke-linecap="round" fill="none"/><circle cx="44" cy="6" r="3.1" style="fill:var(--pm-tip)"/></g>
<g class="pm-body"><path d="M32 14 C38 14 41 18 44 20 C49 17 55 19 53 25 C52 28 55 31 56 35 C60 37 59 43 54 43 C53 50 47 55 40 55 C38 59 33 60.5 30.5 56.5 C24 57 17 54 14 47 C9 47 7 41 12 38.5 C10 33 12 27 17 24 C16 18 22 15 26 17.5 C27 15 29 14 32 14 Z" style="fill:var(--pm-body)"/>
<path class="pm-shine" d="M19 30 Q20 25 25 23" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none" opacity=".55"/>
<g class="pm-face">
 <g class="pm-cheeks"><ellipse cx="19" cy="43.5" rx="3.4" ry="2" fill="#ff8db8" opacity=".85"/><ellipse cx="45" cy="43.5" rx="3.4" ry="2" fill="#ff8db8" opacity=".85"/></g>
 <g class="pm-eyes-size"><g class="pm-eyes">${eye(25, 'l')}${eye(39, 'r')}</g></g>
 <g class="pm-lids"><path d="M21 36 Q25 39 29 36" ${line} stroke-width="2.2"/><path d="M35 36 Q39 39 43 36" ${line} stroke-width="2.2"/></g>
 <g class="pm-mouth">
  <path class="m-happy" d="M28.5 44 Q32 48 35.5 44" ${line} stroke-width="2"/>
  <path class="m-thinking" d="M29.5 45.5 Q32 44.5 35 45.8" ${line} stroke-width="2"/>
  <ellipse class="m-wow" cx="32" cy="45.5" rx="2.4" ry="3" fill="${INK}"/>
  <path class="m-sleepy" d="M30 44.5 Q32 46 34 44.5" ${line} stroke-width="1.8"/>
  <path class="m-sad" d="M28.5 46.5 Q32 43.5 35.5 46.5" ${line} stroke-width="2"/>
 </g>
</g></g>
<g class="pm-extra">
 <g class="x-thinking"><circle cx="50" cy="12" r="1.3" fill="#93c5fd"/><circle cx="53.5" cy="9" r="1.7" fill="#93c5fd"/></g>
 <text class="x-sleepy" x="47" y="15" font-family="system-ui,sans-serif" font-weight="800" font-size="8" fill="#93c5fd">z</text>
 <path class="x-sad" d="M44 38 Q45.5 41 44 42.5 Q42.5 41 44 38 Z" fill="#a5f3fc"/>
</g></svg>`;
  }

  // opts.compact: simplified, tightly-cropped variant for small sizes (≤ 48px), e.g. chat avatars.
  function create(mood = 'happy', { compact = false } = {}) {
    injectCss();
    const el = document.createElement('span');
    el.className = 'pond-mascot' + (compact ? ' pm-compact' : '');
    el.dataset.mood = MOODS.includes(mood) ? mood : 'happy';
    el.innerHTML = `<span class="pm-move">${svg(`pmg${++uid}`)}</span>`;
    if (compact) el.querySelector('svg').setAttribute('viewBox', '8 1.5 50 59'); // crop to body + antennae
    if (el.dataset.mood === 'thinking') el.classList.add('pm-working');
    return el;
  }

  // ---------- Icosahedron character: a wireframe regular icosahedron, turning slowly like a specimen on a plate ----------
  // Moods drive the motion: happy = slow turn · thinking = fast spin · wow = one vertex lit in a stain colour + hop ·
  // sleepy = nearly still and faint · sad = slow, tipped forward. Back edges are fainter and thinner (depth cue).
  const PHI = (1 + Math.sqrt(5)) / 2;
  const ICO_V = [[-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI], [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]]
    .map((v) => { const l = Math.hypot(...v); return v.map((x) => x / l); });
  const ICO_E = [];
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
    const d = Math.hypot(ICO_V[i][0] - ICO_V[j][0], ICO_V[i][1] - ICO_V[j][1], ICO_V[i][2] - ICO_V[j][2]);
    if (d < 1.1) ICO_E.push([i, j]); // edge length of the unit icosahedron ≈ 1.05
  }
  const ICO_SPEED = { happy: 0.32, thinking: 2.4, wow: 1.1, sleepy: 0.06, sad: 0.16 };
  const icoState = new WeakMap();
  const SVGNS = 'http://www.w3.org/2000/svg';
  function icoDraw(el, t) {
    const st = icoState.get(el);
    if (!st) return;
    const mood = el.dataset.mood || 'happy';
    const a = st.phase + t * (ICO_SPEED[mood] ?? 0.3);
    const tilt = mood === 'sad' ? 0.75 : 0.42;
    const ca = Math.cos(a), sa = Math.sin(a), ct = Math.cos(tilt), stt = Math.sin(tilt);
    const P = ICO_V.map(([x, y, z]) => {
      const x1 = x * ca + z * sa, z1 = -x * sa + z * ca; // turn about the vertical axis
      const y2 = y * ct - z1 * stt, z2 = y * stt + z1 * ct; // tip toward the viewer
      return [x1 * 38, -y2 * 38, z2];
    });
    const dim = mood === 'sleepy' ? 0.5 : 1;
    ICO_E.forEach(([i, j], k) => {
      const ln = st.lines[k], z = (P[i][2] + P[j][2]) / 2; // -1 back … 1 front
      ln.setAttribute('x1', P[i][0].toFixed(2)); ln.setAttribute('y1', P[i][1].toFixed(2));
      ln.setAttribute('x2', P[j][0].toFixed(2)); ln.setAttribute('y2', P[j][1].toFixed(2));
      ln.setAttribute('stroke-opacity', ((0.28 + 0.72 * (z + 1) / 2) * dim).toFixed(2));
      ln.setAttribute('stroke-width', (0.7 + 0.9 * (z + 1) / 2).toFixed(2)); // px (non-scaling): crisp at 34 px and 100 px
    });
    P.forEach((p, i) => {
      const c = st.dots[i];
      c.setAttribute('cx', p[0].toFixed(2)); c.setAttribute('cy', p[1].toFixed(2));
      const lit = mood === 'wow' && i === st.litVertex;
      c.setAttribute('r', lit ? 5 : (1.4 + 1.6 * (p[2] + 1) / 2).toFixed(2));
      c.setAttribute('class', lit ? 'pm-ico-lit' : '');
      c.setAttribute('fill-opacity', lit ? 1 : ((0.3 + 0.7 * (p[2] + 1) / 2) * dim).toFixed(2));
    });
  }
  let icoRaf = 0;
  const icoStart = performance.now();
  function icoLoop(now) {
    icoRaf = 0;
    const t = (now - icoStart) / 1000;
    const live = document.querySelectorAll(':is(.pm-icosa, .pm-walker):is(.pm-alive, .pm-working, .pm-preview)');
    live.forEach((el) => (el.classList.contains('pm-walker') ? walkerDraw(el, t, now) : icoDraw(el, t)));
    if (live.length && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) icoRaf = requestAnimationFrame(icoLoop);
  }
  const icoKick = () => { if (!icoRaf) icoRaf = requestAnimationFrame(icoLoop); };

  // ---------- Walker character: the wireframe icosahedron on four chubby legs (water-bear stubby). The icosahedron
  // keeps turning like the plain one; its moves borrow from legged robots like BigDog: a diagonal trot while working,
  // a crouch-and-launch jump, and the shove-and-recover scramble (feet stepping fast to catch the body). ----------
  const walkerState = new WeakMap();
  const WK = { L: 0.4, R: 0.56, stand: 0.98 };
  // hips under the body: [x, z, knee direction] (FL, FR, HL, HR); knees point toward the middle, like BigDog's
  const WK_HIPS = [[0.3, 0.27, -1], [0.3, -0.27, -1], [-0.3, 0.27, 1], [-0.3, -0.27, 1]];
  const WK_TROT = [0, 0.5, 0.5, 0]; // diagonal pairs move together
  const frac = (x) => x - Math.floor(x);
  const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

  // The pose for this moment: body position/attitude and where each foot is (on the ground, or lifted).
  function walkerPose(el, st, t, nowMs) {
    const mood = el.dataset.mood || 'happy';
    const P = { bx: 0, by: WK.stand, bz: 0, pitch: 0, roll: 0, feet: WK_HIPS.map(([x, z]) => [x * 1.15, 0, z * 1.2]), air: 0, lit: mood === 'wow' };
    const tt = t + st.phase;
    if (mood === 'thinking') {
      const f = 2.3;
      P.by = WK.stand - 0.03 + 0.03 * Math.cos(4 * Math.PI * f * tt);
      P.pitch = 0.04 * Math.sin(2 * Math.PI * f * tt);
      P.roll = 0.03 * Math.sin(2 * Math.PI * f * tt + 1);
      P.feet = WK_HIPS.map(([x, z], i) => {
        const ph = frac(f * tt + WK_TROT[i]);
        const stance = ph < 0.5;
        const u = stance ? ph / 0.5 : (ph - 0.5) / 0.5;
        const dx = stance ? 0.1 - 0.2 * u : -0.1 + 0.2 * u;
        return [x * 1.15 + dx, stance ? 0 : 0.15 * Math.sin(Math.PI * u), z * 1.2];
      });
    } else if (mood === 'sleepy') {
      P.by = 0.6 + 0.012 * Math.sin(tt * 0.9); // lies down: legs fold out to the sides
      P.feet = WK_HIPS.map(([x, z]) => [x * 1.6, 0, z * 1.9]);
    } else if (mood === 'sad') {
      P.by = WK.stand - 0.1;
      P.pitch = -0.14;
    } else {
      // idle: shift weight, and lift a foot now and then
      P.by = WK.stand + 0.015 * Math.sin(tt * 1.6);
      P.roll = 0.05 * Math.sin(tt * 0.8);
      P.bz = 0.035 * Math.sin(tt * 0.8);
      P.pitch = 0.025 * Math.sin(tt * 1.1);
      const cycle = 3.6;
      const k = Math.floor(tt / cycle), u = (tt - k * cycle) / 0.45;
      if (u < 1) {
        const leg = k % 4;
        P.feet[leg] = [P.feet[leg][0] + 0.05 * Math.sin(Math.PI * u), 0.13 * Math.sin(Math.PI * u), P.feet[leg][2]];
      }
    }
    // one-off moves (PondMascot.act)
    const a = st.action;
    if (a) {
      const u = (nowMs - a.t0) / a.dur;
      if (u >= 1) st.action = null;
      else if (a.type === 'jump') {
        const crouch = WK.stand - 0.2;
        if (u < 0.22) P.by = WK.stand - 0.2 * ease(u / 0.22);
        else if (u < 0.7) {
          const v = (u - 0.22) / 0.48;
          P.by = crouch + 0.1 * v + 0.6 * Math.sin(Math.PI * v);
          P.pitch = 0.22 * Math.sin(2 * Math.PI * v);
          P.air = Math.sin(Math.PI * v);
          P.feet = WK_HIPS.map(([x, z, k]) => [x * 1.15 - k * 0.12 * Math.sin(Math.PI * v), 0, z * 1.2]); // stretch out in the air
        } else P.by = WK.stand - 0.1 + 0.1 * ease((u - 0.7) / 0.3);
        P.lit = true;
      } else if (a.type === 'recover') {
        // shoved sideways: the body swings out and back while the feet scramble to stay under it
        const push = u < 0.16 ? Math.sin((u / 0.16) * Math.PI / 2) : Math.exp(-3.2 * (u - 0.16)) * Math.cos((u - 0.16) * 7);
        P.bz = 0.26 * push;
        P.roll = -0.35 * push;
        const fade = Math.max(0, 1 - u * 1.3);
        P.feet = WK_HIPS.map(([x, z], i) => {
          const ph = frac(u * 6 + WK_TROT[i]);
          const lift = ph >= 0.5 ? 0.13 * fade * Math.sin(Math.PI * (ph - 0.5) * 2) : 0;
          return [x * 1.15, lift, z * 1.2 + P.bz * 0.8];
        });
        P.lit = true;
      }
    }
    return P;
  }

  function walkerDraw(el, t, nowMs = performance.now()) {
    const st = walkerState.get(el);
    if (!st) return;
    const mood = el.dataset.mood || 'happy';
    const P = walkerPose(el, st, t, nowMs);
    const cp = Math.cos(P.pitch), sp = Math.sin(P.pitch), cr = Math.cos(P.roll), sr = Math.sin(P.roll);
    const body = ([x, y, z]) => { // body → world
      const y1 = y * cr - z * sr, z1 = y * sr + z * cr;
      return [x * cp - y1 * sp + P.bx, x * sp + y1 * cp + P.by, z1 + P.bz];
    };
    // camera: a three-quarter view that sways gently, looking down a little
    const yaw = -0.75 + 0.38 * Math.sin((t + st.phase) * 0.22);
    const cy = Math.cos(yaw), sy = Math.sin(yaw), tilt = 0.34, ct = Math.cos(tilt), stl = Math.sin(tilt);
    const S = 44;
    const proj = ([x, y, z]) => {
      const x1 = x * cy + z * sy, z1 = -x * sy + z * cy, y0 = y - 0.62;
      const y2 = y0 * ct - z1 * stl, z2 = y0 * stl + z1 * ct;
      return [x1 * S, -y2 * S, z2];
    };
    const shade = (z) => Math.max(0.25, Math.min(1, 0.6 + 0.45 * z));
    const dim = mood === 'sleepy' ? 0.55 : 1;
    let li = 0;
    const seg = (pa, pb, w0, w1, opacity = 1) => {
      const ln = st.lines[li++], z = (pa[2] + pb[2]) / 2;
      ln.setAttribute('x1', pa[0].toFixed(2)); ln.setAttribute('y1', pa[1].toFixed(2));
      ln.setAttribute('x2', pb[0].toFixed(2)); ln.setAttribute('y2', pb[1].toFixed(2));
      ln.setAttribute('stroke-opacity', (shade(z) * opacity).toFixed(2));
      ln.setAttribute('stroke-width', (w0 + w1 * (z + 1) / 2).toFixed(2));
    };
    // A leg segment as a wireframe capsule: two side lines joined by half circles at the ends.
    const capsule = (path, a, b, r) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1e-6;
      const nx = (-dy / d) * r, ny = (dx / d) * r, z = (a[2] + b[2]) / 2;
      const f = (v) => v.toFixed(2);
      path.setAttribute('d', `M${f(a[0] + nx)} ${f(a[1] + ny)}L${f(b[0] + nx)} ${f(b[1] + ny)}A${r} ${r} 0 0 0 ${f(b[0] - nx)} ${f(b[1] - ny)}L${f(a[0] - nx)} ${f(a[1] - ny)}A${r} ${r} 0 0 0 ${f(a[0] + nx)} ${f(a[1] + ny)}Z`);
      path.setAttribute('stroke-opacity', (shade(z) * dim).toFixed(2));
      path.setAttribute('stroke-width', (0.8 + 0.8 * (z + 1) / 2).toFixed(2));
    };
    // legs first (behind the body's front edges): chubby two-link legs with round paws
    WK_HIPS.forEach(([hx, hz, k], i) => {
      const H = body([hx, -0.3, hz]);
      let F = [P.feet[i][0] + P.bx, Math.max(P.feet[i][1], 0), P.feet[i][2]];
      let dx = F[0] - H[0], dy = F[1] - H[1];
      let d = Math.hypot(dx, dy);
      const reach = 2 * WK.L * 0.995;
      if (d > reach) { F = [H[0] + (dx / d) * reach, H[1] + (dy / d) * reach, F[2]]; dx = F[0] - H[0]; dy = F[1] - H[1]; d = reach; }
      const base = Math.atan2(dy, dx), bend = Math.acos(Math.min(1, Math.max(d, 0.05) / (2 * WK.L)));
      const ang = base + k * bend;
      const K = [H[0] + WK.L * Math.cos(ang), H[1] + WK.L * Math.sin(ang), (H[2] + F[2]) / 2];
      const pH = proj(H), pK = proj(K), pF = proj(F);
      capsule(st.legs[i * 2], pH, pK, 4.6);
      capsule(st.legs[i * 2 + 1], pK, pF, 4.3);
      const paw = st.dots[12 + i];
      paw.setAttribute('cx', pF[0].toFixed(2)); paw.setAttribute('cy', pF[1].toFixed(2));
      paw.setAttribute('stroke-opacity', (shade(pF[2]) * dim).toFixed(2));
      paw.setAttribute('stroke-width', (0.8 + 0.8 * (pF[2] + 1) / 2).toFixed(2));
    });
    // the icosahedron body, turning on its own like the plain one
    const spin = st.phase + t * (ICO_SPEED[mood] ?? 0.3);
    const cs = Math.cos(spin), ss = Math.sin(spin);
    const V = ICO_V.map(([x, y, z]) => proj(body([(x * cs + z * ss) * WK.R, y * WK.R, (-x * ss + z * cs) * WK.R])));
    ICO_E.forEach(([a, b]) => seg(V[a], V[b], 0.7, 0.9, dim));
    V.forEach((p, i) => {
      const c = st.dots[i];
      const lit = P.lit && i === st.litVertex;
      c.setAttribute('cx', p[0].toFixed(2)); c.setAttribute('cy', p[1].toFixed(2));
      c.setAttribute('r', lit ? 5 : (1.3 + 1.4 * Math.max(0, Math.min(1, (p[2] + 1) / 2))).toFixed(2));
      c.setAttribute('class', lit ? 'pm-ico-lit' : '');
      c.setAttribute('fill-opacity', lit ? 1 : (shade(p[2]) * dim).toFixed(2));
    });
    // shadow on the ground (smaller while airborne)
    const g = proj([P.bx, 0, P.bz]);
    st.shadow.setAttribute('cx', g[0].toFixed(2)); st.shadow.setAttribute('cy', g[1].toFixed(2));
    st.shadow.setAttribute('rx', (28 * (1 - 0.35 * P.air)).toFixed(2)); st.shadow.setAttribute('ry', (28 * stl * 0.8 * (1 - 0.35 * P.air)).toFixed(2));
  }

  function createWalker(mood = 'happy') {
    injectCss();
    const el = document.createElement('span');
    el.className = 'pond-mascot pm-walker';
    el.dataset.mood = MOODS.includes(mood) ? mood : 'happy';
    const svgEl = document.createElementNS(SVGNS, 'svg');
    svgEl.setAttribute('viewBox', '-50 -50 100 100');
    svgEl.setAttribute('aria-hidden', 'true');
    const g = document.createElementNS(SVGNS, 'g');
    const shadow = document.createElementNS(SVGNS, 'ellipse');
    shadow.setAttribute('class', 'pm-wk-shadow');
    g.appendChild(shadow);
    const legs = Array.from({ length: 8 }, () => { const pth = document.createElementNS(SVGNS, 'path'); pth.setAttribute('class', 'pm-wk-leg'); g.appendChild(pth); return pth; });
    const paws = Array.from({ length: 4 }, () => { const c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('r', '5.4'); c.setAttribute('class', 'pm-wk-paw'); g.appendChild(c); return c; });
    const lines = ICO_E.map(() => { const l = document.createElementNS(SVGNS, 'line'); g.appendChild(l); return l; });
    const dots = [...ICO_V.map(() => { const c = document.createElementNS(SVGNS, 'circle'); g.appendChild(c); return c; }), ...paws];
    svgEl.appendChild(g);
    const move = document.createElement('span');
    move.className = 'pm-move';
    move.appendChild(svgEl);
    el.appendChild(move);
    walkerState.set(el, { lines, legs, dots, shadow, phase: Math.random() * 20, litVertex: Math.floor(Math.random() * 12), action: null });
    walkerDraw(el, 0); // a still pose for history avatars; live ones move
    if (el.dataset.mood === 'thinking') el.classList.add('pm-working');
    new MutationObserver(icoKick).observe(el, { attributes: true, attributeFilter: ['class', 'data-mood'] });
    icoKick();
    return el;
  }

  function createIcosa(mood = 'happy') {
    injectCss();
    const el = document.createElement('span');
    el.className = 'pond-mascot pm-icosa';
    el.dataset.mood = MOODS.includes(mood) ? mood : 'happy';
    const svgEl = document.createElementNS(SVGNS, 'svg');
    svgEl.setAttribute('viewBox', '-50 -50 100 100');
    svgEl.setAttribute('aria-hidden', 'true');
    const g = document.createElementNS(SVGNS, 'g');
    const lines = ICO_E.map(() => { const l = document.createElementNS(SVGNS, 'line'); l.setAttribute('stroke-linecap', 'round'); g.appendChild(l); return l; });
    const dots = ICO_V.map(() => { const c = document.createElementNS(SVGNS, 'circle'); g.appendChild(c); return c; });
    svgEl.appendChild(g);
    const move = document.createElement('span');
    move.className = 'pm-move';
    move.appendChild(svgEl);
    el.appendChild(move);
    icoState.set(el, { lines, dots, phase: Math.random() * Math.PI * 2, litVertex: Math.floor(Math.random() * 12) });
    icoDraw(el, 0); // a still pose for history avatars; live ones turn
    if (el.dataset.mood === 'thinking') el.classList.add('pm-working');
    new MutationObserver(icoKick).observe(el, { attributes: true, attributeFilter: ['class', 'data-mood'] });
    icoKick();
    return el;
  }

  // A user-supplied image in place of the mascot (Agent Hub → Appearance). Moods only drive motion.
  function createImage(url, mood = 'happy', { circle = true } = {}) {
    injectCss();
    const el = document.createElement('span');
    el.className = 'pond-mascot pm-image' + (circle ? ' pm-circle' : '');
    el.dataset.mood = MOODS.includes(mood) ? mood : 'happy';
    const move = document.createElement('span');
    move.className = 'pm-move';
    const img = document.createElement('img');
    img.src = url; img.alt = ''; img.draggable = false;
    move.appendChild(img);
    el.appendChild(move);
    if (el.dataset.mood === 'thinking') el.classList.add('pm-working');
    return el;
  }

  function setMood(el, mood) {
    if (!el || !MOODS.includes(mood) || el.dataset.mood === mood) return;
    el.dataset.mood = mood;
    el.classList.toggle('pm-working', mood === 'thinking');
    el.classList.remove('pm-pop'); // a leftover pop would override the working wobble
    if (mood !== 'thinking') { void el.offsetWidth; el.classList.add('pm-pop'); }
    if (mood === 'wow') act(el, 'jump'); // alerts make it hop
  }

  // One-off moves: 'jump' | 'spin'
  function act(el, move) {
    if (!el || el.classList.contains('pm-working') || el.dataset.acting) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    if (el.classList.contains('pm-walker')) { // its own moves: a real jump, or the shove-and-recover scramble
      const st = walkerState.get(el);
      if (st && !st.action) st.action = move === 'spin' ? { type: 'recover', t0: performance.now(), dur: 1500 } : { type: 'jump', t0: performance.now(), dur: 1000 };
      icoKick();
      return;
    }
    if (move === 'spin' && (el.classList.contains('pm-image') || el.classList.contains('pm-icosa'))) move = 'jump'; // the ball-turn needs the mascot's face layers
    const cls = move === 'spin' ? 'pm-spin' : 'pm-jump';
    el.dataset.acting = '1';
    el.classList.add(cls);
    const done = () => { el.classList.remove(cls); delete el.dataset.acting; };
    const mv = el.querySelector('.pm-move');
    const onEnd = (e) => { if (e.target === mv) { mv.removeEventListener('animationend', onEnd); done(); } };
    mv?.addEventListener('animationend', onEnd);
    setTimeout(done, 1500); // safety net if animationend never fires
  }

  // Idle life: every 7-15 s the alive mascot (newest reply) jumps or spins.
  function scheduleIdleMove() {
    setTimeout(() => {
      if (document.visibilityState === 'visible') {
        const el = document.querySelector('.pond-mascot.pm-alive:not(.pm-working)');
        if (el) act(el, Math.random() < 0.65 ? 'jump' : 'spin');
      }
      scheduleIdleMove();
    }, 7000 + Math.random() * 8000);
  }
  scheduleIdleMove();

  // ---------- Palettes (configurable in Agent Hub → Appearance; server setting ui.mascotPalette) ----------
  const PALETTES = {
    cyan: { body: '#22c3e6', stem: '#1aa6c8', tip: '#ffd166', drop: '#5fd8f0' },
    teal: { body: '#1fb8a4', stem: '#16998a', tip: '#ffcf5c', drop: '#5ad6c6' },
    mint: { body: '#3fd18f', stem: '#2fb378', tip: '#ff9ec7', drop: '#7ae3b2' },
    violet: { body: '#8b6cf6', stem: '#7556e8', tip: '#7ce7f0', drop: '#a993fa' },
    pink: { body: '#ff7eb6', stem: '#f2609f', tip: '#7ce7f0', drop: '#ffa3cb' },
    coral: { body: '#ff8a5c', stem: '#f06f3f', tip: '#7ce7f0', drop: '#ffab88' },
    ink: { body: '#2f3b66', stem: '#253055', tip: '#5ee7df', drop: '#4a5a8f' },
  };
  const shade = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    const c = (sh) => Math.max(0, Math.min(255, Math.round(((n >> sh) & 255) * f)));
    return '#' + [16, 8, 0].map((sh) => c(sh).toString(16).padStart(2, '0')).join('');
  };
  // Custom body color -> derive stem/drop shades and a contrasting antenna tip (warm tip on cool bodies, cool tip on warm).
  function paletteFromColor(hex) {
    const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0;
    if (max !== min) h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
    h = (h * 60 + 360) % 360;
    const cool = h >= 140 && h <= 260;
    return { body: hex, stem: shade(hex, 0.86), tip: cool ? '#ffd166' : '#7ce7f0', drop: shade(hex, 1.15) };
  }
  function resolvePalette(name = 'cyan', color = '') {
    if (name === 'custom' && /^#[0-9a-f]{6}$/i.test(color)) return paletteFromColor(color);
    return PALETTES[name] || PALETTES.cyan;
  }
  // Applies to every mascot on the page (CSS variables on :root, or on a given element for previews).
  // Readable foreground on the body color (e.g. the send arrow): whichever of white / ink has more contrast.
  function onColor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.0587) ? '#ffffff' : '#0f172a'; // 0.0587 = luminance(#0f172a) + 0.05
  }
  function setPalette(name, color, target = document.documentElement) {
    const p = resolvePalette(name, color);
    for (const [k, v] of Object.entries(p)) target.style.setProperty(`--pm-${k}`, v);
    target.style.setProperty('--pm-on', onColor(p.body));
    return p;
  }

  window.PondMascot = { create, createImage, createIcosa, createWalker, setMood, act, setPalette, resolvePalette, PALETTES, MOODS };
})();
