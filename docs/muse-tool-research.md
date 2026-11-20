# Research: What tools can Meta Muse call?

*Compiled 2026-11-19 from public reporting (Meta announcements, DeepLearning.AI, TWiT, The Verge, TechNode, Parallel.ai). Muse is new and changes weekly — treat specifics as a snapshot.*

## TL;DR

Muse is not a fixed tool list — it's an agent with **three ways to reach tools**:
1. **Built-in connectors** (Meta-built, per-service, curated list)
2. **Custom connectors** (Muse writes its own integration code on its VM for any API/CLI/MCP server)
3. **A Chromium browser** on its cloud VM for sites with no API (driven by a dedicated browser sub-agent that reads the accessibility tree, not raw HTML)

Plus **artifacts** (it builds small apps/web pages/PDFs), **scheduled tasks**, **memory**, and **messaging** (WhatsApp/app/web). Every external action passes through a permission gate called **Sentinel**.

## 1. Built-in connectors (launch + later drops)

**Launch (Sep 8, 2026, US):**
- Gmail, Google Calendar, Google Workspace
- Instagram, Facebook, Threads (via Accounts Center)
- Ticketmaster, OpenTable, Spotify
- Apple Health, Function Health, Peloton
- Plaid (banking/financial data)

**Connect 2026 (Sep 24):** Notion, Granola, GitHub, Box + new shopping/travel partners.

**Muse for Small Business (Sep 29):** Slack, Asana, Dropbox, Canva, Figma, Stripe, and more.

**Singapore launch (Oct 30):** Shopee, Lazada, Grab, Singapore Airlines, Agoda, Klook, Trip.com, ShopBack — regional shopping/travel/delivery.

