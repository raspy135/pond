// Pond voice: read replies aloud (text-to-speech) and dictate messages (speech-to-text).
// Reading aloud uses the browser's own voices, or Google Cloud Text-to-Speech when Pond has a key for it (much better
// on iPhone, whose built-in voices sound robotic). Dictation uses the browser's own speech recognition.
// Device settings (engine, voice, speed, auto-read) are kept in localStorage; the Google key lives on the server.
(function () {
  const synth = window.speechSynthesis || null;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const KEY = 'pond_voice';
  const defaults = { voice: '', rate: 1, autoRead: false, sttLang: '', engine: 'auto' }; // engine: auto | browser | google
  const load = () => { try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...defaults }; } };
  const settings = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ } };

  const JA = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;

  // Markdown → something worth hearing: no code, URLs or markup.
  function plainText(md) {
    return String(md || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\$\$[\s\S]*?\$\$/g, ' ')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+|www\.\S+/g, ' ')
      .replace(/(^|\s)\/(share|artifacts|html|apps|files)\/\S+/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
      .replace(/\|/g, ', ')
      .replace(/(\*\*|__|~~|\*|_)(\S[\s\S]*?\S|\S)\1/g, '$2')
      .replace(/\$([^$\n]+)\$/g, (_, t) => t.replace(/\\[a-zA-Z]+/g, ' ').replace(/[{}^_\\]/g, ' '))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  // Short pieces: long utterances stall in some browsers, and each piece can use the voice for its own language.
  function pieces(text) {
    const out = [];
    for (const para of text.split('\n')) {
      const sentences = para.match(/[^.!?。！？]+[.!?。！？]*[\s」』)]*/g) || [];
      let cur = '';
      for (const s of sentences) {
        if ((cur + s).length > 220 && cur) { out.push(cur.trim()); cur = ''; }
        if (s.length > 220) {
          for (const part of s.match(/.{1,200}(?:[,、，;；:\s]|$)|.{1,200}/g) || [s]) if (part.trim()) out.push(part.trim());
        } else cur += s;
      }
      if (cur.trim()) out.push(cur.trim());
    }
    return out.filter((p) => /[\p{L}\p{N}]/u.test(p));
  }

  const voices = () => (synth ? synth.getVoices() : []);
  const rank = (v) => (/natural/i.test(v.name) ? 0 : /online|neural|premium|enhanced/i.test(v.name) ? 1 : v.localService ? 3 : 2);
  function bestVoice(lang) {
    const base = lang.toLowerCase().split('-')[0];
    const list = voices().filter((v) => v.lang.toLowerCase().replace('_', '-').split('-')[0] === base);
    const exact = list.filter((v) => v.lang.toLowerCase().replace('_', '-') === lang.toLowerCase());
    return [...(exact.length ? exact : list)].sort((a, b) => rank(a) - rank(b))[0] || null;
  }
  function voiceFor(piece) {
    if (settings.voice) {
      const v = voices().find((x) => x.voiceURI === settings.voice);
      if (v) return v;
    }
    const lang = JA.test(piece) ? 'ja-JP' : (/^ja/i.test(navigator.language) ? 'en-US' : navigator.language || 'en-US');
    return bestVoice(lang) || bestVoice('en-US');
  }

  // ---------- Google Cloud voices (through Pond's /api/tts) ----------
  let google = false; // Pond has a Google key
  function refreshServer() {
    return fetch('/api/tts/status', { cache: 'no-store' }).then((r) => r.json()).then((d) => { google = Boolean(d.google); }).catch(() => {});
  }
  refreshServer();
  const useGoogle = () => google && settings.engine !== 'browser';
  // One audio element for all playback. iPhone only lets a page play sound after a tap, so the first tap anywhere
  // plays a moment of silence on it; after that, replies can be read aloud on their own too.
  const audio = typeof Audio !== 'undefined' ? new Audio() : null;
  if (audio) audio.preload = 'auto';
  function silentWav() {
    const n = 800, buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf);
    const w = (o, str) => { for (let k = 0; k < str.length; k++) d.setUint8(o + k, str.charCodeAt(k)); };
    w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true);
    d.setUint16(22, 1, true); d.setUint32(24, 16000, true); d.setUint32(28, 32000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
    w(36, 'data'); d.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  let unlocked = false;
  const unlock = () => {
    if (unlocked || !audio) return;
    unlocked = true;
    if (audio.src && !audio.paused) return;
    audio.src = silentWav();
    audio.play().catch(() => { unlocked = false; });
  };
  if (typeof document !== 'undefined') ['pointerdown', 'touchend', 'keydown'].forEach((ev) => document.addEventListener(ev, unlock, { capture: true, passive: true }));

  // Sentences grouped by language into requests of up to ~600 characters (fewer requests, more natural phrasing).
  function groups(list) {
    const out = [];
    for (const p of list) {
      const lang = JA.test(p) ? 'ja' : 'en';
      const last = out[out.length - 1];
      if (last && last.lang === lang && last.text.length + p.length < 600) last.text += ` ${p}`;
      else out.push({ lang, text: p });
    }
    return out;
  }
  const fetchClip = (g) => fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(g) })
    .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.blob(); });
  let playing = null; // resolves the clip that is playing when stopped
  function playClip(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const done = () => { audio.onended = audio.onerror = null; playing = null; URL.revokeObjectURL(url); resolve(); };
      playing = done;
      audio.onended = done;
      audio.onerror = done;
      audio.src = url;
      audio.playbackRate = Number(settings.rate) || 1;
      audio.play().catch((err) => { if (onError) onError(err?.name === 'NotAllowedError' ? 'Tap the speaker button to hear replies (this device blocks sound until you tap).' : String(err?.message || err)); done(); });
    });
  }
  let onError = null; // set by the app to show problems
  async function speakGoogle(list, id) {
    const gs = groups(list);
    let next = fetchClip(gs[0]);
    for (let k = 0; k < gs.length; k++) {
      if (id !== session) return;
      let blob;
      try { blob = await next; } catch (err) {
        if (id !== session) return;
        if (onError) onError(`Google voice failed (${String(err?.message || err).slice(0, 120)}) — using this device's voice.`);
        return speakBrowser(pieces(gs.slice(k).map((g) => g.text).join('\n')), id);
      }
      if (k + 1 < gs.length) next = fetchClip(gs[k + 1]); // fetch the next part while this one plays
      next.catch(() => {});
      if (id !== session) return;
      await playClip(blob);
    }
    finish(id);
  }

  let session = 0;
  let current = null; // { id, onEnd }
  function finish(id) {
    if (id !== session || !current) return;
    const c = current;
    current = null;
    if (c.onEnd) try { c.onEnd(); } catch { /* ignore */ }
  }
  function stop() {
    session++;
    const c = current;
    current = null;
    if (synth) synth.cancel();
    if (audio && !audio.paused) audio.pause();
    if (playing) playing();
    if (c?.onEnd) try { c.onEnd(); } catch { /* ignore */ }
  }
  // Read text aloud. Returns an id; onEnd runs when it finishes or is stopped.
  function speak(text, { onEnd = null } = {}) {
    if (!synth && !useGoogle()) return null;
    stop();
    const list = pieces(plainText(text));
    if (!list.length) { if (onEnd) onEnd(); return null; }
    const id = ++session;
    current = { id, onEnd };
    if (useGoogle() && audio) speakGoogle(list, id);
    else speakBrowser(list, id);
    return id;
  }
  function speakBrowser(list, id) {
    if (!synth) { finish(id); return; }
    let i = 0;
    const next = () => {
      if (id !== session) return;
      if (i >= list.length) { finish(id); return; }
      const piece = list[i++];
      const u = new SpeechSynthesisUtterance(piece);
      const v = voiceFor(piece);
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = Number(settings.rate) || 1;
      u.onend = next;
      u.onerror = (e) => { if (e.error === 'interrupted' || e.error === 'canceled') return; next(); };
      synth.speak(u);
    };
    next();
  }
  const speakingId = () => current?.id || null;

  // Dictation: live text into the message box. Returns a controller with stop(), or null if unsupported.
  function dictate({ onText, onEnd, onError } = {}) {
    if (!Recognition) return null;
    if (current) stop(); // don't transcribe Pond's own voice
    const rec = new Recognition();
    rec.lang = settings.sttLang || navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    let finalText = '';
    let stopped = false;
    rec.onresult = (e) => {
      let interim = '';
      for (let k = e.resultIndex; k < e.results.length; k++) {
        const r = e.results[k];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (onText) onText(finalText, interim);
    };
    rec.onerror = (e) => { if (onError && e.error !== 'aborted' && e.error !== 'no-speech') onError(e.error); };
    rec.onend = () => { if (!stopped && rec._keep) { try { rec.start(); return; } catch { /* fall through */ } } if (onEnd) onEnd(finalText); };
    rec._keep = true; // some browsers end after a pause; keep listening until the button is pressed again
    try { rec.start(); } catch (err) { if (onError) onError(String(err?.message || err)); return null; }
    return { stop() { stopped = true; rec._keep = false; try { rec.stop(); } catch { /* ignore */ } } };
  }

  window.PondVoice = {
    get ttsSupported() { return Boolean(synth) || google; },
    get googleReady() { return google; },
    refreshServer,
    setErrorHandler(fn) { onError = fn; },
    sttSupported: Boolean(Recognition),
    settings,
    save,
    voices,
    speak,
    stop,
    speakingId,
    dictate,
    plainText,
    onVoicesChanged(fn) { if (synth) synth.addEventListener?.('voiceschanged', fn); },
  };
})();
