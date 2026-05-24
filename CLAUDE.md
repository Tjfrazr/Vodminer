# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## The 95% Bar (UNIVERSAL — applies to every claim, every task, every session)

**Before stating any fact, making any recommendation, suggesting any
change, or claiming any work is complete: you must be ≥95% confident
it is correct. If you are not, either verify it first or flag the gap
explicitly — never assert it.**

This applies to everything, with no exceptions:
- Facts about code, state, environment, deployment, files
- Recommendations and suggestions ("you should do X", "this would
  improve Y", "the cause is Z")
- Implementation claims ("this is done", "this is tested",
  "this resolves the issue", "all callers updated")
- Architectural opinions ("this is the simplest approach",
  "this is safe", "this won't regress")
- Aggregates ("most of X are Y", "all N are Z")

**State confidence proactively.** The user must not have to ask
"are you 95% sure" — pre-empt the question every time. When making a
recommendation, asserting state, or claiming completion, lead with:

> Confidence: ~X% — [what I verified] / [what I inferred without verifying]

This is not optional. If you cannot give a number with substance behind
it, you are not ready to make the claim.

**The verification test.** Before any claim, ask yourself:
"If the user asks me right now to prove this, would I run a command —
or would I just repeat what I said?"
If the answer is "repeat," you do not actually know it. Go verify.

**Forbidden without verification:**
- "It should be…" / "I think…" / "I believe…" / "probably…" / "likely…"
- "Most of X…" / "All of X…" — query the breakdown
- Repeating earlier-session snapshots as current state
  (the system has changed since you looked)

**Walk it back when challenged.** If asked "are you 95% sure" and
you aren't, retract immediately. Performative agreement is worse than
admitting the gap — and it wastes the user's time on a worse outcome.

**Below 95% is fine — silently asserting it is not.** Saying
"I'm at ~70% on this because I haven't verified the call sites in
chat.py — want me to check before I proceed?" is the correct behavior.
The failure is only when low confidence is hidden behind confident
phrasing.

## Working Style & Interaction Guidelines - MUST FOLLOW

### Response Style

1. Start with the answer. No filler phrases ('Great question!', 'Certainly!', etc.). No preamble.
2. Match length to complexity: simple questions get short answers; complex tasks get full detail. Never pad with restatements.

### Before Major Actions

1. For significant tasks: show 2–3 approaches first. Wait for your choice before proceeding.
2. Before altering existing content: describe the change and why. Wait for confirmation. 'I think this would be better' is not permission.
3. Before deleting, overwriting, or irreversible changes: list what will be affected. Ask for explicit confirmation.

### Scope Discipline

1. Only change what you explicitly asked me to change. No rewrites, rephrasings, or 'improvements' unless requested. If I spot something else worth fixing, I mention it at the end—untouched unless you ask.
2. In code: only modify lines directly related to the task. No refactoring, renaming, or improvements outside scope. Flag issues; don't fix them without approval.

### Task Completion

1. After editing/writing tasks: end with a status summary—what changed, what stayed, what needs your attention. Keep it brief.
2. After coding tasks: list files changed (one line per file), files intentionally untouched, follow-up needed.

### Session & Error Tracking

1. Maintain MEMORY.md (in the repo ALWAYS): log significant decisions (what, why, what was rejected). Read it before each session. VERY IMPORTANT!
2. Maintain ERRORS.md (in the repo ALWAYS): when an approach takes 2+ attempts, log what failed, what worked, and what to remember. Check it before suggesting similar approaches.
3. On 'session end': write a brief summary to MEMORY.md (in the repo) of work done, completed items, in-progress work, decisions made, next steps.

### Deferred Tasks (`.claude/commands/deferred.txt`)

1. **At session start (before responding to the user's first message):** read `.claude/commands/deferred.txt`. If any items are 🔴 overdue or 🟡 due today, surface them at the top of your opening reply as a single block — then answer whatever the user asked. If nothing is overdue or due, say nothing. Don't surface upcoming/future items unless the user asks.
2. **When you spot a defer candidate during work** (waiting on data, observation period, post-deploy bake, "let's revisit after N days", etc.): **ASK the user inline.** Phrase it like "Want me to add this to the deferred list? — '<text>', return-by <date>". Never auto-add.
3. `deferred.txt` is append-only. Never rewrite or edit existing lines.

## Workflow

Before starting any task:

- Review recent `runninglog.txt, MEMORY.md & ERRORS.md` entries (last 10) and recent commits for context. If you don't have enough context, go deeper into the files.
- Use sub-agents/tools when helpful.
- Provide recommendations if they materially improve the solution.

**Workflow**:
Plan → Inspect → Implement → Debug → Verify → Log → Commit → Push

After completing work:

1. Update runninglog.txt with timestamps, commit ID, and a brief summary. Add latest entries at the bottom (earliest to latest).
2. Commit with a clear message.
3. Push changes to main.

---

## Rules

1. **Simplest solution first** — always implement the simplest thing that could work. Don't add abstractions that weren't requested.

---

## Refactoring Checklist (CRITICAL)

**When changing function signatures, data structures, or removing abstraction layers:**

1. **Find all call sites** — `grep -r "function_name\|variable_name"` across the codebase to find every usage.
2. **Document the data structure** — Write down what the function returns, its shape, and type BEFORE making changes.
3. **Verify each call site** — For every location the function/variable is used:
   - Understand what it expects
   - Trace the data flow
   - Verify the change will work there
4. **Run full test suite** — Tests must pass; all tests must run without skips or failures.
5. **Spot-check changed code** — Manually review at least 3 call sites in the actual modified code files (not just tests).
6. **Type check** — Run type checker with strict mode; must pass with no errors.

**Critical mistake to avoid:** Removing a loop or conditional that wraps a dict/list access, then forgetting to add indexing at each call site. Example:
- ❌ Old: `for key in dict: dict[key].property = value` → New: `dict.property = value` (BREAKS — dicts don't have .property)
- ✅ Correct: `for key in dict: ...` → `dict["key"].property = value` (maintains indexing)

**Removing a function parameter:** When you delete `param_name` from a signature, references to it inside the function body silently become unbound globals — they won't error at import time, only when those lines execute. Latent code paths (rare branches, error handlers, log statements) hide these bugs.
- ✅ After dropping a param: search for the param name and confirm zero matches inside the changed function.
- ✅ Type checker must report no `Name "param_name" is not defined` errors.
- ✅ Update every test that passes the dropped kwarg in the SAME commit.

**Pre-existing test failures are not acceptable backlog:** A test that fails masks new regressions and erodes trust in the suite. Don't classify failures as "pre-existing" and move on. Either fix them in the same week they appear or delete the test.

**Verify pre-commit is actually installed locally:** Config file existing ≠ hooks running. Run `pre-commit install` after cloning. Without it, type checking and test gates are theoretical.

---

## Debugging & Harness Gotchas

When a test or harness disagrees with manual analysis of the same data, suspect the harness — not the underlying code under test.

**Common pitfall: Import statement defeats monkey-patching.** When you patch a function at its definition location, calling code that did `from module import function` already holds the original reference and is unaffected. You must also patch the rebound name in every calling module's namespace.
- ✅ Example: patch at both the source AND every location that imported it.
- Verify via grep for all import statements and ensure each calling module is patched explicitly.

---

## Common Tasks

### Generate Timestamp for Runninglog
When appending entries to `runninglog.txt`, always use consistent timestamps in format `[YYYY-MM-DD HH:MM]`:

```bash
# Adjust timezone as needed for your project
# Ensure timestamp generation is automated, not manual
```

This ensures consistent, accurate timestamps without manual calculation.

### Testing
- Run tests before committing.
- All tests must pass; no skips or failures.
- Flag pre-existing failures immediately and fix or delete them.

---

## Project

Vodminer is an automated Twitch → TikTok highlight clipping pipeline. It detects highlights from Twitch VODs (audio spikes + chat velocity), clips them with ffmpeg, sends previews to Discord for approve/reject review, and posts approved clips to TikTok.

See `stream_to_tiktok_plan-2.md` for the full plan and phased timeline.

## Stack & Constraints

- Node.js 20+, ES modules (`"type": "module"` in package.json) — no TypeScript
- ffmpeg must be installed on the host machine
- 100% free tooling — no paid services or subscriptions
- All API keys via git secrets — never hardcoded, never committed to source files
- Twitch EventSub requires a public HTTPS URL (use ngrok for local dev)
- TikTok Content Posting API requires an approved developer app with `video.publish` scope
- TikTok posts must set `is_ai_generated: false` for raw stream footage

## Architecture

```
Twitch EventSub (stream.offline webhook)
  → Fetch VOD via Twitch API
  → Highlight detection (audio RMS spikes + chat velocity)
  → ffmpeg processing (crop 9:16, captions, H.264 1080x1920, max 60s)
  → Discord bot preview with Approve/Reject buttons
  → TikTok Content Posting API (Direct Post on approve)
```

### Module Layout

- `src/twitch/` — EventSub webhook listener, VOD fetcher, highlight/clip detector
- `src/processing/` — ffmpeg pipeline (crop, resize, caption) and game-specific detection profiles in `profiles/`
- `src/discord/` — Review bot with inline Approve/Reject buttons (Honeybee pattern)
- `src/tiktok/` — OAuth 2.0 auth, chunked video upload, Direct Post API
- `src/scheduler/` — Post timing queue (space clips 2-3 hours apart, target 7pm-10pm)
- `config.js` — Game profiles, detection thresholds
- `index.js` — Entry point

## Video Output Spec

All clips: MP4, H.264 codec, 1080x1920 (9:16 vertical), max 60 seconds, max 1GB.

## Key API Limits

- TikTok: 25 videos per account per day
- Twitch VOD clips: 5–60 seconds per clip

## Environment Variables (stored in git secrets)

```
TWITCH_CLIENT_ID
TWITCH_CLIENT_SECRET
TWITCH_BROADCASTER_ID
TWITCH_WEBHOOK_SECRET
DISCORD_BOT_TOKEN
DISCORD_CHANNEL_ID
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
TIKTOK_ACCESS_TOKEN
```
