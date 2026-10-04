# Contributing to BaboReborn

Use BaboViolent as the gameplay reference. Prioritize responsive controls,
smooth play, multiplayer stability, and readable action. Keep art worn, urban,
and cyberpunk, and interfaces minimal.

## Before you start

Check for related issues and pull requests. For substantial features or refactors,
open an issue with the problem, approach, alternatives, and tradeoffs in effort
and maintenance. Small fixes can go straight to a pull request.

## Run the project

Follow the [development guide](docs/development/DEVELOPMENT.md) for prerequisites,
startup, rebuilds, and troubleshooting:

```sh
make setup
make dev
```

## Prepare a change

- Keep pull requests focused and implementations small, with clear ownership.
- Update callers, contracts, fixtures, and documentation together; remove
  superseded code.
- Edit sources and regenerate derived output.
- Explain non-obvious decisions in concise comments.

See [architecture](docs/architecture/README.md) for module ownership and
[contracts and generated assets](docs/development/DEVELOPMENT.md#contracts-and-generated-assets)
for changes shared by Go and TypeScript.

## Verify your work

For code changes, run:

```sh
make format
make check
```

`make check` includes browser tests and requires Chromium. Use focused checks
while developing; documentation changes need formatting, link, and accuracy checks.

Add regression tests when they reliably reproduce bugs and protect meaningful behavior.
Verify visible or interactive changes in the browser where practical; include
screenshots or recordings when useful.

Check responsiveness and consistency when changing input, simulation, networking,
or rendering. Support performance claims with comparable before-and-after
measurements, recording the scenario and environment.

Separate automated checks, browser observations, and human playtesting in the PR.
State what remains unverified and include commands and reasons for failed or skipped checks.

## Submit a pull request

Open pull requests to `main` from short-lived branches such as `feature/room-search`;
do not push changes directly to `main`.

Merge requires passing checks and resolved discussions; obtain another
maintainer's review when available. Maintainers squash merge, delete the branch,
and create release tags following the [release guide](docs/development/RELEASING.md).

Describe the problem, resulting behavior, verification, and compatibility implications.

## Report a bug

Include reproduction steps, expected and actual behavior, browser, operating
system, and build or commit. Add relevant match conditions and evidence, removing
credentials and private information.

For performance issues, include the workload and measurements when available.

Report vulnerabilities privately through the [security policy](.github/SECURITY.md).

## Assets and attribution

Document third-party sources and licenses, preserve attribution, and confirm
permission to distribute the materials.

Contributions use the project licenses: [GPL-3.0-or-later](LICENSE) for code and
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) for original maps,
art, and audio. Third-party code and assets retain their respective notices and
licenses; see [Credits](CREDITS.md).
