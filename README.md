# echo

A **cross-app-read composability demo** on Algorand TestNet, relayed by
[Arcron](https://github.com/CorvidLabs/arcron) keepers. **The beacon speaks,
echo remembers.** Sibling of [arcron-beacon](https://github.com/corvid-agent/arcron-beacon),
[epitaph](https://github.com/corvid-agent/epitaph), and
[plod](https://github.com/corvid-agent/plod).

**Unaudited. TestNet only. Not deployed (appId = 0).** Deploy needs a
human's explicit go — see issue #1.

## What it does

One app reading another, with nothing passed in. Echo is paired with the
[arcron-beacon](https://github.com/corvid-agent/arcron-beacon) (TestNet app
**770742777**), which publishes a fresh, previously-unknowable block seed
every keeper cycle. An Arcron keeper calls echo's `relay()` on a cadence,
and the hook reads the **beacon's global state** — keys `revealed_round`
and `revealed_seed` — through the AVM's cross-app global read
(`app_global_get_ex`):

- If the beacon has spoken a round echo has not seen, echo **mirrors it**:
  `last_seen_round` and the 32-byte `last_seed` are stored, `relays`
  increments, and the call returns 1.
- Every no-work path — target unset, key unreadable, round already seen —
  **returns 0** and changes nothing.

Consumers then read echo's own global state (or call `latest()`) without
touching the beacon at all. The pattern is the lesson: a keeper-driven app
can compose on any other app's published state without arguments,
signatures, or coordination — the chain is the interface.

## Resource availability (why echo never names the beacon in its own call)

Reading another app's global state requires that app to be *available* —
present in the foreign-apps array of the call — and `relay()` takes zero
arguments, so echo cannot receive the reference from its caller. It does
not have to. Arcron keeper bots
([`scripts/keeper_bot.py`](https://github.com/CorvidLabs/arcron/blob/main/scripts/keeper_bot.py),
`_resolve_execute_references`) **simulate every execution first** with
`allow_unnamed_resources=True`, collect everything the target touches from
the node's `unnamed-resources-accessed` report — accounts, apps, assets,
boxes — and attach them directly to the real `execute` call (the inner
`relay()` invocation inherits them via resource pooling). The beacon app
reference is discovered and auto-attached on every execution; if it ever
were not, echo would simply read `ok = false` and return 0 (fail-soft),
never trap.

## The cadence note (read this before registering)

Echo can only notice a reveal **after the beacon's keeper has published
it**, so echo's upkeep interval should sit at or below the beacon's
cadence. The beacon runs at **1700 rounds ≈ 80 min** (the AVM ceiling:
delay 800 + 900-round `blk_seed` window), so echo registers at the same
**1700 rounds** and typically lags the beacon by at most one of its own
intervals. Reading is idempotent — a call with nothing new is one cheap
return 0 — so running echo faster than the beacon wastes only escrow, and
running it slower just adds lag. Never faster than the beacon by much
without reason; never slower if you care about freshness.

## The traps this contract avoids

Read [docs/integrating.md](https://github.com/CorvidLabs/arcron/blob/main/docs/integrating.md)
in the Arcron repo first. Every one of these was learned the hard way:

1. **Zero create args.** A uint64 create_arg is how a sloppy deploy script
   confuses the keeper app id with a cadence and locks an interval at ~68
   years. `create()` takes nothing; the keeper is named once via
   `set_keeper`, the beacon once via `set_target`.
2. **Keeper auth is `Application(keeper).address`, never `itob`.** Arcron's
   inner call comes from the keeper *application account*. Comparing the
   sender against `itob(keeper_app_id)` compares 8 bytes to a 32-byte
   address and never matches.
3. **Fail soft after keeper auth.** A hook that rejects gets exponentially
   backed off by keeper bots and burns upkeep escrow on retries. After the
   two authorization asserts in `relay()`, every no-work path **returns 0**
   — target unset, key unreadable, round already seen. The cross-app read
   itself cannot trap: `app_global_get_ex` returns `(value, ok)` and never
   asserts, so a missing key is just another return 0.
4. **`set_keeper` / `set_target` are one-time, creator-only.** Set once
   after deploy, before registration; neither can be re-pointed. A reader
   that changed targets mid-stream would silently splice two seed
   histories together.
5. **Compile clean.** Verified: puyapy 5.10.1 compiles this contract with
   zero errors (artifacts committed under `smart_contracts/echo/out/`).

## State layout (global)

Declared order; keys are stored by name. Schema from the compiled arc56:
**4 uint64 + 1 byte slice**, no local state.

| slot | key               | type       | meaning                                          |
| ---- | ----------------- | ---------- | ------------------------------------------------ |
| 0    | `keeper_app`      | uint64     | Arcron keeper app id; 0 until `set_keeper`       |
| 1    | `target_app`      | uint64     | beacon app id; 0 until `set_target` (770742777)  |
| 2    | `last_seen_round` | uint64     | last beacon `revealed_round` echoed; 0 = none    |
| 3    | `relays`          | uint64     | fresh reveals mirrored, ever                     |
| 4    | `last_seed`       | bytes (32) | beacon `revealed_seed` for `last_seen_round`     |

## ABI

Selectors are `sha512_256(signature)[:4]`, as compiled by puyapy 5.10.1.

| method                   | selector     | auth               | notes                                       |
| ------------------------ | ------------ | ------------------ | ------------------------------------------- |
| `create()void`           | `0x4c5c61ba` | (create)           | zero create args, on purpose                |
| `set_keeper(uint64)void` | `0xc4c1d8f7` | creator, one-time  | ABI lowers `Application` to `uint64`        |
| `set_target(uint64)void` | `0x376988ee` | creator, one-time  | names the beacon app (770742777)            |
| `relay()uint64`          | `0xabf7048b` | keeper app account | fail-soft; returns 1 when a reveal is fresh |
| `latest()uint64`         | `0xb63b6160` | readonly           | `last_seen_round`; read `last_seed` from state |

## Keeper registration recipe

Register an upkeep on the Arcron TestNet keeper app **769891898** (address
`M4YFP33L5VIFRF53X53WUMQWBOWSLYQNBSSAJV2SORGF43L36XBY7OREUA`) via

```
register(pay,pay,uint64,byte[][],uint64,uint64,uint64,uint64,uint64,uint64)uint64
```

with:

- **target app** = the deployed echo app id; **call args** = the bare
  `relay()` selector (`0xabf7048b`), ABI-encoded as `byte[][]`
  (10 bytes on the wire: count + offset + length + selector).
- **interval = 1700 rounds** (~80 min) — matched to the beacon's cadence;
  see the cadence note above.
- **fee per execution = 4000 µALGO**.
- **skip policy = 1 (SKIP_AHEAD)** — a missed call is harmless; the next
  call reads whatever round is current, so catch-up replays would only
  re-read the same state. Never leave the zero default.
- **payment 1 = MBR**, to the keeper app address:
  `2500 + 400 × (139 + len(call_args))` µALGO → for the bare selector,
  `2500 + 400 × 149 = 62100` µALGO.
- **payment 2 = escrow**, to the keeper app address: **500000 µALGO**
  (125 executions at 4000 µALGO; top up before it runs dry).
- Both payments go to the **keeper app address** (escrow address of app
  769891898), not to echo.
- After registering, read the upkeep box `u` + `itob(upkeep_id)` **fresh**
  from the keeper app (indexer `/v2/applications/769891898/box?name=...`) —
  never trust a cached copy when checking `next_execution_round`.
- No foreign-app reference for the beacon is needed anywhere in the
  registration: keeper bots discover and attach it per execution by
  simulation (see the resource-availability section above).

Order matters: deploy → `set_keeper` → `set_target` → register, because
`relay` hard-asserts until the keeper is set (and fail-softs until the
target is).

## How a human deploys this later

**TestNet only. Never commit a mnemonic. Never deploy without the human go
(issue #1).**

1. Fund a throwaway TestNet account (dispenser). The mnemonic lives in
   env/CI secrets, never in git.
2. Compile: `puyapy smart_contracts/echo/contract.py --out-dir out`
   (or reuse the committed artifacts).
3. Deploy the app with **zero create args**. Record the app id.
4. Call `set_keeper` with keeper app **769891898** (creator-only, one-time).
5. Call `set_target` with beacon app **770742777** (creator-only, one-time).
6. Register the upkeep on keeper 769891898 per the recipe above (issue #2).
7. Set `"appId"` in `docs/deploy.json` — the board lights up on its own
   (issue #3).

## Layout

```
smart_contracts/echo/contract.py   the Puya (Algorand Python) source — the whole thing
smart_contracts/echo/out/          committed puyapy 5.10.1 artifacts (arc56 + TEAL)
docs/                              GitHub Pages split-flap board (NOT DEPLOYED until appId > 0)
docs/deploy.json                   {"appId": 0, ...} — the board's single source of config
```

Compiled artifacts are committed here on purpose (as in epitaph) so the
reviewed bytecode hash is pinned in git.

**Pending:** the token that wrote this repo lacks the `workflow` scope, so
no Pages publish workflow is committed. **A human must enable GitHub Pages
from `/docs` on `main` in the repository settings** (Settings → Pages →
Source: Deploy from a branch → `main` `/docs`). A `pages.yml` copied from
[corvid-agent/plod](https://github.com/corvid-agent/plod) is welcome when a
suitably-scoped credential exists.

## Build locally

```bash
pip install puyapy==5.10.1
puyapy smart_contracts/echo/contract.py --out-dir out
```

Verified at authoring time: compiles clean on puyapy 5.10.1; global schema
4 uint64 + 1 byte slice; selectors as tabulated above. Mock-chain tests
cannot prove keeper integration (inner calls, cross-app availability, MBR)
— that belongs to a LocalNet/TestNet e2e at deploy time.

## The board

`docs/` is a split-flap/CRT status board in the spirit of
[corvid-agent/epitaph](https://github.com/corvid-agent/epitaph) and
[corvid-agent/arcron-beacon](https://github.com/corvid-agent/arcron-beacon).
While `appId` is 0 it shows **NOT DEPLOYED**. Once `appId > 0` it reads the
app's global state — and the beacon's, app
[770742777](https://testnet.explorer.perawallet.app/application/770742777)
— from the public indexer (`https://testnet-idx.algonode.cloud`) and flaps
out LISTENING / ECHOING / BEHIND, the last seen round, the seed as hex,
the relay count, and the lag against the beacon. If the feed is
unreachable it falls back to the last good snapshot (marked STALE) rather
than guessing. Read-only, no wallet, no keys.

Unaudited. TestNet only. Not deployed.
