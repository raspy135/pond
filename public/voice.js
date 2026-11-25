// Pond voice: read replies aloud (text-to-speech) and dictate messages (speech-to-text) with the browser's own speech
// engines — no server needed. Settings are per device (voices differ between devices), kept in localStorage.
// Edge on Windows has good neural voices ("… Online (Natural)"); its dictation, like Chrome's, runs on the browser
// maker's online speech service. A self-hosted Whisper/TTS server can be added later behind the same functions.
(function () {
  const synth = window.speechSynthesis || null;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const KEY = 'pond_voice';
  const defaults = { voice: '', rate: 1, autoRead: false, sttLang: '' };
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

  let session = 0;
  let current = null; // { id, onEnd }
  function stop() {
    session++;
    const c = current;
    current = null;
    if (synth) synth.cancel();
    if (c?.onEnd) try { c.onEnd(); } catch { /* ignore */ }
  }
  // Read text aloud. Returns an id; onEnd runs when it finishes or is stopped.
  function speak(text, { onEnd = null } = {}) {
    if (!synth) return null;
    stop();
    const list = pieces(plainText(text));
    if (!list.length) { if (onEnd) onEnd(); return null; }
    const id = ++session;
    current = { id, onEnd };
    let i = 0;
    const next = () => {
      if (id !== session) return;
      if (i >= list.length) { const c = current; current = null; if (c?.onEnd) c.onEnd(); return; }
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
    return id;
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
    ttsSupported: Boolean(synth),
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
