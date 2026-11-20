---
name: dashboard
description: Build a dashboard / report / data view in Pond's own clean light-dark design language with consistent charts and tasteful animation. Use for any dashboard, KPI view, stats page, chart, or "show me my …" overview.
builtin: true
---

# Pond dashboard

Every dashboard Pond makes should look like it belongs to the same product: calm, clean, modern, in Pond's
own light/dark design tokens, with the same charts and the same motion. Consistency matters more than novelty.

## Steps

1. **Get real data first.** Use tools (check_emails, list_events, list_tasks, web_fetch, run_python, MCP…) to
   collect the actual numbers. Never invent figures. If something is unavailable, say so in the card (e.g. "—")
   or clearly label a section "sample data".
2. **Load the template:** `read_skill_file("dashboard", "template.html")`. Keep its `<style>` tokens and the
   `PondCharts` script **unchanged** — only replace the header, cards and the example data calls at the bottom.
3. **Lay it out** (see rules below), fill in the data, and output the whole page as one fenced ```html block.
   Keep the first line `<!-- height: N -->` and set N to fit the content (typically 520–900).
4. If the user wants to keep it, also call `save_artifact(title, from_html_id)` with the id shown on the preview
   (or reuse later via `list_recent_html` / `read_recent_html`).

## Layout

- Header: title (`h1`), one muted sub-line ("Updated 9:41 · source"), optional `.live` dot and one status `.pill`.
- Row 1: 2–4 **KPI cards** (`.card.kpi`): label, big number with `data-count` (count-up), delta line
  (`.up` ▲ / `.down` ▼ / `.flat` —) with the comparison period, optional sparkline `svg.spark[data-spark]`.
- Then charts: the main trend as `.span-2`, supporting charts and a short table beside or below.
- 6–8 cards total is plenty. One idea per card. Card titles are short nouns ("Revenue", "Inbox by sender").
- Use `.span-all` only for wide tables or timelines.

## Charts — pick the simplest that answers the question

| Question | Chart | Call |
|---|---|---|
| How does it change over time? | line (area for one series) | `PondCharts.line(el, { labels, series, area })` |
| How do categories compare? | vertical bars (≤ 12) | `PondCharts.bar(el, { labels, values })` |
| Long labels / ranking | horizontal bars | `PondCharts.bar(el, { labels, values, horizontal: true })` |
| Several series per category | grouped bars (≤ 3 series) | `PondCharts.bar(el, { labels, series })` |
| Parts of a whole | donut (≤ 6 slices, group the rest as "Other") | `PondCharts.donut(el, { items, center })` |
| Quick trend inside a KPI | sparkline | `<svg class="spark" data-spark="1,2,3" data-color="--c2">` |
| Exact values | `table.t` with `.num` cells | — |

Rules: no pie charts, no 3D bars, no dual y-axes, no rainbow palettes. Colors come only from `--c1…--c6`
(accent first); one color per series, the same series keeps the same color across cards. Horizontal gridlines
only, faint. Numbers use tabular figures and short formats (12.5k, 3.4s, 96%). Always say what a delta compares to.

## three.js — only when the data is genuinely 3D

Use 3D only for inherently spatial data: surfaces z = f(x, y), point clouds, terrain/elevation, a globe with
locations, room/floor layouts, molecular or network structures in space — or when the user asks for 3D.
Everything else stays 2D (clearer, faster). Put the scene inside a normal card so it matches the rest:

```html
<div class="card span-2"><h2>Elevation</h2><div id="scene" style="height:260px"></div></div>
<script type="module">
  import * as THREE from 'three';                                   // served by Pond (works offline)
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  const el = document.getElementById('scene'), css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });   // transparent: card background shows
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(el.clientWidth, el.clientHeight); el.appendChild(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, .1, 100);
  camera.position.set(4, 3.2, 5); const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
  controls.autoRotate = true; controls.autoRotateSpeed = .8;                    // gentle motion, stops when the user drags
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.4));
  const mat = new THREE.MeshStandardMaterial({ color: css('--c1'), flatShading: true, roughness: .8 });
  // …build geometry from the real data with mat; use css('--c2') etc. for more series; grid: new THREE.GridHelper(6, 12, css('--border'), css('--grid'))
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  addEventListener('resize', () => { renderer.setSize(el.clientWidth, el.clientHeight); camera.aspect = el.clientWidth / el.clientHeight; camera.updateProjectionMatrix(); });
</script>
```

Available addons: OrbitControls, RoomEnvironment, BufferGeometryUtils, ImprovedNoise, RoundedBoxGeometry.
For a standalone 3D answer (no dashboard around it), use a ```threejs block instead.

## Motion — always on, always tasteful

The template already animates: cards rise in with a stagger, KPI numbers count up (`data-count`), lines draw
themselves, bars grow from the baseline, the donut sweeps in, sparklines draw, the `.live` dot pulses and
cards lift on hover. Keep all of that, and:

- Prefer the built-in motion over custom effects. If you add any, use `transform`/`opacity` only, 0.3–1.2 s,
  ease-out curves, and run entrance effects once (not on every resize).
- Never animate continuously in a way that distracts from reading (no blinking, bouncing numbers or spinning
  charts). Gentle loops are fine for "live" indicators and 3D auto-rotate.
- Respect `prefers-reduced-motion` (the template's CSS already disables motion for those users).

## Writing

- Lead with the takeaway in the sub-line or a short card text ("Inbox is calm: 2 emails need a reply").
- Plain words, sentence case, no exclamation marks, no emoji in titles.
- After the ```html block, add 1–2 sentences: what stands out and anything that needs the user's action.
