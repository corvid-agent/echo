# pyright: reportMissingModuleSource=false
"""ECHO - a cross-app-read composability demo on Algorand TestNet.

The beacon speaks, echo remembers. An Arcron keeper calls `relay()` on a
cadence, and the hook reads ANOTHER app's global state - the beacon's
`revealed_round` and `revealed_seed` keys - and mirrors whatever it finds
into its own state. One app reading another is the whole point: nothing is
passed in by the caller, nothing the caller says is trusted, and the source
of truth is the beacon's on-chain state, read through the AVM's cross-app
global read (`app_global_get_ex`).

Paired with arcron-beacon (TestNet app 770742777), which publishes a fresh
block seed every keeper cycle. Echo is its reader: each keeper call checks
whether the beacon has spoken a round echo has not seen, and if so records
both the round and the 32-byte seed. Consumers can then read echo's own
global state (or call `latest()`) without touching the beacon at all.

WHY THE CALL NEEDS NO FOREIGN-APP ARGUMENT: reading another app's global
state requires that app to be *available* - present in the foreign-apps
array of the call. Echo never names the beacon in its own invocation
because it does not have to: Arcron keeper bots
(CorvidLabs/arcron scripts/keeper_bot.py `_resolve_execute_references`)
simulate every execution with `allow_unnamed_resources`, collect every
account, app, asset, and box the target touches from the node's
`unnamed-resources-accessed` report, and attach them to the real call. The
beacon reference is discovered and attached automatically.

TRAPS this contract avoids (see docs/integrating.md in CorvidLabs/arcron):

  * Zero-argument hook. `relay()` takes no args; Arcron supplies none. A
    keeper decides *when* relay runs, never *what* it reads.
  * Authorization is Application(keeper).address - the sender of Arcron's
    inner call. Never compare against itob(keeper_app_id); that is 8 bytes,
    not an address.
  * FAIL SOFT. A hook that rejects gets exponentially backed off by keeper
    bots (1, 2, 4... intervals) until the schedule quietly stops and burns
    escrow on retries. After the two authorization asserts, every no-work
    path here RETURNS 0 - nothing asserts once the keeper is authenticated.
    The cross-app read itself cannot fail: `app_global_get_ex` returns
    (value, ok) and never traps, so a missing key or an unwritten beacon
    is just another return 0.
  * Zero create args. A uint64 create_arg is how a sloppy deploy script
    confuses the keeper app id with a cadence and locks an interval at
    ~68 years. There is nothing to pass at create; the keeper is named
    once via `set_keeper`, the beacon once via `set_target`.

CADENCE NOTE: echo can only notice a reveal after the beacon's keeper has
published it, so echo's own upkeep interval should sit at or below the
beacon's cadence. The beacon runs at 1700 rounds (~80 min); echo registers
at the same 1700 rounds and typically lags the beacon by at most one of
its own intervals. Reading is idempotent - a call with nothing new costs
one return 0 and nothing else.

TestNet only. Unaudited. Not deployed (appId = 0 until a human deploys).
"""

from algopy import (
    ARC4Contract,
    Application,
    Bytes,
    Global,
    GlobalState,
    Txn,
    UInt64,
)
from algopy.arc4 import abimethod
from algopy.op import AppGlobal


