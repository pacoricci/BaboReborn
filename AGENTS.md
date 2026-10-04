BaboReborn is a multiplayer arena shooter, playable directly in the browser.
Its gameplay is inspired by BaboViolent.

## Goals

- Prioritize responsiveness, smoothness, and stability, balancing
  architectural quality with the experience of playing the game.

## UX, UI, and Art Direction

- Blend a brutal, urban, cyberpunk aesthetic with scratched, dirty,
  and worn surfaces.
- Prefer minimalism in the UI: use few words, avoid redundant
  information, and require every element to justify its presence.

## Implementation

- Aim for small, clear implementations with well-defined responsibilities
  and straightforward control flow.
- For substantial changes, briefly consider alternatives and their
  tradeoffs in effort, complexity, maintenance, and expected benefit.
- Prefer addressing underlying causes. Introduce abstractions,
  dependencies, and special cases when they offer a clear advantage.
- When replacing existing behavior, consider removing obsolete code
  and updating related callers, contracts, and fixtures together.
- Prefer compact comments near the implementation to explain
  non-obvious decisions.
- Group related constants in domain-specific files within their owning module
  (for example, `timing.go` and `limits.go`), with explicit units. Keep unrelated
  categories separate and reuse each definition from its callers.
- Follow the data contract conventions in `docs/architecture/README.md` for
  instants, units, codes, identifiers and storage keys.

## Verification

- Prefer the Makefile for project workflows: `make dev` starts the
  complete local stack; `make check` runs the full quality gate.
- Choose checks proportional to the change, using the relevant unit,
  integration, architecture, parity, and browser tests.
- Consider regression tests for bug fixes when they can reproduce
  the issue reliably and protect meaningful behavior.
- For visible or interactive changes, include browser verification
  where practical.
- Give particular attention to responsiveness and consistency when
  changing input, simulation, networking, or rendering. Use relevant
  measurements to assess performance when appropriate.
- Briefly report what was verified and any remaining uncertainty,
  distinguishing automated checks from browser and human playtesting.
