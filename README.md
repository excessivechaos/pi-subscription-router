# pi-subscription-router

Published to npm as `@nredd/pi-subscription-router` (public). From `0.4.0`, each version is cut by the monorepo `Publish` workflow from a signed `@nredd/pi-subscription-router@<version>` tag, with npm provenance and a GitHub release carrying the tarball, checksums and manifest (`docs/releases.md`); earlier versions were published manually without provenance. `0.4.0` adds `createSubscriptionRouter(options)` (explicit `config` and `usage`, injectable `tracker` and `now`; the default export is unchanged).
Use the [monorepo development commands](https://github.com/nredd/pi-harness/blob/main/README.md). The Git install
below describes legacy deployment, not installation or candidate verification of this package.

## Standalone use

The packed tarball is self-contained: Pi host modules (`@earendil-works/pi-*`, `typebox`) are `*` peers supplied by Pi, there are no runtime dependencies and no sibling plugin is required. Verified by installing the tarball alone and running it in exact stock Pi 1.3.0 (see the repository's `docs/package-contracts.md`). Optional fork integrations (subagents, Plan mode) are absent in that setup; the exercised behavior does not need them.

`router/<profile>` virtual models for pi (>= 0.99) that route across included subscription quota.
Each profile has a chain of physical models and an optional routing strategy. Ordered routing
(default) picks the first eligible model. Balanced routing spends fresh cached quota according
to remaining capacity and reset timing, without adding network reads or changing quota blocks.

Install:

```sh
pi install npm:@nredd/pi-subscription-router@0.4.1
```

Config lives in `<agentDir>/subscription-router.json` (`~/.pi/agent/` by default). No file means
no virtual models. An invalid file is rejected whole and reported on session start.

```json
{
  "profiles": {
    "default": {
      "chain": [
        { "model": "anthropic/claude-sonnet-5-5" },
        { "model": "openai-codex/gpt-5.6-terra", "thinking": "high" },
        { "model": "anthropic/claude-sonnet-5" }
      ]
    }
  }
}
```

The shipped [cheap profile](examples/subscription-router.json) is opt-in: merge its `profiles.cheap` into this file to register `router/cheap`. It uses `strategy: "ordered"`, Haiku 5.5 then GPT 6 Luna, and `exhaustionPolicy: "wait"`. This keeps dispatch inside the inexpensive model class and prefers the first healthy entry, rather than letting headroom reorder the chain. It never borrows `default`, `deep` or `review`; if both are exhausted admission parks or fails under the ordinary policy. Models and pricing are explicit configuration, not a live price catalog. Nothing is installed or registered just by importing the router.

- `strategy` (`"ordered"` default, or `"balanced"`) selects chain-order routing or reset-aware balancing. Opt in per profile, e.g. `"strategy": "balanced"`; arbitrary chain lengths and providers work, unknown collectors remain usable fallbacks
- `exhaustionPolicy` (`"wait"` default, or `"fail"`) says what a dispatcher that can wait (pi-subagents background jobs) does when every quota-eligible entry is exhausted: park until the earliest reset, or fail now. `maxWaitMinutes` (default unlimited) caps how far ahead a reset may be waited for, and a reset that is unknown always fails. Foreground requests cannot wait and fail either way
- `thinking` pins that entry's level. Without it the selected level passes through
- With `enabledModels` / scoped models, add `router/<profile>` there too

Routing:

- Ordered `user`, `direct`: first eligible entry, unchanged
- Balanced `user`: highest-ranked eligible entry, with incumbent hysteresis below
- Balanced `direct`: stays on the eligible previous model when supplied, otherwise uses the balanced pick
- `continuation`: stays on the model that last answered, unless unavailable or quota-blocked; balancing applies only when it must leave
- `retry` (upstream auto-retry, e.g. a 429): refreshes usage. Confirmed -> mark and advance. Otherwise retry the same model
- All blocked: the request fails with the earliest known reset

Balanced scoring (conditional fairness guarantees and exclusions [here](https://github.com/nredd/pi-harness/blob/main/packages/subscription-router/docs/fairness.md)):

- For each applicable provider/family window, `remaining = 1 - usedPercent / 100`, `timeLeft = clamp((resetAt - now) / durationMs, 0.05, 1)`, `score = remaining / timeLeft`. The tightest (minimum-score) window limits the model. Past/equal reset windows are ignored; missing usable reset/duration uses `timeLeft = 1`
- Fresh unlimited ranks above measured, then missing/failed/empty/non-applicable usage. Ties retain chain order. Usage whose snapshot is at most `STALE_GRACE_MS` (15 min, `src/selection.ts`) old, measured from retrieval (about 10 min past the 5 min TTL), still scores as measured, flagged `stale` in status and the decision log, so a child's first route is not biased to `chain[0]` by a racing background refresh; older stale usage is fallback. Stale unlimited is never unlimited
- New prompts keep an eligible measured incumbent unless the challenger is *strictly* more than 20% better (floating-point normalization and boundary roundoff are treated as a tie, including near-exhausted windows). A measured challenger promotes an unmeasured incumbent; if all are unmeasured, the incumbent stays. Fresh unlimited promotes measured and remains sticky
- The same pure scoring and cached selection feed routing, recovery, admission and status. Scores never block quota, fetch data, or enter the system prompt. Adding a provider needs only a normalized collector and chain entry, not another algorithm

Eligibility never hits the network. An entry is skipped when a confirmed block covers it, when
cached usage already shows its window exhausted, or when it has no credentials. Stale or failed
usage fails open, except stale data whose known reset is still ahead.

Blocks are per `(provider, family)`: the Anthropic `seven_day_sonnet` window blocks Sonnet and
leaves Opus eligible. A block lasts until the reset the provider reported. Without one it backs off
5 minutes, doubling up to 60.

Confirmation needs live data read after the failure: a cached or in-flight read from before the
error's timestamp doesn't count, while simultaneous failures still share one request. A failed or
backed-off read confirms nothing. If a later failure supersedes an in-flight read, earlier callers
follow the newer read (or its fresh cached result), rather than treating supersession as failure.
If that newer read is unavailable, an earlier caller may use its own successful snapshot started at
or after its `notBefore` boundary. This fallback never writes shared cache or backoff state: the
newer failure's backoff remains in force. A newer successful snapshot remains authoritative.
At the caller's 20-second deadline, a still-pending newer read cannot hide already completed live
evidence: the caller uses the newest qualifying success in its supersession chain (or cache).
Cancellation never uses this fallback, and neither deadline fallback nor supersession extends the wait.
Confirmation evaluates that exact returned snapshot, not a potentially different shared cache entry.

Mid-run recovery: upstream doesn't retry terminal quota errors (`insufficient_quota`, billing,
`subscription_sharing_usage_limit_exceeded`), so they end the run. At `agent_before_settle` the
router confirms the block, omits the failed assistant message with a `context_edit` (pi won't
continue a context ending in an assistant message), and continues once on the next chain model.
Each chain model gets at most one recovery per user prompt. Router quota failover refuses failed
messages containing nonempty text/thinking or any tool call: emitted output cannot be retracted
safely, so retry explicitly instead of switching models. Core's same-model transient retries and
recoverable length/overflow retries are unchanged, including partial attempts core already omitted.
A retryable partial quota error is confirmed and marked before refusing failover; terminal partial
quota errors are refused before confirmation. Prior successful tool turns remain in context and
are not re-executed by router recovery.

Usage collectors: Anthropic OAuth (`/api/oauth/usage`) and ChatGPT Codex (`wham/usage`). API-key
auth has no subscription window and is never blocked. Codex window names follow the reported
`limit_window_seconds`, not their primary/secondary position: some plans expose only a weekly
primary window. Missing durations retain the legacy positional fallback; other durations stay
explicit in seconds rather than being mislabeled as 5h or weekly. Normalized windows carry optional
`durationMs`: Anthropic's known 5h/7d durations and Codex's reported duration (legacy positional
fallback when absent). Older or third-party snapshots without durations still score safely. Windows also carry optional `spanSource` (`reported` when the provider stated the span: Anthropic's fixed windows and Codex `limit_window_seconds`; `assumed` for the Codex positional fallback). It is display provenance only, so a footer can avoid calling a guessed window 5h or weekly; scoring, admission and blocking never read it.

Surfaces:

- `subscription_usage` tool: windows plus active blocks. Usage buckets are also added to the system prompt as a `subscription_usage` section
- `router:decision` session entries: one per profile's first scored pick in a session and each later change of chosen model, not every route. This slows growth but is not a hard bound: entries are never pruned, flapping between models and every session restart still append (profile, reason, chosen model, each candidate's score, limiting window, stale flag and data age, ineligible entries). Sticky continuations and repeat picks of the same model are not persisted; status still lists the last five. Read them from the session file to prove why a model was picked
- `/router [status|refresh|reset]`: cached-only fresh-dispatch forecast, explicit refresh, or clear all blocks. Status explains each eligible candidate's score and limiting window, unlimited quota, or fallback reason, plus ineligible entries. Status also lists the last five routing decisions of the process. The forecast uses chain-order ties without a session incumbent, like admission; an existing balanced conversation additionally applies its previous-model hysteresis/stickiness
- `pi.events` RPC with the pi-subagents envelope (`{ requestId, ... }`, reply on `<channel>:reply:<requestId>` as `{ success, data | error }`):
  - `router:rpc:admit` `{ model }` -> `{ ok, resolvedModel?, resetAt?, wait? }` (`wait`, only when refused: the caller may park until `resetAt`, see `exhaustionPolicy`; a physical model uses the default `wait` policy). Unknown models are admitted. A `router/*` profile is refused only when a quota block leaves no entry eligible; a chain unusable for config or credential reasons is admitted so the child reports the real cause. Before the first `session_start`, everything is admitted
  - `router:rpc:usage` `{ refresh?: boolean }` -> `{ snapshots, blocks }`. Omitted refresh is cached-only. `refresh: true` reads both collected providers through the ordinary five-minute cache, shared in-flight requests, endpoint timeout and failure backoff; it is not a forced refresh. Before session start it remains cached-only. The personal TUI footer uses this RPC once a minute to show provider-wide remaining quota for both subscriptions, independent of the selected model

Usage and block state is process-global, so in-process subagent sessions share it. A newer
confirmation read supersedes older in-flight reads for cache and backoff writes, even when the older
read finishes last. Superseded callers only follow later owners, so no cyclic wait is possible;
each caller waits at most 20 seconds total, even across repeated supersessions. Cancelled callers
detach without aborting shared reads; pre-cancelled requests return cancellation even with a usable
cache, and neither read credentials nor consume the manual refresh allowance. An initiated manual
refresh consumes its allowance even if later superseded or cancelled. Unsupported collector names never
resolve credentials. Out-of-range reset timestamps normalize to an unknown reset.

Core owns OAuth acquisition, refresh and persistence. The router bounds its wait for credential
lookup to 10 seconds, then reports a sanitized error and backs off; it cannot cancel core's lookup.
The subsequent usage HTTP request has its own 10-second timeout. No token or response body appears
in usage errors. These bounds do not prove live OAuth refresh or revocation behavior.

Development:

```sh
# From the monorepo root:
make install
npm run check --workspace @nredd/pi-subscription-router  # biome, tsc, vitest, bun scenarios
```

`test/scenarios/` covers terminal/retry/unconfirmed recovery, partial-stream refusal, cancellation,
bounded retries, direct `subscription_usage` execution and all six balanced cases through the real
router factory and core session harness, under Vitest and Bun. The coverage/ownership matrix and
live-smoke proposal are [here](https://github.com/nredd/pi-harness/blob/main/packages/subscription-router/docs/hardening.md).

`createSubscriptionRouter({ config, usage, tracker?, now? })` embeds an isolated router with explicit dependencies; the default export still loads agent config and shares usage/blocks process-wide. Scenarios inject a credential-free cache and quota clock; core retries use `baseDelayMs: 0`.

`integration/inprocess/router-admission.test.ts` covers `wait`, `fail` and `capped` with the real router/subagents factories on one fake clock under Vitest and Bun. The optional-router absence case is `packages/subagents/test/session-scenarios.test.ts` / `absent admission RPC admits physical child`. All 13 former shell cases have native receipts in `docs/verification-rebuild.md`; the shell runner and its unused faux helpers are deleted. No installed Pi, owner checkout or `PI_SUBAGENTS_DIR` is needed.