class Echo(ARC4Contract):
    """Cross-app-read relay: mirrors the beacon's revealed round and seed.

    TestNet only. Unaudited. Not a product.
    """

    def __init__(self) -> None:
        # App id of the Arcron keeper allowed to call `relay`. Zero until
        # `set_keeper`. Not an interval. Not a create arg.
        self.keeper_app = GlobalState(UInt64(0))
        # App id of the beacon whose global state `relay` reads. Zero until
        # `set_target`; on TestNet this will be 770742777 (arcron-beacon).
        self.target_app = GlobalState(UInt64(0))
        # The beacon `revealed_round` echo last mirrored. Zero = nothing seen.
        self.last_seen_round = GlobalState(UInt64(0))
        # How many fresh reveals have been relayed, ever.
        self.relays = GlobalState(UInt64(0))
        # The beacon `revealed_seed` for `last_seen_round`. 32 bytes once
        # set; empty until the first relay.
        self.last_seed = GlobalState(Bytes())

    @abimethod(create="require")
    def create(self) -> None:
        """No-op create. Zero arguments on purpose.

        The 68-year trap: never take a uint64 create arg that a deploy
        script might map to the keeper app id. Nothing to pass here.
        """
        self.keeper_app.value = UInt64(0)
        self.target_app.value = UInt64(0)
        self.last_seen_round.value = UInt64(0)
        self.relays.value = UInt64(0)
        self.last_seed.value = Bytes()

    @abimethod()
    def set_keeper(self, keeper: Application) -> None:
        """Name the Arcron keeper whose app account may call `relay`.

        Creator-only, one-time. Pass the keeper *application*, not a raw
        uint64. `relay` authorizes Application(keeper).address - the
        inner-call sender when Arcron `execute()` inner-calls this app -
        never itob(keeper.id). Puya lowers the Application param to uint64
        in the ABI signature; the compiled selector is set_keeper(uint64)void.
        """
        assert Txn.sender == Global.creator_address, "Only the creator can set the keeper"
        assert self.keeper_app.value == 0, "Keeper already set"
        assert keeper.id != 0, "Keeper app required"
        self.keeper_app.value = keeper.id

    @abimethod()
    def set_target(self, target: Application) -> None:
        """Name the beacon app whose global state `relay` reads.

        Creator-only, one-time; on TestNet this will be app 770742777
        (arcron-beacon). Pass the beacon *application*, not a raw uint64;
        Puya lowers the Application param to uint64 in the ABI signature,
        so the compiled selector is set_target(uint64)void. There is no
        re-point method: a reader that changed targets mid-stream would
        silently splice two different seed histories together.
        """
        assert Txn.sender == Global.creator_address, "Only the creator can set the target"
        assert self.target_app.value == 0, "Target already set"
        assert target.id != 0, "Target app required"
        self.target_app.value = target.id

    @abimethod()
    def relay(self) -> UInt64:
        """Arcron hook. Zero arguments; the selector is the only app arg.

        Reads the TARGET app's global state - keys `revealed_round` and
        `revealed_seed` - via `app_global_get_ex`, which returns
        (value, ok) and never traps. Returns 1 when a fresh reveal was
        mirrored this call, 0 on every no-work path:

          * target unset (deploy ran but `set_target` has not),
          * either key unreadable (beacon unwritten, or the reference was
            not attached - keeper bots attach it automatically by
            simulating first; see the module docstring),
          * the beacon's revealed round is one echo has already stored.

        FAIL SOFT: after the two authorization asserts nothing here may
        reject - a failing hook gets exponentially backed off by keeper
        bots and burns upkeep escrow on retries.
        """
        keeper = self.keeper_app.value
        assert keeper != 0, "Keeper not set"
        # Inner-call sender is the keeper *app account*, not itob(keeper.id).
        assert (
            Txn.sender == Application(keeper).address
        ), "Only the keeper app may relay"

        # No beacon named yet - nothing to read. Return, do not assert.
        target = self.target_app.value
        if target == 0:
            return UInt64(0)

        # Cross-app read. get_ex never asserts: ok is False when the key is
        # absent (or the app is unavailable), and False just means no work.
        revealed_round, round_ok = AppGlobal.get_ex_uint64(
            Application(target), b"revealed_round"
        )
        revealed_seed, seed_ok = AppGlobal.get_ex_bytes(
            Application(target), b"revealed_seed"
        )
        if not round_ok or not seed_ok:
            return UInt64(0)

        # Nothing new since the last relay. Note this also covers the
        # never-revealed beacon: its round reads 0, which is what echo
        # already has.
        if revealed_round == self.last_seen_round.value:
            return UInt64(0)

        # FRESH - the beacon spoke a round echo has not seen. Remember both.
        self.last_seen_round.value = revealed_round
        self.last_seed.value = revealed_seed
        self.relays.value += 1
        return UInt64(1)

    @abimethod(readonly=True)
    def latest(self) -> UInt64:
        """The last beacon round echo mirrored (0 = none yet).

        The seed itself is deliberately not returned here: it is a 32-byte
        value readable straight from global state under the `last_seed`
        key, which is what indexers and off-chain readers already do.
        """
        return self.last_seen_round.value
