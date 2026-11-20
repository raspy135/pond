// Web search (Tavily, DeepSeek native, keyless Bing), readable web fetch, RSS/Atom parser, and HTTP client.
import { CONFIG } from './config.js';

export const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

export function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export const stripTags = (s) =>
  decodeEntities(
    String(s)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();

// Tavily search API (https://docs.tavily.com) — 1 credit per basic search.
async function webSearchTavily(query, maxResults) {
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.search.tavilyApiKey}` },
    body: JSON.stringify({ query, max_results: maxResults, search_depth: CONFIG.search.tavilyDepth || 'basic', include_answer: false }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 200);
    throw new Error(`Tavily search failed (HTTP ${resp.status})${resp.status === 401 ? ': check the API key' : resp.status === 432 || resp.status === 433 ? ': plan / credit limit reached' : ''} ${detail}`.trim());
  }
  const data = await resp.json();
  return (data.results || []).slice(0, maxResults).map((r) => ({
    url: r.url,
    title: r.title,
    snippet: String(r.content || '').replace(/\s+/g, ' ').slice(0, 500),
    ...(r.published_date ? { published: r.published_date } : {}),
  }));
}

export function activeSearchBackend() {
  const b = CONFIG.search.backend;
  if (b !== 'auto') return b;
  if (CONFIG.search.tavilyApiKey) return 'tavily';
  if (CONFIG.search.deepseekApiKey) return 'deepseek';
  return 'bing';
}

async function webSearchDeepSeek(query, maxResults) {
  const { deepseekApiKey, deepseekBaseUrl, deepseekModel } = CONFIG.search;
  const resp = await fetch(`${deepseekBaseUrl}/messages`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'x-api-key': deepseekApiKey,
      authorization: `Bearer ${deepseekApiKey}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'user-agent': 'pond/0.2.0',
    },
    body: JSON.stringify({
      model: deepseekModel,
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      thinking: { type: 'disabled' },
    }),
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`DeepSeek search failed (HTTP ${resp.status}): ${detail}`);
  }
  const data = await resp.json();
  const blocks = data.content || [];
  const snippets = new Map();
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    for (const c of b.citations ?? []) {
      if (c.url && c.cited_text && !snippets.has(c.url)) snippets.set(c.url, c.cited_text);
    }
  }
  const seen = new Set();
  const sources = [];
  for (const b of blocks) {
    if (b.type !== 'web_search_tool_result') continue;
    for (const item of b.content ?? []) {
      if (item.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      sources.push({ url: item.url, title: item.title, snippet: snippets.get(item.url), publishedAt: item.page_age });
      if (sources.length >= maxResults) return sources;
    }
  }
  if (!sources.length) throw new Error('DeepSeek returned no web_search_tool_result blocks');
  return sources;
}

async function webSearchBing(query, maxResults) {
  const resp = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`, {
    headers: { 'User-Agent': WEB_UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Bing search failed (HTTP ${resp.status})`);
  const html = await resp.text();
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
  const out = [];
  for (const b of blocks) {
    const a = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    let url = decodeEntities(a[1]);
    try {
      const u = new URL(url);
      const enc = u.searchParams.get('u');
      if (enc && enc.startsWith('a1')) {
        const decoded = Buffer.from(enc.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        if (/^https?:\/\//.test(decoded)) url = decoded;
      }
    } catch { /* keep original */ }
    out.push({ url, title: stripTags(a[2]), snippet: p ? stripTags(p[1]) : undefined });
    if (out.length >= maxResults) break;
  }
  return out;
}

export async function webSearch(query, maxResults = 6) {
  const max = Math.max(1, Math.min(10, Number(maxResults) || 6));
  const backend = activeSearchBackend();
  try {
    if (backend === 'tavily') {
      if (!CONFIG.search.tavilyApiKey) throw new Error('Tavily is selected but no API key is set');
      return { backend, results: await webSearchTavily(query, max) };
    }
    if (backend === 'deepseek') return { backend, results: await webSearchDeepSeek(query, max) };
  } catch (err) {
    // Keyed backend failed (bad key, out of credits, outage) — fall back to keyless Bing so the agent can continue.
    return { backend: 'bing', fallbackFrom: backend, note: String(err?.message || err).slice(0, 200), results: await webSearchBing(query, max) };
  }
  return { backend: 'bing', results: await webSearchBing(query, max) };
}

export async function webFetch(url, maxChars = 8000) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs are supported');
  const resp = await fetch(parsed, {
    headers: { 'User-Agent': WEB_UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(18_000),
  });
  if (!resp.ok) throw new Error(`Fetch failed (HTTP ${resp.status})`);
  const contentType = resp.headers.get('content-type') || '';
  const raw = await resp.text();
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : undefined;
  const text = contentType.includes('json') || contentType.includes('text/plain') ? raw.trim() : stripTags(raw);
  return {
    url: resp.url || parsed.href,
    status: resp.status,
    contentType,
    ...(title ? { title } : {}),
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}

export function parseFeed(xml) {
  const items = [];
  const itemMatches = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const pick = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (!m) return '';
    return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
  };
  for (const block of itemMatches.slice(0, 25)) {
    const title = stripTags(pick(block, 'title'));
    let link = stripTags(pick(block, 'link'));
    if (!link) {
      const href = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (href) link = decodeEntities(href[1]);
    }
    const id = stripTags(pick(block, 'guid') || pick(block, 'id') || link || title);
    const pubDate = stripTags(pick(block, 'pubDate') || pick(block, 'published') || pick(block, 'updated'));
    const summary = stripTags(pick(block, 'description') || pick(block, 'summary') || pick(block, 'content')).slice(0, 350);
    if (title || link) items.push({ id, title, link, pubDate, summary });
  }
  return items;
}

export async function httpRequest({ url, method = 'GET', headers = {}, body = null, timeoutMs = 15_000 }) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs are supported');
  const m = String(method || 'GET').toUpperCase();
  const reqHeaders = { 'User-Agent': 'Pond-Agent/0.2', ...headers };
  let payload;
  if (body !== null && body !== undefined && m !== 'GET' && m !== 'HEAD') {
    if (typeof body === 'object') {
      payload = JSON.stringify(body);
      if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-type')) {
        reqHeaders['Content-Type'] = 'application/json';
      }
    } else {
      payload = String(body);
    }
  }
  const resp = await fetch(parsed, {
    method: m,
    headers: reqHeaders,
    body: payload,
    signal: AbortSignal.timeout(Math.min(30_000, Number(timeoutMs) || 15_000)),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* plain text */ }
  return {
    ok: resp.ok,
    status: resp.status,
    url: resp.url,
    contentType: resp.headers.get('content-type') || '',
    body: json ?? text.slice(0, 8000),
    truncated: !json && text.length > 8000,
  };
}
