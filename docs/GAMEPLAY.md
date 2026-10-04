# Gameplay

BaboViolent is the gameplay reference. Room settings control match limits,
respawns, and map rotation.

## Controls

[Default bindings](../frontend/src/player/game-options.ts) are configurable in
settings and applied by the [input adapter](../frontend/src/apps/match/input.ts).

| Action                                   | Default               |
| ---------------------------------------- | --------------------- |
| Move                                     | W/A/S/D or arrow keys |
| Aim                                      | Mouse pointer         |
| Primary fire / request respawn when dead | Left mouse            |
| Secondary                                | Space                 |
| Grenade                                  | Right mouse           |
| Molotov                                  | Middle mouse          |
| Swap to nearby dropped primary           | F                     |
| Show scoreboard                          | Hold Tab              |
| Open/close match menu                    | Escape or M           |
| Help                                     | H                     |

Focus loss and the match menu release controls without pausing the online match.
Equipment selection applies at the next spawn; dropped primaries allow immediate swaps.

## Modes and rounds

| Mode                   | Scoring and objective                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Deathmatch (DM)        | Opponent kill +1, suicide -1.                                                         |
| Team Deathmatch (TDM)  | DM scoring also applies to the team.                                                  |
| Capture the Flag (CTF) | Captures award individual and team points; kills are recorded without scoring points. |

Teams are balanced on first participation and preserved across respawns and map
changes, without forced transfers. Friendly fire is disabled; self-damage remains possible.

CTF maps require both bases and team spawns. Touch the enemy flag to carry it, then
reach your base with your own flag home to capture. Touch your dropped flag to
return it. Death drops a carried flag; carrying preserves movement and weapons.
See [mode rules](../backend/server/match/modes.go).

Rooms configure mode, score/time limits, respawn delay, forced respawn, capacity,
bots, and map rotation. A zero score/time limit disables it.

Either enabled limit ends the round without overtime. Intermission freezes
standings; the next round advances rotation and resets scores and entities. See
[round lifecycle](../backend/server/match/match.go).

## Equipment

Choose one primary and one secondary.

| Primary          | Behavior                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| SMG              | Automatic fire; sustained shots widen spread, pauses restore accuracy.                                                     |
| Shotgun          | Five pellets per shot; a full reload after six shells.                                                                     |
| Dual Machine Gun | Alternating barrels; stronger recoil than the SMG.                                                                         |
| Chain Gun        | Sustained fire builds heat; release to cool. Slow movement improves accuracy.                                              |
| Sniper Rifle     | Aim farther away to scope for extra damage.                                                                                |
| Bazooka          | Accelerating rocket; fire again after the remote-delay threshold to detonate, or hold fire. Explosions can hurt the owner. |
| Photon Rifle     | Hold fire to charge a damaging beam; releasing pauses charge.                                                              |
| Flamethrower     | Sustained fire reduces reach; pauses restore it.                                                                           |

| Secondary | Behavior                                                           |
| --------- | ------------------------------------------------------------------ |
| Knives    | Melee damage within an unobstructed radius.                        |
| Shield    | Temporary damage reduction.                                        |
| Minibot   | One stationary turret placed toward the aim, lasting five seconds. |

Firing, secondary activation, and throws interact through cooldowns. Grenades
bounce and have a timed fuse; Molotovs create fire that can attach to players.

Players spawn with 100 health, two grenades, and one Molotov. Nearby health and
grenade pickups are automatic, capped at maximum health and three grenades.
Molotovs have no refill pickup. Spawn protection has an inactive timer tail;
a positive timer alone does not imply protection.

## Sources and changes

- [Go rules](../backend/gameconfig/rules.go) and
  [TypeScript tuning](../frontend/src/gameconfig/tuning.ts): numerical balance,
  units, limits, and timer semantics.
- [Core weapons](../backend/core/weapons.go),
  [equipment](../backend/core/equipment.go), and
  [match arsenal](../backend/server/match/arsenal.go): authoritative behavior.
- [Equipment help](../frontend/src/player/equipment-help.ts): player-facing hints.

Update both tuning definitions and relevant hints when mechanics change. Use
[development checks](development/DEVELOPMENT.md#verification) for alignment,
arsenal/mode, parity, and browser coverage. Combat feel, balance, and fidelity to
BaboViolent require human playtests and comparison with the original.
