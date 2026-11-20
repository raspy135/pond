# Notes for AI assistants working on Pond

## Commits
- Author and committer: **Ryan** (`raspy135@users.noreply.github.com`) only.
- Do **not** add `Co-Authored-By`, `Claude-Session` or any other AI attribution lines to commit messages
  or pull request descriptions.

## Never commit
- `.env` and anything under `data/` — they hold the owner's keys, email and chats.

## Tests
- Never run anything that writes `.env` or `data/` against the real working folder. `scripts/setup.mjs`
  deletes and rewrites `.env`: test it on a temporary copy. Server tests use `OPEN_DOTS_DATA_DIR=<temp dir>`.
- `npm run check` (syntax) and `node test/agent-server.test.mjs` must pass.

## Prompt-cache rules (local model servers)
- The system prompt and the tool list must stay byte-identical across turns *and across chats*.
  No dates, times or per-user state in them — per-chat state goes into the first user message,
  later changes into `<context_update>` blocks in new messages.
- Large MCP tool sets are reached through the fixed `load_tools` / `use_tool` entries; never add or
  remove tool definitions based on what a chat is doing.

## Style
- Zero npm dependencies (Node 18+ built-ins only).
