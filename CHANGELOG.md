# Changelog

## Unreleased

- Ship an opt-in `cheap` profile example: ordered Haiku 5.5 then GPT 6 Luna, with the usual wait policy and no implicit profile registration. Real-registry stack tests exercise it through built-in Explore's `@cheap` default

- Score expired snapshots no older than `STALE_GRACE_MS` (15 min after retrieval, about 10 min past the TTL) as measured, flagged `stale`, instead of fallback; fixes balanced routing favouring `chain[0]` when a new child's first route races the background refresh. No network read added before routing
- Record each scored routing decision (candidates, scores, limiting window, data age, chosen model) as a `router:decision` session entry (a profile's first pick per session and each change of chosen model only; this reduces growth but is not a hard bound, since flapping and restarts still append) and list the last five in `/router status`

## 0.4.1

- Document conditional normalized-quota fairness guarantees and deterministic counterexamples without changing routing policy

- Refuse cross-model quota replay of partial streams without blocking core same-model recovery
- Follow newer confirming reads with bounded, cancellable waits and exact-snapshot decisions; keep newest-only cache/backoff writes
- Keep pre-cancelled refreshes from consuming manual allowance; bound credential-owner waits
- Reject inherited collector names and out-of-range reset timestamps
- Exercise direct usage tools and packed multiprovider dispatch without live credentials
- Remove nonexistent `e2e/` paths from formatting and lint commands

- Retire the shell E2E runner and unused faux helpers after all 13 cases moved to native package, stack and pi-subagents suites

## 0.3.0

- Add opt-in per-profile `strategy: "balanced"` with pure, provider-neutral reset-aware scoring, arbitrary chain lengths and strict >20% incumbent hysteresis
- Normalize quota-window `durationMs`, including known Anthropic durations and Codex reported/legacy fallback durations
- Keep eligible balanced direct requests and continuations sticky; preserve ordered routing and confirmation, exhaustion and parking policy
- Share cached selection across route, recovery, admission and status; explain scores, limiting windows and fallback reasons without volatile prompt text
- Make `/router status` cached-only; keep `/router refresh` as the explicit network action
- Add actual installed-Pi faux E2Es for three-provider balancing, prompt switching, continuation stickiness, blocked failover, stale/missing fallback and measured-to-unmeasured recovery

## 0.2.2

- Add optional cache-aware `refresh` to `router:rpc:usage` for the remaining-quota footer
- Preserve cached-only callers, shared request deduplication and failure backoff
- Label Codex quota windows by their reported duration, including weekly-only primary windows

## 0.2.1

- Add admission and exhaustion-policy scenarios to `e2e/run.sh`, runnable as `all`
- Fix `e2e/run.sh` on macOS bash 3.2, where an empty `reject` array tripped `set -u`

## 0.2.0

- Add per-profile `exhaustionPolicy` (`wait` default, `fail`) and `maxWaitMinutes`
- Return `wait` on a refused `router:rpc:admit` reply so dispatchers know whether to park or fail

## 0.1.4

- Treat Anthropic's 400 "You're out of extra usage" as a possible quota error so it reaches usage confirmation and failover

## 0.1.3

- Set `package.json` version to match the tag, add this changelog

## 0.1.2

- Share `ModelRef`, `refKey`, `parseRef` and `sameModel` from `src/model-ref.ts`

## 0.1.1

- Confirm a quota block only from live usage read at or after the failure (`notBefore`)
- Admit a `router/*` profile unless some entry is quota-blocked; config or credential problems fail open
- Move admission into `Router.admit`
- Format error timestamps without milliseconds so upstream's retry classifier never sees a bare `500`/`502`/`503`

## 0.1.0

- `router/<profile>` virtual models over ordered chains, subscription usage collectors for Anthropic OAuth and ChatGPT Codex, confirmed per-family exhaustion marks, `agent_before_settle` recovery, `router:rpc:admit` / `router:rpc:usage`, `subscription_usage` tool and `/router`
