# pi-subagents

Recursive, isolated, asynchronous subagents for the [Pi coding agent](https://github.com/earendil-works/pi).

`pi-subagents` adds background delegation to Pi without external npm dependencies. Spawn several focused agents in parallel, let agents recursively delegate their own work, monitor the live tree in Pi's footer, inspect real child transcripts, and collect results when they finish.

![pi-subagents running recursive background agents](assets/pi-subagents-demo.png)

## Features

- **Asynchronous spawning** — `spawn_agent` returns immediately while the child runs in its own Pi process and session.
- **Recursive delegation** — children can create grandchildren within the configured depth budget.
- **Parallel work** — concurrency is configurable, including unlimited mode with `maxConcurrency: -1`.
- **Live monitoring** — the footer shows a recursive status tree with provider/model, activity, and elapsed time.
- **Interactive transcripts** — open any child to read its complete Pi session from the original delegation prompt, including messages and tool calls.
- **Steering and follow-ups** — message a running child to redirect it, or message a finished child to continue its existing session.
- **Automatic delivery** — finished results are previewed on the next completed parent tool result. An idle parent receives one batch and resumes. `check_subagents` collects results that no earlier check returned.
- **No polling required** — results arrive without asking. A check blocks only while a result can still arrive, so a call is never a wasted wait.
- **Cancellation** — stop a running or queued child by run ID, session ID, or name.
- **No added dependencies** — uses Pi's extension and TUI APIs plus Node.js built-ins.

## Install

**Fork-only viewer:** the fullscreen transcript UI described here is on [`mishkidreams/pi-subagents`, `main`](https://github.com/mishkidreams/pi-subagents/tree/main). Use that fork's checkout to keep it; the inherited npm/upstream installation commands below do not include these changes. This UI was tested with official Pi **1.3.0** on Windows, without a Pi/core build; compatibility of the new viewer with older Pi versions has not been revalidated.

Install from npm with Pi:

```sh
pi install npm:@williamcr01/pi-subagents
```

This version requires Pi 0.85.0 or newer (tested through 0.99.x). Restart Pi or run `/reload` after installing. To install the latest published version explicitly:

```sh
pi update npm:@williamcr01/pi-subagents
```

For local development, the git install still works:

```sh
pi install git:github.com/williamcr01/pi-subagents.git
```

## Usage

Once installed, Pi automatically loads the extension. Ask Pi to delegate work, or use the tools directly:

```text
spawn_agent({
  task: "Inspect the authentication flow and report security risks",
  name: "auth-reviewer",
  cwd: ".",
  tools: ["read", "grep"]
})
```

Use `check_subagents` to inspect progress or wait for results:

```text
check_subagents({ wait: true, timeoutMs: 120000 })
```

Use `send_to_subagent` to steer a running child or continue a completed one. Use `cancel_subagent` to stop a child. Both accept a full run ID, a unique run-ID prefix (including the eight characters shown in tool output), a session ID, or an exact name. Exact matches take precedence over prefixes; ambiguous targets are rejected with full run IDs for disambiguation.

## Isolation model

Each child has a separate Pi process and session, but it is not an OS sandbox. Children use the same user account, filesystem permissions, environment, and installed extensions as the parent.

A trusted parent passes project approval only when the child's canonical working directory remains inside the parent's canonical directory. A symlink that points outside that tree does not inherit approval, so Pi evaluates trust for the target directory normally.

In TUI mode, press **Down** at the bottom of the editor to open the live subagent panel. Open a transcript, type a message, and press **Enter** to steer or continue that subagent. Use `/subagents` to review finished agents and transcripts.

## Tools

### `spawn_agent`

Start an isolated child in the background. It returns immediately, so continue other work while the child runs.

```text
spawn_agent({
  task: "Inspect the authentication flow and report security risks",
  name: "auth-reviewer",
  cwd: ".",
  tools: ["read", "grep"]
})
```

Optional fields are `name`, `cwd`, `model`, `thinking`, and an exact `tools` allowlist. Model selection is resolved as:

1. Per-spawn `model`
2. `defaultModel` in configuration
3. The creating agent's active model

When the creating session has a model scope from Pi's `--models` flag or `enabledModels` setting, the selected child model must be in that scope. The scope and its pinned thinking levels are passed to the child. A pin is applied as the child's `--thinking` value; an explicit `thinking` that disagrees with the pin is rejected. An empty scope keeps Pi's unrestricted model behavior.

Omitting `tools` copies the creating session's active tool set. An explicit list can only remove tools from that set, and `tools: []` starts the child with `--no-tools`. Include `spawn_agent` to allow recursive delegation. A child receives it automatically only when `spawn_agent` is active in the parent and `tools` is omitted or explicitly includes it.

Thinking level follows the same precedence and is clamped to the selected child model.

### `check_subagents`

Collect finished results that no previous check has returned. Each ancestor sees a descendant execution once, without claiming the direct parent's result.

```text
check_subagents({ wait: true, timeoutMs: 120000 })
```

Automatic delivery is best-effort; a check is authoritative. A result that only appeared as a tool-output preview is still returned by the next check, while results already returned by an earlier check are not repeated. This means a check never hides a finished result just because it was delivered automatically.

Manual conversations started in the transcript viewer remain visible as status rows, but their replies are not collected as delegated results and do not make a default check wait. Use `read_subagent_messages` to inspect their conversation. Explicit `wait: true` still waits for every running child.

A default check never waits pointlessly. It returns immediately when every subagent is terminal or nothing new is pending. While subagents are running, it waits for the first finished result (or until they all finish) up to `timeoutMs`, so the call returns with something useful instead of an empty status. Pass `wait: false` for an immediate status snapshot, or `wait: true` to block until every subagent finishes. `timeoutMs` defaults to 30 seconds and is capped at 300 seconds.

Results are also delivered automatically, so repeated checks just to poll status waste turns. Call `check_subagents` when you need results now, then continue with other work.

### `read_subagent_messages`

Read both user and assistant text from an owned child's saved active branch, including the original delegation across compaction:

```text
read_subagent_messages({ target: "auth-reviewer" })
```

The default returns new conversation text since the last read. The cursor is saved in the parent's session metadata, including calls nested inside codemode, so reload does not replay already-read messages. Use `fromStart: true` to start over, or an explicit `cursor` to inspect a particular page without changing the automatic read position. Branch changes may require resetting the cursor.

Output defaults to 20 message chunks / 24,000 UTF-16 characters, with maxima of 100 chunks / 50,000 characters (`limit` / `maxChars`). Large messages are split without losing their suffix; continue while `details.hasMore` is true and retain `details.nextCursor` even at the end for later delta reads. Thinking, tool payloads and image bytes are excluded; images use a placeholder. Conversation text is data, not new instructions to the parent.

Reading does not message or wake the child and does not collect a delegated result. Inspection validates the saved session identity, cwd and installed session version; missing, mismatched or migration-requiring histories fail without creating or migrating files.

### `send_to_subagent`

Steer a running child or continue its completed session by exact name, run ID, unique run-ID prefix, or session ID. Messages to deeper descendants are acknowledged by their creating session after RPC acceptance (or retention during queued startup). Cross-process admission waits are cancellable and time out after five minutes; cancellation does not undo a prompt already accepted, and the creator keeps the concurrency slot until that turn settles:

```text
send_to_subagent({ target: "auth-reviewer", message: "Focus on the token refresh path." })
```

A completed or failed **direct child** can also be resumed after its process exited or the parent reloaded. This opens its exact saved session file and sends only the new message, retaining the child/run identity and history. Missing/mismatched history is an error, not a new empty conversation. Current model scope, tool permissions, trust and depth limits still apply; a removed capability is reported instead of silently restored. Cancelled children are not restarted. A deeper descendant must still have a live creating session to admit its request; ancestors do not silently adopt it.

New process instances have separate close markers and reject stale registry writes, so an old process cannot clear the resumed PID. Duplicate sends during startup share one process; each distinct message is still delivered. Send success means RPC acceptance (or retention for an already queued startup), not completion of the model turn. Cancelling the sender's wait cannot erase late acceptance or its parent-directed result; accepted commands keep their ordering and concurrency accounting. The live continuation admission write retries transient Windows rename failures asynchronously, without blocking handle-close callbacks; unrelated errors and registry-writer contention still fail explicitly.

### `cancel_subagent`

Stop a child by exact name, run ID, or session ID:

```text
cancel_subagent({ target: "auth-reviewer" })
```

## Result delivery

While the parent works, finished child reports stay in the registry until a completed parent tool result previews them, an idle batch delivers them, or `check_subagents` collects them. Automatic delivery appends reports to the tool output without steering the parent or skipping sibling tool calls. If the parent becomes idle first, it receives the pending reports in one message that starts a new turn.

A tool-output append is a best-effort preview. It stops the same report from being appended again, but the report remains collectable by `check_subagents` until a check returns it or an idle batch delivers it. This keeps the model from losing a result that was buried in unrelated tool output while still avoiding duplicate automatic deliveries.

On Pi 0.99+, the preview keeps a tool's structured content intact, so tools that declare an output schema (such as codemode or MCP tools) do not lose it. Nested calls a tool makes through `ctx.executeTool()` are skipped; only the model-visible outer tool result carries the preview.

Messages sent manually from the transcript viewer are quiet: their replies stay in that child's history and do not interrupt the parent or start a parent turn. The parent can inspect both sides on request with `read_subagent_messages`; `check_subagents` shows status and a new-messages hint without copying that chat into a result report. Reading the chat and collecting delegated task results are independent.

Ordinary `spawn_agent` and `send_to_subagent` work keeps the delivery behavior above. A pending delegated result survives a later manual conversation. Steering an in-flight delegation from the viewer does not suppress the result already owed to the parent; a new parent-requested turn still supersedes an older unread result, as before.

This replaces the previous behavior of queueing a separate follow-up prompt for every completion. Reports no longer accumulate behind a long parent run and replay after its final answer. If a child completes several follow-ups before the parent consumes its report, only the latest execution is delivered. Earlier output remains available in the child's transcript.

## Configuration

Global settings live at `~/.pi/agent/subagents.json`. A trusted project's `<configDir>/subagents.json` (`.pi` by default; Pi's `CONFIG_DIR_NAME`) can override them for that project.

```json
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "defaultThinking": "medium",
  "maxDepth": 4,
  "maxConcurrency": -1
}
```

All fields are optional. Defaults are `maxDepth: 2` and `maxConcurrency: 4`.

- `defaultModel` — fallback model for spawns that omit `model`.
- `defaultThinking` — fallback thinking level for spawns that omit `thinking`.
- `maxDepth` — maximum recursive depth. The root is depth `0`; `maxDepth: 0` disables spawning. Descendants inherit the root limit and may only tighten it.
- `maxConcurrency` — number of children allowed to run at once per creating session. Use `-1` for unlimited or a positive integer for a limit; extra children queue automatically. Resuming a completed child also waits for its creator's slot, even when an ancestor sends the follow-up. Steering a running child does not require another slot.
- `rpcMaxLineChars` — defensive limit per child stdout JSONL record, default `67108864` (64 Mi UTF-16 code units, including an optional trailing CR but excluding LF). Must be a positive safe integer; there is no unlimited mode. Set it in global or trusted-project `subagents.json`, for example `"rpcMaxLineChars": 134217728` for unusually large workloads.

Pi RPC embeds base64 images in tool/message events and aggregates messages in `turn_end` and `agent_end`. The 64 Mi default allows several multi-megabyte images and aggregate results that exceed ordinary text-output limits; it is a client safety bound, not a Pi protocol maximum. Both terminated and unterminated records exceeding it fail the child with an explicit error. Input is checked before buffering, scanned incrementally, and discarded on failure. Memory remains proportional to the configured bound (UTF-16 storage, joining, and JSON parsing can require several times the record size per concurrent child); raise it cautiously or reduce concurrency. LF-only framing and split UTF-8 decoding are preserved.

The `--subagent-depth N` Pi flag overrides configured depth for the tree; descendants inherit that override rather than reapplying file limits. Without a flag override, explicit global or trusted-project depth settings may tighten the inherited limit. Built-in defaults never tighten an inherited limit. An explicit descendant `--subagent-depth N` may also tighten the limit and overrides file limits for its subtree. No descendant can raise an inherited limit.

## Footer controls

When children exist, the footer displays a tree rooted at the current agent:

```text
main · openai-codex/gpt-5.5
├─ ● auth-reviewer · openai-codex/gpt-5.5 · running grep
└─ ● test-runner · openai-codex/gpt-5.5 · running npm test
↓ inspect
```

- Press **Down** at the bottom edge of the editor to inspect subagents.
- Press **Up/Down** to select; **Enter/Right** to open a child transcript; **x** stops a running child.
- Transcripts use a **fullscreen, frameless focused overlay**. It covers the parent conversation, with the actual child's identity/status pinned above, a message field and controls below, and a persistent scrollbar. UI labels are English; redundant scroll-mode labels and line counters are omitted.
- Pinned identity, model and **Path** share one row when they fit, expanding to two/three rows as needed. Home-relative paths use `~`. Click only the **Path** area to copy the full, unchanged working directory, even if clipped. Success feedback expires after two seconds; failures remain visible for retry. A pending copy is not duplicated, and its late completion cannot hide a newer send failure. Path stays available in tested 18×8 and larger layouts.
- **Ctrl+O** toggles tools and **Ctrl+T** toggles thinking in the selected child only, honoring remapped/disabled Pi action bindings. With the matching compact-transcript fork, click a compact tool/thinking row for local disclosure; grouped calls retain individual selection. Main-chat visibility, the message draft and saved history are unchanged. This integration requires the companion fork's optional synchronous renderer-scope protocol, not a new npm dependency.
- **Up/Down**, **PageUp/PageDown**, the mouse wheel and dragging/clicking the scrollbar affect only the child history. Page size follows the available transcript height.
- Click **Start** to read from the beginning or **Latest** to resume following new messages. Reading older history does not jump when more lines are appended. **Ctrl+Home/End** are optional shortcuts; plain **Home/End** still edit the message field.
- Type a message and press **Enter** to steer or continue the child. A pending send cannot be duplicated by repeated Enter. Failed sends retain the draft for retry, and each child has its own in-memory draft/editor state (not persisted across reload/restart).
- **Esc**, the **Back** button, or **Left** on an empty input returns to the list; another **Esc** returns to the parent. Closing the viewer **never stops the child**. Stopping is the separate **x** action in the list.
- Finished children remain visible until the next user turn, then leave the footer. Use `/subagents` to review full history.

## Development

The extension is plain TypeScript loaded directly by Pi. The regression suite uses a local fake Pi child and makes no API calls:

```sh
node subagents.test.cjs
node continuation.test.cjs
node history.test.cjs
node routing.test.cjs
node panel-view.test.cjs
node panel-path.test.cjs
node panel-path.test.cjs --layout
node panel-draft.test.cjs
node panel-transcript.test.cjs
node panel-transcript.test.cjs --stock
node panel-refresh.test.cjs
node panel-performance.test.cjs
```

`panel-view.test.cjs` uses the installed Pi's real in-memory fullscreen renderer and native mouse/key dispatch, with synthetic sessions and no real agents, API calls, OS terminal or clipboard. Set `PI_ROOT` to the installed Pi package when needed. It checks coverage, pinned controls, scrolling, append/follow behavior, resizing, drafts, send failures and safe return. The fullscreen UI was tested against Pi 1.3.0 on Windows; this is not a claim of display virtualization or physical-terminal validation.

`continuation.test.cjs` exercises the actual extension tool and RPC lifecycle with an offline Node fixture. It covers exited-session resume, repeated/concurrent messages, stale writers/close markers, concurrency admission/abort/retry, RPC rejection and capability/history boundaries. Process identity probes are stubbed; only owned fixtures may launch or be terminated. This is not a provider-backed live acceptance test.

`history.test.cjs` uses the installed Pi's real `SessionManager` against synthetic JSONL and forbids network, providers and process launches. It covers both sides, compaction, active branches, lossless pagination, delta cursors and invalid/mismatched histories. `routing.test.cjs` uses the actual extension with an offline owned RPC fixture to distinguish quiet manual chat from delegated delivery, previews, idle wakeups, saved read cursors and cross-owner routing; it does not claim physical-terminal or provider-backed acceptance.

`panel-path.test.cjs` checks native mouse dispatch, home boundaries, full-path copy, controlled-clock feedback expiry, overlapping copy/send completion and disposal with an injected clipboard callback only. `--layout` checks responsive one/two/three-row headers and path-only hitboxes after resizing. `panel-draft.test.cjs` uses the real native `CustomEditor` and overlay dispatch: Esc/parent isolation, exact long Unicode restoration, replacement vs concatenation, failed-send retry, empty/repeated Enter, bracketed paste, recipient/acknowledgement isolation, parent undo and memory-only draft lifecycle. Only explicit Enter in the child field sends that field; reopening never submits it or inserts it into the parent editor. Draft handling itself was not rewritten for these controls. `routing.test.cjs --progress-check` isolates live progress persistence: transient rename retries must yield to timers, progress must not rescan the whole historical registry, and failed terminal persistence must keep print-mode parents alive until retry succeeds. Owner progress/close callbacks use single-attempt writes plus their existing asynchronous retry; other synchronous registry callers retain their default retry contract. This does not claim that all registry I/O or process admission is asynchronous.

`panel-transcript.test.cjs` loads the actual installed Pi and compact-transcript checkout (`PI_COMPACT_TRANSCRIPT_ROOT` may override the sibling path). Native SGR/key dispatch covers selected/grouped calls, thinking, scrolled coordinates, append, branch replacement, config/reload, two children with colliding call IDs, parent/draft isolation and no session writes. `--stock` omits compact-transcript: native generic tool output stays fully available and thinking controls work without the optional adapter. These are memory-terminal controls, not live provider/physical-terminal acceptance.

Source files are organized by responsibility:

- `index.ts` — Pi registration, lifecycle hooks, tools, delivery, and UI wiring
- `config.ts` — settings validation and precedence
- `registry.ts` — atomic run records and the latest pending delegated result per child
- `history.ts` — bounded read-only conversation inspection and active-branch cursors
- `wait.ts` — event-driven wait for descendant completion (`check_subagents` wait:true)
- `spawn-agent.ts` — RPC process control, concurrency, cancellation, and depth enforcement
- `owner-control.ts` — cross-process requests/acknowledgements routed through the target's creating session; revoked requests abort pending admission
- `events.ts` — child JSON event parsing and status updates
- `panel.ts` — footer tree, selection, and transcript detail view
- `transcript.ts` — cached native child components, view-only disclosure and optional renderer-scope isolation
- `transcript-viewport.ts` — view-only history position, follow mode, scrollbar and painted mouse-coordinate translation

## Publishing

This repository is ready to publish as `@williamcr01/pi-subagents`:

```sh
npm login
node subagents.test.cjs
npm pack --dry-run
npm publish --access public
```

After publishing, verify the package from a clean Pi installation:

```sh
pi install npm:@williamcr01/pi-subagents
```

For a later release, bump the version (for example with `npm version patch`), push the commit and tag, then run `npm publish` again.

## License

[MIT](LICENSE) © William Crona
