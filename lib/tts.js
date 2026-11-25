// Google Cloud Text-to-Speech for reading replies aloud (optional; the browser's own voices are the default).
// The key stays on the server: the app posts text to /api/tts and gets MP3 back. Recent clips are cached in memory,
// so replaying a reply doesn't bill again.
import crypto from 'node:crypto';
import { CONFIG } from './config.js';

const API = process.env.GOOGLE_TTS_API_URL || 'https://texttospeech.googleapis.com/v1'; // overridable for tests
const cache = new Map(); // hash -> Buffer (most recent last)
const CACHE_MAX = 150;

export const googleTtsConfigured = () => Boolean(CONFIG.voice?.googleApiKey);

const langOf = (voice) => String(voice).split('-').slice(0, 2).join('-'); // "ja-JP-Chirp3-HD-Aoede" -> "ja-JP"

// text -> MP3 Buffer. lang: "ja" picks the Japanese voice, anything else the English one.
export async function synthesizeGoogle(text, { lang = 'en' } = {}) {
  if (!googleTtsConfigured()) throw new Error('Google Text-to-Speech is not set up (Agent Hub → Appearance → Voice).');
  const clean = String(text || '').trim().slice(0, 4500); // API limit is 5,000 bytes of input
  if (!clean) throw new Error('Nothing to read');
  const voice = /^ja/i.test(lang) ? CONFIG.voice.googleVoiceJa : CONFIG.voice.googleVoiceEn;
  const key = crypto.createHash('sha1').update(`${voice}\n${clean}`).digest('hex');
  if (cache.has(key)) { const b = cache.get(key); cache.delete(key); cache.set(key, b); return b; }
  const resp = await fetch(`${API}/text:synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': CONFIG.voice.googleApiKey },
    body: JSON.stringify({ input: { text: clean }, voice: { languageCode: langOf(voice), name: voice }, audioConfig: { audioEncoding: 'MP3' } }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.audioContent) throw new Error(`Google TTS ${resp.status}: ${data.error?.message || 'no audio returned'}`);
  const buf = Buffer.from(data.audioContent, 'base64');
  cache.set(key, buf);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return buf;
}

// Voices for the settings menu: Japanese and English, best kinds first.
export async function listGoogleVoices() {
  if (!googleTtsConfigured()) return { voices: [] };
  const resp = await fetch(`${API}/voices`, { headers: { 'X-Goog-Api-Key': CONFIG.voice.googleApiKey }, signal: AbortSignal.timeout(20_000) });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Google TTS ${resp.status}: ${data.error?.message || 'could not list voices'}`);
  const kind = (n) => (/Chirp3-HD/.test(n) ? 0 : /Chirp-HD/.test(n) ? 1 : /Studio/.test(n) ? 2 : /Neural2/.test(n) ? 3 : /Wavenet/i.test(n) ? 4 : 5);
  const voices = (data.voices || [])
    .filter((v) => (v.languageCodes || []).some((c) => /^(ja-JP|en-US|en-GB|en-AU)$/.test(c)))
    .map((v) => ({ name: v.name, lang: v.languageCodes[0], gender: v.ssmlGender || '' }))
    .sort((a, b) => a.lang.localeCompare(b.lang) || kind(a.name) - kind(b.name) || a.name.localeCompare(b.name));
  return { voices };
}
