# seekdeep

Flame graphs for coding-agent sessions.

`seekdeep` reads the JSONL transcripts that agent tools already write to disk —
**Claude Code**, **lci**, **Codex** — and turns a session into a flame graph
you can dig into: where the wall-clock went, what each model call cost, how
the prompt cache behaved turn by turn, and which tools dominated.

It is a static site. Nothing leaves your machine: open the published page,
drop a `.jsonl` file (or a whole session directory) onto it, and the parse and
render happen entirely in your browser.

## What you get

- **Flame graph** of the session: prompts → assistant turns → tool calls,
  nested by parent/child (subagents, sidechains) and sized by duration. Hover
  for tokens, cache reads/writes, cost, and latency; click to zoom.
- **Timeline** view: the same spans laid out against wall-clock time so gaps
  (waiting on the user, rate-limit stalls, long tool runs) are obvious.
- **Cache trace**: per-model-call cache read vs. cache write vs. uncached
  input, so you can see the exact turn where the prefix went cold.
- **Cost breakdown**: estimated spend per turn, per tool, per model, computed
  from a pricing table you can edit in the UI.
- **Session summary**: total wall time, model time vs. tool time vs. idle,
  token totals, hit rate, cost, slowest spans, most-called tools.

## Supported formats

| Tool        | Where the files live                                          | What we read                                                                                |
| ----------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/projects/<slug>/<session-id>.jsonl`                | `assistant` / `user` records, `message.usage` (cache read/create, ephemeral 5m/1h), `tool_use` / `tool_result`, `parentUuid`, `isSidechain`, `timestamp` |
| lci         | `<repo>/.lci/sessions/<id>/transcript.jsonl`                  | `event` records: `inference` (prompt/cache/completion tokens, `latencyMs`, model, provider), `tool-call` / `tool-result` (`durationMs`, `failed`), `iteration-start`, `loop-start`, `run-summary` |
| Codex       | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`                | `session_meta`, `turn_context`, `event_msg` (`task_started`, `task_complete`, `token_count`), `response_item` (`message`, `function_call`, `function_call_output`) |

Format is auto-detected from the first few records. Unknown files fall back
to a generic parser that looks for `timestamp` + `usage`-shaped objects.

## Using it

Hosted: **https://a1re1.github.io/seekdeep/** — open it, then drag a
transcript onto the page or use the file picker. Files are read with the
browser File API and never uploaded.

Locally:

```sh
bun install
bun run dev        # serve with live reload
bun run build      # emit static site into dist/
bun run test
```

## Design notes

- **Bun-only toolchain.** `bun build` bundles the TypeScript app; there is no
  webpack/vite layer. The output in `dist/` is plain HTML/JS/CSS and is what
  GitHub Pages serves.
- **Parsers are pure.** Each format has a parser in `src/parsers/` that maps
  raw JSONL records to a common `Span` tree (`src/model.ts`). The renderer
  never sees format-specific fields, so adding a new agent tool is one file.
- **Costs are estimates.** Pricing comes from `src/pricing.ts` (per-model
  input / output / cache-read / cache-write rates). Edit it in the UI if your
  rates differ; the table is stored in `localStorage`.
- **Large files.** Transcripts run to hundreds of MB. Parsing streams line by
  line and skips content bodies it doesn't need (thinking text, tool output),
  keeping only what the graph displays.

## Status

Early. The parsers track the transcript shapes emitted by the tool versions
we run day to day; when a tool changes its schema, open an issue with a
(redacted) sample record.

## License

MIT
