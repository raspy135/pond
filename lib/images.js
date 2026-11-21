// Images the AI can look at: image files read with read_file, and screenshots that tools return (browser, Blender…).
// They are copied under data/python-runs/<id>/ (served at /files/...) and handed to the model as an image message
// right after the tool results, when the active model accepts images.
import { mkdir, writeFile, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PYTHON_RUNS_DIR, runPythonCode, detectPython } from './python.js';
import { uid } from './storage.js';

export const IMAGE_EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export const isImagePath = (p) => Boolean(IMAGE_EXT_MIME[path.extname(String(p || '')).toLowerCase()]);
const MAX_SEND_BYTES = 8 * 1024 * 1024;
const SHRINK_ABOVE_BYTES = 1_200_000; // big photos → shrink to 1600px so the model reads them quickly

// /files/<run>/<name> → path under python-runs (images the AI made itself, e.g. charts)
export function runFileFromUrl(p) {
  const m = String(p || '').match(/^\/?files\/([A-Za-z0-9_-]+)\/([^/\\]+)$/);
  if (!m) return null;
  const full = path.resolve(PYTHON_RUNS_DIR, m[1], decodeURIComponent(m[2]));
  return full.startsWith(PYTHON_RUNS_DIR + path.sep) ? full : null;
}

// Copy (and shrink if large) an image file into python-runs so the model can be shown it. → { url, file, mime, name }
export async function stageImageForModel(srcPath) {
  const ext = path.extname(srcPath).toLowerCase();
  const mime = IMAGE_EXT_MIME[ext];
  if (!mime) throw new Error('Not an image (png, jpg, webp, gif).');
  const st = await stat(srcPath);
  const runId = `view-${uid()}`;
  const dir = path.join(PYTHON_RUNS_DIR, runId);
  await mkdir(dir, { recursive: true });
  const base = path.basename(srcPath).replace(/[^A-Za-z0-9_.-]/g, '_').slice(-80) || `image${ext}`;
  if (st.size > SHRINK_ABOVE_BYTES && ext !== '.gif' && (await detectPython())) {
    const out = path.join(dir, base.replace(/\.[^.]+$/, '.jpg'));
    const r = await runPythonCode({
      code: [
        'from PIL import Image',
        `im = Image.open(${JSON.stringify(srcPath)})`,
        'im.thumbnail((1600, 1600))',
        "im = im.convert('RGB')",
        `im.save(${JSON.stringify(out)}, 'JPEG', quality=85)`,
      ].join('\n'),
      timeoutSec: 30,
    }).catch(() => null);
    if (r?.ok) return { url: `/files/${runId}/${encodeURIComponent(path.basename(out))}`, file: `${runId}/${path.basename(out)}`, mime: 'image/jpeg', name: path.basename(srcPath) };
  }
  if (st.size > MAX_SEND_BYTES) throw new Error(`Image too large to view (${Math.round(st.size / 1e6)} MB).`);
  await copyFile(srcPath, path.join(dir, base));
  return { url: `/files/${runId}/${encodeURIComponent(base)}`, file: `${runId}/${base}`, mime, name: path.basename(srcPath) };
}

// Base64 image from an MCP tool → saved file entry.
export async function saveToolImage(b64, mimeType = 'image/png', i = 0) {
  const ext = String(mimeType).includes('jpeg') ? '.jpg' : String(mimeType).includes('webp') ? '.webp' : '.png';
  const runId = `mcp-${uid()}`;
  const name = `screenshot-${i + 1}${ext}`;
  const dir = path.join(PYTHON_RUNS_DIR, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), Buffer.from(b64, 'base64'));
  return { url: `/files/${runId}/${name}`, file: `${runId}/${name}`, mime: IMAGE_EXT_MIME[ext], name };
}

// Tool results carry images as result.__images; pull them out so the text result stays small.
export function takeImages(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.__images) || !result.__images.length) return { result, images: [] };
  const { __images, ...rest } = result;
  return { result: rest, images: __images.slice(0, 4) };
}
