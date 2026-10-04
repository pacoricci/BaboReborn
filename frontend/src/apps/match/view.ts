import { localMinimapColor } from './minimap-reveals';
import { knifeExtension } from '../../presentation/actors/knife-state';
import type { RemoteState } from '../../contracts/session';
import { CAMERA, cameraTarget } from '../../presentation/camera';
import { SHIELD, KNIVES, PLAYER, PHOTON, SHOTGUN } from '../../gameconfig/tuning';
// Maps online state to presentation data; never supplies simulation authority.
import type { Vec2 } from '../../core/geometry';
import type { ArenaView } from '../../presentation/view';
import type { OnlineSession } from './session';
import { DEFAULT_APPEARANCE } from '../../player/appearance';
import type { Appearance } from '../../player/appearance';
import { TEAM_COLORS, TEAM_SKIN_COLORS } from '../../presentation/actors/team-style';

function playerStyle(teamMode: boolean, team: string | undefined, appearance?: Appearance) {
  if (team !== 'blue' && team !== 'red') return { appearance, marker: undefined };
  // Team modes replace all mask channels, preserving the chosen pattern and saved cosmetics.
  if (teamMode)
    return {
      appearance: {
        template: (appearance ?? DEFAULT_APPEARANCE).template,
        colors: TEAM_SKIN_COLORS[team],
      },
      marker: undefined,
    };
  return { appearance, marker: TEAM_COLORS[team] };
}

function weaponVisual(player: RemoteState) {
  const e = player.equipment;
  return {
    shotAge: e.sinceShot,
    charge: e.charge / PHOTON.chargeSeconds,
    reload:
      e.primary === 'shotgun' && e.shells === SHOTGUN.shells && player.cooldown > 0
        ? 1 - player.cooldown / SHOTGUN.reloadSeconds
        : 0,
  };
}
export class OnlineView {
  private spectatorTarget = { x: 18, y: 18 };
  private spectatorZoom = 0;
  private lastAliveTarget = { x: 18, y: 18 };

  reset(width: number, height: number): void {
    this.spectatorTarget = { x: width / 2, y: height / 2 };
    this.lastAliveTarget = { ...this.spectatorTarget };
    this.spectatorZoom = 0;
  }

