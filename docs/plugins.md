# Pond plugins (API v1)

Plugins extend Pond without touching core files. A plugin can add agent tools, react to events,
show things in the UI, expose HTTP routes, and keep its own settings and storage.

```
plugins/
  my-plugin/
    plugin.json   # manifest
    index.mjs     # export function activate(api) { ... }
```

Drop the folder into `plugins/`, open **Agent Hub → Plugins**, press **Reload plugins**, and switch it on.
Edits to `index.mjs` are picked up by **Reload** — no server restart needed.

## plugin.json

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "What it does",
  "author": "you",
  "pondApi": 1,
  "enabledByDefault": false,
  "settings": [
    { "key": "apiKey", "label": "API key", "type": "password" },
    { "key": "limit", "label": "Limit", "type": "number", "default": 5 },
    { "key": "verbose", "label": "Verbose", "type": "boolean", "default": false }
  ]
}
```

`pondApi` is the plugin API version the plugin targets. Pond refuses to load plugins that need a newer API.

## The `api` object

Plugins only use `api` — never import from `lib/`. That is the compatibility contract: core internals
can change freely, `api` v1 stays stable.

| API | What it does |
|---|---|
| `api.on(event, fn)` | Subscribe to an event (see below). |
| `api.registerTool({ name, description, parameters, sideEffects, run })` | Add an agent tool, exposed as `plugin_<id>_<name>`. `run(args, ctx)` returns any JSON. `sideEffects: true` → Sentinel asks before each call (policy `plugin_tool`). |
| `api.registerRoute(method, subpath, fn)` | HTTP route at `/plugins/<id>/<subpath>`. `fn({ method, path, query, headers, body })` returns JSON, a string, or `{ status, body, headers }`. Useful for webhooks (e.g. Telegram/LINE). |
| `api.ui.statusItem(key, text)` | One line in the sidebar "Agent Status" area. `text = null` removes it. |
| `api.ui.messageFooter(requestId, text)` | One line under the reply of a chat turn. Saved with the message. |
| `api.ui.setPanel(markdown)` | Markdown shown under the plugin in Agent Hub → Plugins. |
| `api.settings.get(key)` / `.all()` | Values from the settings form generated from `plugin.json`. |
| `api.storage.get(key, fallback)` / `.set(key, value)` | Persistent JSON in `data/plugins/<id>/store.json`. |
| `api.notify({ title, body, urgency })` | Pond notification (in-app + Web Push). |
| `api.askAgent(prompt)` | Run a background agent turn with Pond's tools; returns the reply text. |
| `api.log(...)` | Console log prefixed with the plugin id. |
| `api.plugin` | `{ id, name, dir, dataDir }` |

## Events

| Event | Payload |
|---|---|
| `llm_response` | Every model call: `{ source, requestId, profile, model, promptTokens, completionTokens, reasoningTokens, cachedTokens, tokensEstimated, ttftMs, totalMs, genMs, prefixHash }`. `source` is `chat`, `proactive`, `job`, `task`, `subagent`, … `requestId` is set for chat turns (use it with `messageFooter`). `genMs`/`ttftMs` are `null` for non-streaming calls. |
| `chat_message` | `{ sessionId, role, content, requestId, source }` for user messages and final replies. |
| `notification` | Every Pond notification (email alerts, reminders, approvals, …). |
| `proactive_tick` | Start of each proactive heartbeat: `{ force, at }`. |
| `startup` | After all plugins loaded: `{ pluginCount }`. |

## Safety model

- Every hook, tool and route runs behind try/catch and a timeout (10 s for hooks, 120 s for tools).
- A plugin that throws 5 errors within 10 minutes is **auto-disabled** and you get a notification.
  Its tools, routes, handlers and UI items are removed; Pond keeps running.
- Plugin tools are added **after** core tools in a fixed order, so the cached prompt prefix of core stays stable.
- Plugins run **inside** the Pond process. This protects against *broken* plugins, not *malicious* ones:
  a plugin can read files or make network calls. Only install plugins you trust. For untrusted code,
  connect an MCP server instead (separate process).

## Example

See [`plugins/toks`](../plugins/toks) — tokens/second, TTFT and prompt-cache hit rate under each reply.
