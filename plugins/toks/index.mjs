// Example Pond plugin: tokens/second under each reply.
// Uses only the public plugin API: api.on('llm_response'), api.ui.messageFooter / statusItem / setPanel, api.settings.

export function activate(api) {
  const turns = new Map(); // requestId -> aggregate over all model calls in one chat turn (tool rounds included)
  const recent = [];       // last 20 measured calls for the sidebar average

  const fmtS = (ms) => (ms == null ? '?' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

  api.on('llm_response', (r) => {
    const isChat = r.source === 'chat';
    if (!isChat && !api.settings.get('includeBackground')) return;
    if (r.genMs == null || !r.completionTokens) return; // non-streaming calls have no generation timing

    recent.push({ tokens: r.completionTokens, genMs: r.genMs });
    if (recent.length > 20) recent.shift();

    if (isChat && r.requestId) {
      const t = turns.get(r.requestId) || { tokens: 0, genMs: 0, ttftMs: r.ttftMs, calls: 0, estimated: false };
      t.tokens += r.completionTokens;
      t.genMs += r.genMs;
      t.calls += 1;
      t.estimated ||= r.tokensEstimated;
      t.cache = r.cachedTokens != null && r.promptTokens ? Math.round((100 * r.cachedTokens) / r.promptTokens) : null;
      turns.set(r.requestId, t);
      if (turns.size > 100) turns.delete(turns.keys().next().value);

      const parts = [
        `${t.estimated ? '~' : ''}${(t.tokens / (t.genMs / 1000)).toFixed(1)} tok/s`,
        `TTFT ${fmtS(t.ttftMs)}`,
        `${t.tokens} tok${t.calls > 1 ? ` · ${t.calls} calls` : ''}`,
      ];
      if (api.settings.get('showCache') && t.cache != null) parts.push(`cache ${t.cache}%`);
      api.ui.messageFooter(r.requestId, parts.join(' · '));
    }

    if (api.settings.get('showStatus')) {
      const tok = recent.reduce((a, x) => a + x.tokens, 0);
      const sec = recent.reduce((a, x) => a + x.genMs, 0) / 1000;
      api.ui.statusItem('avg', `⚡ ${(tok / sec).toFixed(1)} tok/s avg (${r.model})`);
    }
    api.ui.setPanel(`Last call: **${r.completionTokens}** tokens in ${fmtS(r.genMs)} after TTFT ${fmtS(r.ttftMs)}` +
      (r.cachedTokens != null ? ` · cached prompt ${r.cachedTokens}/${r.promptTokens}` : ' · (server did not report cache stats)') +
      (r.tokensEstimated ? '\n\n_Token counts are estimated — the model server did not return usage._' : ''));
  });
}

export function deactivate() {
  // Nothing to clean up: Pond removes this plugin's handlers and UI items automatically.
}