  zoom(delta: number, arenaSize: number): void {
    this.spectatorZoom = Math.max(
      CAMERA.minZoom,
      Math.min(arenaSize / 2, this.spectatorZoom + delta * CAMERA.zoomScale),
    );
  }
  compose(
    session: OnlineSession,
    aim: Vec2,
    now: number,
    elapsed: number,
    active: boolean,
    moveX: number,
    moveY: number,
  ): ArenaView {
    const { prediction, interpolation, latest } = session;
    const renderedPlayers = interpolation.players(now, session.welcome.tickHz);
    const teamMode = latest?.match.rules.mode === 'ctf' || latest?.match.rules.mode === 'tdm';
    if (!prediction.player) throw new Error('Online view needs an authoritative player.');
    if (active && prediction.own?.status === 'spectator') {
      this.spectatorTarget.x = Math.max(
        CAMERA.marginX,
        Math.min(
          prediction.welcome.arena.width - CAMERA.marginX,
          this.spectatorTarget.x + moveX * CAMERA.spectatorSpeed * elapsed,
        ),
      );
      this.spectatorTarget.y = Math.max(
        CAMERA.marginY,
        Math.min(
          prediction.welcome.arena.height - CAMERA.marginY,
          this.spectatorTarget.y + moveY * CAMERA.spectatorSpeed * elapsed,
        ),
      );
    }
    if (prediction.own?.status === 'alive')
      this.lastAliveTarget = cameraTarget(
        prediction.player,
        aim,
        prediction.welcome.arena.width,
        prediction.welcome.arena.height,
      );
    const entityTick =
      (latest?.tick ?? 0) +
      (Math.max(0, Math.min(now - session.receivedAt, 100)) * session.welcome.tickHz) / 1000;
    return {
      ...(prediction.own?.status === 'alive' && prediction.player.equipment.primary === 'sniper'
        ? {
            camera: {
              target: {
                x:
                  (prediction.player.x * CAMERA.playerWeight + aim.x * CAMERA.aimWeight) /
                  (CAMERA.playerWeight + CAMERA.aimWeight),
                y:
                  (prediction.player.y * CAMERA.playerWeight + aim.y * CAMERA.aimWeight) /
                  (CAMERA.playerWeight + CAMERA.aimWeight),
              },
              height: prediction.player.equipment.scopeHeight,
            },
          }
        : {}),
      ...(prediction.own?.status === 'dead'
        ? { camera: { target: this.lastAliveTarget, height: CAMERA.height } }
        : {}),
      ...(prediction.own?.status === 'spectator'
        ? {
            camera: {
              target: this.spectatorTarget,
              height: CAMERA.spectatorHeight + this.spectatorZoom,
            },
          }
        : {}),
      objects: [
        ...(latest?.flags ?? []).map((f, index) => {
          const carrier =
            f.carrierId === prediction.own?.id
              ? prediction.player
              : renderedPlayers.find((p) => p.id === f.carrierId)?.state;
          return {
            id: -1 - index,
            kind: `flag-${f.team}`,
            x: carrier?.x ?? f.position.x,
            y: carrier?.y ?? f.position.y,
            z: carrier ? 0.6 : 0.08,
          };
        }),
        ...(latest?.match.rules.mode === 'ctf' && session.welcome.arena.teams
          ? ['blue', 'red'].map((team, index) => {
              const base = session.welcome.arena.teams![team as 'blue' | 'red'].base;
              return { id: -3 - index, kind: `base-${team}`, x: base.x, y: base.y, z: 0.02 };
            })
          : []),
        ...interpolation.items(now, session.welcome.tickHz).map((i) => ({
          id: i.id,
          kind: i.kind === 'weapon' ? i.primary : i.kind,
          ...i.position,
        })),
        ...interpolation.projectiles(now, session.welcome.tickHz).map((p) => {
          // Attached fire follows the same predicted/interpolated pose as its carrier.
          const carrier =
            p.kind === 'flame' && p.attachedId !== 0
              ? p.attachedId === prediction.own?.id && prediction.own.status === 'alive'
                ? prediction.player
                : renderedPlayers.find(
                    (player) => player.id === p.attachedId && player.status === 'alive',
                  )?.state
              : undefined;
          return {
            id: p.id,
            kind: p.kind,
            ...(carrier ? { x: carrier.x, y: carrier.y, z: 0.03 } : p.position),
            angle: Math.atan2(p.velocity.y, p.velocity.x),
            ...(p.kind === 'grenade' || p.kind === 'molotov'
              ? {
                  throwMotion: {
                    age: Math.max(0, (entityTick - p.bornTick) / session.welcome.tickHz),
                    // The simulation zeros velocity when a bouncing grenade comes to rest.
                    moving: p.velocity.x !== 0 || p.velocity.y !== 0 || p.velocity.z !== 0,
                  },
                }
              : {}),
            ...(p.turret
              ? {
                  turret: {
                    angle: p.turret.angle,
                    shotAge:
                      p.turret.lastShotTick > 0
                        ? (entityTick - p.turret.lastShotTick) / session.welcome.tickHz
                        : Infinity,
                  },
                }
              : {}),
          };
        }),
      ],
      player: {
        minimapColor: localMinimapColor(prediction.own?.team),
        nickname: prediction.own?.nickname,
        nicknameColors: prediction.own?.nicknameColors,
        x: prediction.player.x,
        y: prediction.player.y,
        angle: prediction.player.angle,
        ...playerStyle(teamMode, prediction.own?.team, prediction.own?.appearance),
        life: prediction.own?.life,
        primary: prediction.player.equipment.primary,
        weapon: weaponVisual(prediction.player),
        shield: (prediction.player.equipment.protection ?? 0) > SHIELD.inactiveTailSeconds,
        knives:
          prediction.player.equipment.secondary === 'knives'
            ? knifeExtension(prediction.player.equipment.meleeDelay ?? 0, KNIVES.cooldownSeconds)
            : 0,
        visible: prediction.own?.status === 'alive',
      },
      actors: renderedPlayers
        .filter((p) => p.id !== prediction.welcome.id)
        .map((p) => ({
          id: p.id,
          nickname: p.nickname,
          nicknameColors: p.nicknameColors,
          ...playerStyle(teamMode, p.team, p.appearance),
          life: p.life,
          x: p.state.x,
          y: p.state.y,
          angle: p.state.angle,
          visible: p.status === 'alive',
          minimapColor: latest
            ? session.minimapReveals.color(p, prediction.own, latest, now)
            : undefined,
          minimapOpacity: latest
            ? session.minimapReveals.opacity(p, prediction.own, latest, now)
            : 0,
          healthFraction: p.hp / PLAYER.maxHealth,
          hitFlash: false,
          primary: p.state.equipment.primary,
          weapon: weaponVisual(p.state),
          shield: (p.state.equipment.protection ?? 0) > SHIELD.inactiveTailSeconds,
          knives:
            p.state.equipment.secondary === 'knives'
              ? knifeExtension(p.state.equipment.meleeDelay ?? 0, KNIVES.cooldownSeconds)
              : 0,
        })),
    };
  }
}
