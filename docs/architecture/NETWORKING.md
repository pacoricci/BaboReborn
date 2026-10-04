# Networking

The browser sends input over WebSocket to the community server, which owns match
outcomes. Central stays outside the combat path.

## Timing and input

The authority runs at **120 ticks/s** and captures snapshots every four ticks
(**30 captures/s**). Capture, delivery, and rendering have separate cadences. See
[authority timing](../../backend/gameconfig/timing.go), its
[browser mirror](../../frontend/src/core/timing.ts), and
[capture timing](../../backend/server/match/timing.go).

Wire instants end in `Tick` (`bornTick`, `expiresTick`) or `AtMs` for monotonic
milliseconds since room creation. Browser diagnostics use `AtMs` for
`performance.now()` instead.

[OnlineSession](../../frontend/src/apps/match/session.ts) predicts at the authority's
fixed step. Inputs carry a sequence and life identifier, never authoritative
positions or damage results.

The server neutralizes silent input after 30 ticks and uses a 600-tick disconnect
threshold. The client stops advancing gameplay when its latest received state is
at least 500 ms old. Focus loss and menu suspension release local controls.

## Prediction and reconciliation

[Prediction](../../frontend/src/prediction/model.ts) reconciles by restoring the
authoritative simulation state and random seed, discarding acknowledged commands,
and replaying the remainder.

Life, status, and round changes clear incompatible commands; at most 60 remain
pending. Remote contact prediction adjusts only the local body.

Keep movement, recoil, collision, equipment state, and tuning compatible across
[Go core](../../backend/core/simulation.go) and
[TypeScript core](../../frontend/src/core/simulation.ts).

## Remote presentation and hit validation

Remote players use a default 100 ms playback delay. Playback adjusts speed as
samples arrive and clamps to history without extrapolation. Membership follows
the latest authority; old samples cannot resurrect disconnected players or
interpolate through respawns. Items and projectiles also use motion anchors.

SMG, Shotgun, Dual Machine Gun, Chain Gun, and Sniper Rifle support server-side
lag compensation. Shots may identify the rendered view by round, snapshot ticks,
and interpolation fraction. The server validates it against its history within a
250 ms rewind bound, falling back to current bodies for invalid or unavailable
history. Client positions and wall-clock timestamps are not accepted. See
[lag_compensation.go](../../backend/server/match/lag_compensation.go).

## Installation, state, and events

| Delivery      | Meaning                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Installation  | Welcome, map change, or resynchronization baseline; establishes a generation and state/event boundary. |
| State         | Replaceable checkpoint; supersedes older unsent state.                                                 |
| Events        | Ordered records retained until acknowledged or the peer terminates.                                    |
| Cues          | Presentation information that may be dropped when stale.                                               |
| Control/probe | Lifecycle, administration, and timing messages with reserved capacity.                                 |

[Replication](../../backend/server/replication/delivery.go) selects work when a
writer is ready, avoiding a FIFO of encoded state frames. Shared groups are encoded
per capture; recipient selection adds the local checkpoint and required metadata
and entity changes. The roster is global, independent of camera visibility.

Scores and ranking normally update at most every 250 ms. Metadata, rules, or phase
transitions can require an immediate coherent update. See
[state selection](../../backend/server/replication/state.go).

Socket writes do **not** establish browser receipt. Application receipts carry
connection, sequence, generation, and event progress to release retained data and
credit in order, including across installations and resynchronization. The client
batches receipts with a 25 ms flush timer; installations can flush immediately.

## Encoding and compatibility

State deliveries use [binary protobuf](../../protocol/snapshot.proto); other
envelopes and client messages use JSON. Generated bindings live in
`backend/server/wire/pb/` and `frontend/src/network/generated/`. Precision is controlled in
[Go](../../backend/server/wire/precision.go) and
[TypeScript](../../frontend/src/network/precision.ts); remote wire state and the
local replay checkpoint have different requirements.

WebSocket compression is negotiated without context takeover, independently of
field selection and protobuf encoding.

The gameplay protocol is defined in
[Go](../../backend/gameconfig/protocol.go) and
[TypeScript](../../frontend/src/contracts/session.ts). The published
[compatibility descriptor](../../backend/compatibility/current.go) also includes
publication, API, identity, content-schema versions, and a tuning-derived profile.
The profile detects accidental mismatch; it does not establish server trust.
Rebuild matching components after contract or tuning changes; run
`make generate-protocol` after schema edits.

## Congestion and recovery

[Replication limits](../../backend/server/replication/limits.go) bound per-peer
memory, outstanding frames, required events, and retention age. Controls reserve
capacity within the same delivery window. Slow peers cannot block simulation.

Excess receipt delay above a peer's best RTT reduces state pacing to 20 or 10 Hz;
recovery gradually restores the base cadence. Exceeding required-delivery limits
terminates the peer. See
[timing](../../backend/server/replication/timing.go) and
[congestion handling](../../backend/server/replication/congestion.go).

The [browser connection](../../frontend/src/network/connection.ts) stops ordinary
sends above 16 KiB of outbound `bufferedAmount`, resynchronizes when capacity
returns, and closes after five seconds of sustained blockage. Resynchronization
installs a fresh baseline.

## Verification and measurement

See [development checks](../development/DEVELOPMENT.md#verification) for parity,
client, Go, and browser tests. Network changes span `match`, `wire`, `replication`,
and `transport`.

`make measure-compression` measures snapshot encoding/compression work;
`make measure-replication` runs the replication harness in `benchmarks/`. Preserve
the commit, scenario, population, cadence, compression negotiation, and raw results
when comparing changes. Distinguish payload from transport bytes, capture from
delivery, and writes from receipt. Measure state age, corrections, interpolation
starvation, and frame time alongside bandwidth.
