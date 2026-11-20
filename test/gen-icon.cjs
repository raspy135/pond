// Generate the Pond ink-splash icon (SVG) — flat design, no gradients.
const fs = require('fs');

const cx = 256, cy = 256, R = 118;
const radii = [1.00, 0.74, 0.88, 0.68, 1.02, 0.78, 0.92, 0.70, 0.98, 0.80, 0.90, 0.76];
const pts = radii.map((r, i) => {
  const a = (i * 30 - 90) * (Math.PI / 180);
  return [cx + Math.cos(a) * R * r, cy + Math.sin(a) * R * r];
});

function smoothClosed(pts) {
  const n = pts.length;
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d + ' Z';
}
const blob = smoothClosed(pts);
const INK = '#8b5cf6';
const drops = [[150, 108, 17], [388, 148, 12], [398, 330, 20], [128, 330, 10], [268, 62, 9]];
const dropEls = drops.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${INK}"/>`).join('\n  ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#0f0f13"/>
  <path d="${blob}" fill="${INK}"/>
  ${dropEls}
</svg>
`;
fs.writeFileSync(require('node:path').join(__dirname, '..', 'public', 'icons', 'icon.svg'), svg);
console.log('icon.svg written (flat)');