Third-party trackers list ~79 connectors and counting ([sprites.ai list](https://www.sprites.ai/muse/connectors)); Meta accepts connector submissions via the [Muse Connector Platform](https://platform.muse.ai/).

**Per-connector permissions:** read vs. write scopes are selectable per service; each connector also has its own approval policy.

## 2. What it actually *does* with them (observed tool behaviors)

From hands-on reports (TWiT, The Verge, Mashable):

| Domain | Example calls |
|---|---|
| **Email** | Read inbox, summarize, draft replies, send (with approval), build shopping lists from emails |
| **Calendar** | Read/create events, schedule recurring jobs ("Every Thursday 9am, send me the 3 biggest AI stories") |
| **Shopping** | Search/compare products across retailers, add to cart, place orders (Stripe Link one-time virtual cards; approval required), find deals/cashback |
| **Travel** | Search flights/hotels/activities, compare prices, build itineraries, book (approval required), respects constraints ("within 2h drive, under $200") |
| **Food/dining** | Find restaurants by cuisine/hours/dietary needs, reservations via OpenTable |
| **Smart home / car** | Apple Health, Peloton, car and smart-home control (read/write per connector) |
| **Files/docs** | Create PDFs, web pages, dashboards, spreadsheets ("artifacts") saved to a Library; edit them later |
| **Media** | Generate images, two-host podcasts from a script, persona/voice changes |
| **Memory** | Persistent long-term memory across one long-running conversation; readable/editable/forgettable by the user; used proactively (e.g., remembered gluten-free preference without being asked) |
| **Scheduling** | Recurring/cron-style tasks that run while the app is closed; event-triggered background work |
| **Web** | Browser automation for sites without APIs; research + synthesis with links |
| **Code/apps** | Builds small web apps on demand (water-tracker example), runs them on its VM, iterates with sub-agents |

## 3. The tool-calling architecture (why it's safe-ish)

- **Secure VM per user** ("Muse Secure VM"): isolated Linux box with browser, storage, CPU/RAM. Agent lives there; credentials do not.
- **Two-zone design**: agent + tools in a "runtime cell"; credentials and Sentinel live outside it. Agent never sees real secrets — it gets surrogate tokens; the real credential is swapped in at the network boundary.
- **Sentinel** — a separate agent/gatekeeper that approves or denies every outbound request and every connector call against user-set permissions. Cannot be disabled by the agent. Approval prompts arrive as **system dialogs, not chat messages** (so prompt injection can't fake approval). Approvals can be scoped: one action / session / task / time window / forever.
- **Always-approve actions**: sending email, purchases. Purchases use single-use Stripe Link virtual cards (merchant + amount + time-boxed).
- **Browser sub-agent** reads the accessibility tree (like a screen reader), not page source/JS — injection-resistant by design; classifier ensemble screens all tool outputs; untrusted content is labeled.
- **Custom connectors**: ask Muse in chat — it writes the integration itself (OpenAPI/MCP/CLI), tests it, stores credentials in the Secure Credentials Store, and saves it as a reusable **skill**. Custom connectors are NOT reviewed by Meta.
- **MCP**: no one-click MCP setting in the app; Muse builds an MCP client on its VM over streamable HTTP (or stdio via npm/pip), stores it as a skill. Muse *Code* (terminal agent) supports MCP natively via `~/.config/muse/settings.json` (`"schema_version": 1`, `muse mcp login`).
- **No public API for the consumer agent itself.** The model behind it (Muse Spark) is exposed via the Meta Model API (OpenAI/Anthropic-compatible), but the agent runtime is not.

## 4. Muse vs. what Pond has today

| Capability | Muse | Pond (this repo) |
|---|---|---|
| Chat + streaming | ✅ | ✅ |
| Long-term memory | ✅ auto, cross-session | ✅ (`remember`/`recall_memory`) |
| Reminders | ✅ | ✅ (`set_reminder`) |
| Background/scheduled tasks | ✅ cron-style, survives app close | ⚠️ partial — `create_task` tracks tasks but doesn't *execute* them on a schedule |
| Proactive check-ins | ✅ | ✅ (SSE + LLM-gated) |
| Web browsing | ✅ browser sub-agent | ❌ |
| Email/calendar/shopping connectors | ✅ 79+ connectors | ❌ |
| Artifacts (PDFs, web apps) | ✅ | ❌ |
| MCP support | ✅ (via custom connectors / Muse Code) | ❌ (planned) |
| Approval gates / sandboxing | ✅ Sentinel VM | ❌ (tools are ungated) |
| Payments | ✅ Stripe Link one-time cards | ❌ |

## 5. Practical takeaways for Pond

1. **Biggest gap = execution, not chat.** Muse's value is doing things while you're away: scheduled jobs that actually run. Pond's `create_task` records intent but nothing executes it — a scheduler that *runs* tasks (with approval gates for side effects) is the highest-leverage next step.
2. **Connector architecture > tool sprawl.** Muse doesn't hardcode 79 integrations; it has (a) a few first-party connectors, (b) a generic "build your own connector from API/MCP/CLI" path, (c) a browser fallback. Pond should copy that shape: an MCP client + a generic `http_request`/`web_fetch` tool + per-tool approval settings beats 79 bespoke tools.
3. **Approval UX matters more than capability.** Muse's differentiator is Sentinel: every side-effecting action gets an out-of-band approval. Pond needs the same: a pending-actions queue with approve/deny in the UI, separate from chat.
4. **Artifacts are cheap and high-impact.** Letting Pond emit self-contained HTML/Markdown "artifacts" saved to disk covers 80% of Muse's "build me a tracker/PDF" demos.
5. **Memory should be inspectable.** Muse's memory is readable/editable/deletable — Pond already has this via sidebar + `/api/memory`. Good.
6. **Recurring jobs**: "every Thursday 9am, send me…" is Muse's killer demo. Pond needs a cron-like `schedule_task` tool + a runner that fires the agent with the task prompt.

## Sources

- Meta — [Introducing Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
- DeepLearning.AI — [How to Secure Agents for the Masses (Muse architecture deep-dive)](https://charonhub.deeplearning.ai/how-to-secure-agents-for-the-masses/)
- TWiT — [What Is an AI Agent? Putting Meta's Muse to Work](https://twit.tv/posts/tech/what-ai-agent-putting-metas-muse-work)
- The Verge — [Meta's AI agent is a cute little guy who's great at spending my money](https://www.theverge.com/ai-artificial-intelligence/999526/meta-muse-ai-agent-hands-on-shopping)
- Parallel — [How to create custom integrations with Meta Muse (connectors, MCP, skills)](https://parallel.ai/articles/meta-muse-custom-integrations.md)
- TechNode — [Muse launches in Singapore with local connectors](https://technode.global/2026/10/30/meta-muse-ai-agent-singapore-connectors/)
- Mashable — [Meta unveils Muse](https://me.mashable.com/tech/75962/meta-unveils-muse-new-personal-ai-agent-app-built-to-execute-complex-daily-tasks)
- Sprites.ai — [Muse connector list (~79)](https://www.sprites.ai/muse/connectors)
- Mashable — [Muse Connect 2026 announcements](https://me.mashable.com/tech/76439/meta-gets-metaphysical-laying-out-vision-for-muse-ai-assistant)
