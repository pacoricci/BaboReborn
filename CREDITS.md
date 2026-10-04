# Credits

Keep the published [Credits page](frontend/src/apps/credits/credits.html)
(`/credits.html`) in sync when changing assets.

## Code and gameplay reference

Original BaboReborn code is licensed under [GPL-3.0-or-later](LICENSE).
Third-party materials retain their copyright notices and licenses, including
any restrictions to a specific GPL version.

[Daivuk/BaboViolent2](https://github.com/Daivuk/BaboViolent2/tree/20acde0961966f36e14caaa680792bad5013992c),
revision `20acde0961966f36e14caaa680792bad5013992c`, is the gameplay reference.
`src/Game/PlayerUpdate.cpp`, `MapRender.cpp`, and `Weapon.cpp` carry
**Copyright 2012 bitHeads inc.**, under **GPL-3.0-or-later**.
The [original notice](frontend/public/licenses/BaboViolent2.txt) ships with the browser assets.

| Original source    | BaboReborn adaptation                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlayerUpdate.cpp` | Movement integration, friction, acceleration, speed cap and aim ordering in [TypeScript simulation](frontend/src/core/simulation.ts) and [Go simulation](backend/core/simulation.go). |
| `MapRender.cpp`    | Grid collision response, clipping and embedded-cell recovery in [TypeScript grid](frontend/src/core/grid.ts) and [Go grid](backend/core/grid.go).                                     |
| `Weapon.cpp`       | Firing, spread and recoil behavior in the simulation modules above and [TypeScript weapons](frontend/src/core/weapons.ts) / [Go weapons](backend/core/weapons.go).                    |

These Go/TypeScript adaptations modify the original logic. The
[movement reference fixture](frontend/tests/fixtures/movement-reference.json)
records source ranges and analytic expectations, not original-game replays.
The code license does not establish redistribution rights for the original game's media.

## Original assets

Copyright 2026 FromBlueToGreen and BaboReborn contributors. Licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); credit
“BaboReborn contributors”.

This covers maps, themes, skins and decals in `content/`, and models,
textures, equipment images, lobby background, favicon, core sound effects and
music in `frontend/public/`. They were created for BaboReborn and are not
derived from BaboViolent media. Third-party materials below are excluded.

## Icons

- [HUD icon sources and authors](frontend/public/icons/README.md): Shotgun rounds
  by Delapouite; Grenade and Molotov by Lorc, from Game-icons.net, **CC BY 3.0**.
  Unmodified SVGs, also attributed in the published Credits page.
- Tabler's filled `flag-2`, by Paweł Kuna: [MIT notice](frontend/public/icons/Tabler-LICENSE.txt).
  The SVG is unmodified; team colors are applied through a CSS mask.

## Fonts

[Font sources](frontend/public/fonts/README.md), all under SIL Open Font License 1.1:

- Anton: [copyright and license](frontend/public/fonts/Anton-OFL.txt).
- Barlow Condensed: [copyright and license](frontend/public/fonts/BarlowCondensed-OFL.txt).
- Oxanium: [copyright and license](frontend/public/fonts/Oxanium-OFL.txt).

## Sound effects and music

Core sound effects in `frontend/public/audio/*.wav` and
`frontend/public/audio/music.ogg` are [original assets](#original-assets).

Additional effects in `frontend/public/audio/coverage/` use CC0:

- [Per-file authors and sources](frontend/public/audio/coverage/CREDITS.md).
- [CC0-1.0 text](frontend/public/audio/coverage/CC0-1.0.txt).
- [Source manifest and hashes](devtools/assets/audio/sources.json) and
  [processing script](devtools/assets/audio/build.py).

## Names

BaboReborn is not affiliated with RndLabs. BaboViolent is a trademark of its
respective owners.
