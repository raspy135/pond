// Pond mascot — the ink-splash slime, built from named layers so each part animates on its own.
// Usage: const el = PondMascot.create('happy'); PondMascot.setMood(el, 'thinking'); el.classList.add('pm-alive')
// Layers: drops · antennae (l/r) · body (+shine) · cheeks · eyes (+lids) · mouth · extras (thought dots, z, tear)
(function () {
  const MOODS = ['happy', 'thinking', 'wow', 'sleepy', 'sad'];
  let uid = 0;

  const CSS = `
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
    if (move === 'spin' && el.classList.contains('pm-image')) move = 'jump'; // the ball-turn needs the mascot's face layers
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

  window.PondMascot = { create, createImage, setMood, act, setPalette, resolvePalette, PALETTES, MOODS };
})();
