# pi-subscription-router (fork)

Fork of [`@nredd/pi-subscription-router`](https://www.npmjs.com/package/@nredd/pi-subscription-router) 0.5.0,
kept as small as possible. History is three commits, so upstream stays mergeable:

1. `Upstream 0.5.0` — the verbatim registry tarball.
2. `Window kick; quota out of the system prompt; fallback must not outlive its block`.
3. `router:next` — the model the next request will use, published for extensions that act before it.

| change | why |
| --- | --- |
| `src/kick.ts` + wiring | Starts a subscription's 5-hour window with one minimal request after a reset. |
| no quota text in the system prompt | A usage bucket flip changed the cached head and re-billed the whole prefix. |
| `isEarlier` on `continuation` | An eligible earlier rung outranks the incumbent, so a fallback does not outlive its block. |
| `router:next` session entry | The pick depends on live quota state that is persisted nowhere; extensions cannot derive it. |

Dropped from the workstation's earlier patch series: classifier/tier routing, CommandCode reset-from-error
parsing, the multi-process kick lock.

Install: `pi install git:github.com/excessivechaos/pi-subscription-router`
