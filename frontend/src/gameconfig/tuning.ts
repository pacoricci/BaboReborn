// Gameplay parameters. Edit directly and mirror changes in backend/gameconfig/rules.go.
// npm test checks alignment; no generation step. Units and effects are documented below.

// Player movement and collision.
export const MOVEMENT = {
  // [cells/s^2] Input acceleration per axis; diagonal input accelerates faster before the speed cap. Range: 0..unbounded.
  acceleration: 12.5,
  // [cells/s^2] Constant speed loss per second when integrating motion; higher values stop sliding sooner. Range: 0..unbounded.
  friction: 4,
  // [cells/s] Speed cap after controls, firing recoil and throwing impulse. Range: 0.001..unbounded.
  maxSpeed: 3.25,
  // [cells] Player collision sphere radius; also its center height. Revalidate map clearance and art when changing. Range: 0.001..0.49.
  radius: 0.25,
  // [ratio] Fraction of velocity retained with reversed sign after player collisions. Range: 0..1.
  bounce: 0.45,
  // [cells] Extra gap from grid walls after collision resolution. Range: 0..unbounded.
  clearance: 0.05,
  // [cells] Extra separation beyond two player radii when resolving player contacts. Range: 0..unbounded.
  contactGap: 0.01,
} as const;

// Submachine gun, the default primary.
export const SMG = {
  // [s] Delay added after each SMG shot; lower means faster fire. Range: 1e-06..unbounded.
  fireIntervalSeconds: 0.1,
  // [s] Delay before primary fire after spawning or swapping either primary. Range: 0..unbounded.
  equipDelaySeconds: 1,
  // [HP] Damage per unshielded SMG hit. Range: 0..unbounded.
  damage: 10,
  // [cells/s] Backward velocity impulse per SMG shot. Range: 0..unbounded.
  recoil: 0.5,
  // [degrees] Minimum SMG angular deviation after recovery. Range: 0..unbounded.
  minSpreadDegrees: 1,
  // [degrees] Maximum accumulated SMG spread. Range: 0..89.
  maxSpreadDegrees: 8,
  // [degrees] Spread added before sampling each SMG shot. Range: 0..unbounded.
  spreadPerShotDegrees: 3,
  // [degrees/s] Spread recovered per second toward minSpreadDegrees. Range: 0..unbounded.
  spreadRecoveryDegreesPerSecond: 10,
  // [cells] Within this 3D distance to the floor aim point, both primaries aim from player center. Range: 0..unbounded.
  closeAimDistance: 1.5,
  // [ratio] Vertical deviation multiplier for both primaries; lower values flatten the spread. Range: 0..unbounded.
  verticalSpreadScale: 0.5,
} as const;

// SMG muzzle offsets.
export const SMG_MUZZLE = {
  // [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
  forward: 0.39787338256835936,
  // [cells] Muzzle offset to the right. Range: 0..unbounded.
  right: 0.16505887985229492,
  // [cells] Muzzle height above the floor. Range: 0..unbounded.
  height: 0.2486686134338379,
} as const;

// Shotgun primary.
export const SHOTGUN = {
  // [count] Number of rays per shot, centered symmetrically around aim. Range: 1..64 (integer).
  pellets: 5,
  // [degrees] Angle between neighboring pellet rays before random deviation. Range: 0..89.
  pelletAngleDegrees: 5,
  // [degrees] Random angular deviation per pellet. Range: 0..89.
  spreadDegrees: 3.5,
  // [cells] Range numerator divided by off-axis sine and direction length; not a fixed maximum range. Range: 1e-06..unbounded.
  rangeScale: 0.35,
  // [HP] Damage per unshielded pellet. Range: 0..unbounded.
  damage: 21,
  // [cells/s] Backward velocity impulse once per shell. Range: 0..unbounded.
  recoil: 3,
  // [count] Shells fired before the automatic full reload. Range: 1..1000 (integer).
  shells: 6,
  // [s] Cooldown after the last shell; spent-shell counter resets when it expires. Range: 1e-06..unbounded.
  reloadSeconds: 3,
  // [s] Cooldown between non-final shells. Range: 1e-06..unbounded.
  fireIntervalSeconds: 0.85,
  // [cells] Shotgun forward muzzle offset; shared muzzle height comes from smgMuzzle. Range: 0..unbounded.
  muzzleForward: 0.5478733825683594,
  // [cells] Shotgun right muzzle offset. Range: 0..unbounded.
  muzzleRight: 0.07929281234741212,
} as const;

// Shield secondary.
export const SHIELD = {
  // [s] Secondary cooldown after activation; also prevents primary fire. Range: 0..unbounded.
  cooldownSeconds: 2.5,
  // [s] Initial protection timer at activation. Range: 0..unbounded.
  protectionSeconds: 2,
  // [s] Damage reduction and shield visual remain active only above this timer value; baseline effective duration is about 1.4 s. Range: 0..unbounded.
  inactiveTailSeconds: 0.6,
  // [ratio] Fraction of incoming damage retained while active: 0 blocks all, 1 gives no reduction. Range: 0..1.
  damageMultiplier: 0.5,
} as const;

// Knives secondary.
export const KNIVES = {
  // [s] Secondary cooldown after activation; also prevents primary fire. Range: 0..unbounded.
  cooldownSeconds: 1,
  // [cells] 3D melee damage radius from player center. Range: 1e-06..unbounded.
  radius: 1,
  // [HP] Uniform unshielded damage inside the unobstructed radius. Range: 0..unbounded.
  damage: 60,
  // [s] Duration of the blade animation after activation; presentation only. Range: 1e-06..unbounded.
  visualSeconds: 0.25,
} as const;

// Throwing shared by grenades and molotovs.
export const THROWING = {
  // [s] Shared throwing cooldown; blocks primary fire and another throw. Range: 0..unbounded.
  cooldownSeconds: 1,
  // [cells/s] Forward velocity impulse applied to the thrower. Range: 0..unbounded.
  impulse: 1,
  // [cells] Right-side launch offset; center-to-muzzle ray repairs overlap with cover. Range: 0..unbounded.
  muzzleRight: 0.1513409996032715,
  // [cells] Launch height above floor. Range: 0..unbounded.
  muzzleHeight: 0.21839080810546876,
} as const;

// Grenade.
export const GRENADE = {
  // [count] Grenades granted at each spawn. Range: 0..100 (integer).
  spawnCount: 2,
  // [count] Maximum grenades after automatic pickup. Range: 0..100 (integer).
  maxCarry: 3,
  // [cells/s] Initial horizontal projectile speed. Range: 0..unbounded.
  horizontalSpeed: 5,
  // [cells/s] Initial upward projectile speed. Range: 0..unbounded.
  verticalSpeed: 5,
  // [s] Time from launch to explosion, rounded up to a simulation tick. Range: 1e-06..unbounded.
  fuseSeconds: 2,
  // [cells] 3D explosion radius; damage decreases linearly to zero at the edge and cover blocks it. Range: 1e-06..unbounded.
  radius: 3,
  // [HP] Unshielded explosion damage at zero distance; can damage the owner. Range: 0..unbounded.
  damage: 150,
  // [cells] Explosion effect radius sent to rendering; does not set damage reach. Range: 1e-06..unbounded.
  visualRadius: 1.5,
} as const;

// Molotov and its flames.
export const MOLOTOV = {
  // [count] Molotovs granted each spawn; not dropped or replenished by pickups. Range: 0..100 (integer).
  spawnCount: 1,
  // [cells/s] Initial horizontal projectile speed. Range: 0..unbounded.
  horizontalSpeed: 6,
  // [cells/s] Initial upward projectile speed. Range: 0..unbounded.
  verticalSpeed: 2,
  // [s] Maximum intact bottle lifetime. Range: 1e-06..unbounded.
  flightSeconds: 10,
  // [cells] 3D bottle-to-player-center contact distance; excludes owner. Range: 1e-06..unbounded.
  hitRadius: 0.5,
  // [cells] Offset from hit surface before creating or locking fire. Range: 0..unbounded.
  impactClearance: 0.1,
  // [ratio] Velocity retained by the second flame after reflecting a wall impact. Range: 0..1.
  reflectionScale: 0.5,
  // [cells/s] Symmetric random velocity added to each horizontal axis of the second flame. Range: 0..unbounded.
  scatterHorizontal: 1,
  // [cells/s] Random upward velocity added to the second flame. Range: 0..unbounded.
  scatterVertical: 1,
  // [s] Lifetime of each flame from creation. Range: 1e-06..unbounded.
  flameSeconds: 10,
  // [s] Time between fire damage pulses, including the first delay; reference is 20 updates at 30 Hz (80 ticks at 120 Hz). Range: 1e-06..unbounded.
  damageIntervalSeconds: 0.6666666666666666,
  // [cells] Fire pulse radius with linear falloff and cover occlusion. Range: 1e-06..unbounded.
  damageRadius: 0.5,
  // [HP] Unshielded damage per flame pulse at zero distance. Range: 0..unbounded.
  damage: 15,
  // [cells] Distance at which a flame attaches to a living player. Range: 1e-06..unbounded.
  attachRadius: 0.75,
  // [s] Duration of a single attachment before detaching. Range: 1e-06..unbounded.
  attachSeconds: 3,
  // [s] Delay before a detached flame may attach again. Range: 0..unbounded.
  reattachDelaySeconds: 1,
  // [s] Owner cannot acquire a newly created flame during this initial interval. Range: 0..unbounded.
  ownerGraceSeconds: 0.5,
} as const;

// Projectile and dropped-item flight.
export const FLIGHT = {
  // [cells/s^2] Downward acceleration. Range: 0..unbounded.
  gravity: 9.8,
  // [ratio] Velocity retained after a bouncing projectile hits a surface. Range: 0..1.
  bounceRetention: 0.65,
  // [cells/s] Bouncing entities at or below this speed can stop near the floor. Range: 0..unbounded.
  restSpeed: 0.5,
  // [cells] Maximum height at which a slow bouncing entity stops. Range: 0..unbounded.
  restHeight: 0.2,
  // [cells] Small offset along the impact normal; also used to repair primary and throwing muzzles. Range: 0..unbounded.
  surfaceClearance: 0.01,
  // [1/(cells/s)] Multiply/truncate/divide factor for dropped-item and scattered-flame velocities; 10 gives steps of 0.1 cells/s. Range: 1e-06..unbounded.
  velocityQuantization: 10,
} as const;

// Player health.
export const PLAYER = {
  // [HP] Health at spawn and maximum after healing. Range: 1e-06..unbounded.
  maxHealth: 100,
} as const;

// Pickups and death drops.
export const PICKUPS = {
  // [count] World items up to which death drops are guaranteed; probability then falls linearly to zero at maxItems. Range: 0..maxItems-1 (integer).
  guaranteedDropItems: 20,
  // [count] Maximum world items created by death drops; weapon swaps replace an existing item. Range: guaranteedDropItems+1..unbounded (integer).
  maxItems: 50,
  // [cells] Horizontal distance for automatic pickups or manual primary swap. Range: 1e-06..unbounded.
  radius: 0.5,
  // [HP] Health restored by a medikit, capped at player.maxHealth. Range: 0..unbounded.
  healthRestore: 50,
  // [s] Dropped primary lifetime, including a primary replaced by a swap. Range: 1e-06..unbounded.
  weaponSeconds: 30,
  // [s] Dropped single-grenade lifetime. Range: 1e-06..unbounded.
  grenadeSeconds: 25,
  // [s] Dropped medikit lifetime. Range: 1e-06..unbounded.
  healthSeconds: 20,
  // [cells/s] Initial randomized item ejection speed. Range: 0..unbounded.
  dropSpeed: 3,
  // [ratio] Fraction of player horizontal velocity inherited by dropped items. Range: 0..unbounded.
  inheritedVelocity: 0.25,
  // [degrees] Maximum absolute ejection tilt from vertical. Range: 0..90.
  dropTiltDegrees: 45,
} as const;

// Round rules and spawn protection.
export const DEATHMATCH = {
  // [points] Score needed to end the round; zero disables the score limit. Range: 0..unbounded (integer).
  scoreLimit: 50,
  // [s] Round duration; zero disables the time limit. Range: 0..unbounded.
  timeLimitSeconds: 1800,
  // [s] Minimum wait after death before respawning. Range: 0..unbounded.
  respawnSeconds: 1,
  // [s] Intermission duration before the next round. Range: 1e-06..unbounded.
  endSeconds: 10,
  // [boolean] Automatically respawn once eligible; otherwise the player requests it.
  forceRespawn: false,
  // [s] Initial spawn immunity timer; actual immunity excludes spawnInactiveTailSeconds. Range: 0..unbounded.
  spawnProtectionSeconds: 2,
  // [s] Final inactive part of spawn immunity; baseline effective immunity is 1.7 seconds. Range: 0..unbounded.
  spawnInactiveTailSeconds: 0.3,
  // [s] Both players must be older than this before player contact resolution. Range: 0..unbounded.
  contactDelaySeconds: 3,
} as const;

// Gameplay and spectator camera.
export const CAMERA = {
  // [cells] Alive/dead camera height. Range: 1e-06..unbounded.
  height: 7,
  // [radians] Vertical field of view; baseline is pi/3. Range: 1e-06..3.13.
  verticalFovRadians: 1.0471975511965976,
  // [ratio] Fixed projection aspect from the reference full viewport. Range: 1e-06..unbounded.
  aspect: 1.333,
  // [cells] Near clipping plane. Range: 1e-06..unbounded.
  near: 1,
  // [cells] Far clipping plane. Range: 1e-06..unbounded.
  far: 50,
  // [1/s] Linear follow coefficient applied each frame; not exponential smoothing. Range: 0..unbounded.
  follow: 2.5,
  // [ratio] Player contribution divided by the sum of player and aim weights. Range: 0..unbounded.
  playerWeight: 5,
  // [ratio] Floor aim contribution divided by the sum of player and aim weights. Range: 0..unbounded.
  aimWeight: 4,
  // [cells] Camera target horizontal map-edge inset. Range: 0..unbounded.
  marginX: 5,
  // [cells] Camera target vertical map-edge inset. Range: 0..unbounded.
  marginY: 4,
  // [cells] Spectator base height before zoom. Range: 1e-06..unbounded.
  spectatorHeight: 14,
  // [cells/s] Spectator target movement speed. Range: 0..unbounded.
  spectatorSpeed: 10,
  // [cells/input-unit] Spectator height change per wheel delta unit. Range: 0..unbounded.
  zoomScale: 0.01,
  // [cells] Minimum spectator zoom offset. Range: -1000..unbounded.
  minZoom: -8,
} as const;

// Extended Pro + Minibot catalog: seconds, HP, cells, degrees and velocity impulses.
export const DUAL = {
  // [cells] Muzzle offset to the right; negative values place it on the left. Range: -unbounded..unbounded.
  muzzleRight: -0.22430870056152344,
  // [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
  muzzleForward: 0.39787338256835936,
  // [cells] Muzzle height above the floor. Range: 0..unbounded.
  muzzleHeight: 0.2531485366821289,
  // [cells] Second barrel offset to the right; firing alternates between barrels. Range: -unbounded..unbounded.
  muzzleRight2: 0.22429021835327148,
  // [cells] Second barrel offset along the facing direction. Range: 0..unbounded.
  muzzleForward2: 0.39787338256835936,
  // [cells] Second barrel height above the floor. Range: 0..unbounded.
  muzzleHeight2: 0.2486686134338379,

  // [s] Delay added after each Dual Machine Gun shot; lower means faster fire. Range: 1e-06..unbounded.
  fireIntervalSeconds: 0.1,
  // [HP] Damage per unshielded Dual Machine Gun hit. Range: 0..unbounded.
  damage: 14,
  // [cells/s] Backward velocity impulse per Dual Machine Gun shot. Range: 0..unbounded.
  recoil: 0.8,
  // [degrees] Minimum angular deviation after recovery; must not exceed maxSpreadDegrees. Range: 0..89.
  minSpreadDegrees: 2,
  // [degrees] Maximum accumulated spread; must not be below minSpreadDegrees. Range: 0..89.
  maxSpreadDegrees: 10,
} as const;
export const CHAIN = {
  // [cells] Rightmost barrel anchor; the other three offsets derive from this position. Range: -unbounded..unbounded.
  muzzleRight: 0.30159927368164063,
  // [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
  muzzleForward: 0.39787338256835936,
  // [cells] Barrel anchor height above the floor; rotating barrels add vertical offsets. Range: 0..unbounded.
  muzzleHeight: 0.2486686134338379,

  // [s] Delay added after each Chain Gun shot; lower means faster fire. Range: 1e-06..unbounded.
  fireIntervalSeconds: 0.1,
  // [HP] Damage per unshielded Chain Gun hit. Range: 0..unbounded.
  damage: 16,
  // [cells/s] Backward velocity impulse per Chain Gun shot. Range: 0..unbounded.
  recoil: 2,
  // [degrees] Minimum angular deviation after recovery; must not exceed maxSpreadDegrees. Range: 0..89.
  minSpreadDegrees: 5,
  // [degrees] Maximum accumulated spread; must not be below minSpreadDegrees. Range: 0..89.
  maxSpreadDegrees: 15,
  // [ratio] Remaining heat reserve consumed per shot; exhausting the reserve blocks firing. Range: 0..1.
  heatPerShot: 0.052,
  // [1/s] Heat reserve restored per second, including while firing; reserve is capped at 1. Range: 0..unbounded.
  recovery: 0.25,
  // [ratio] Overheat clears only when the remaining reserve exceeds this threshold. Range: 0..<1.
  resumeAbove: 0.5,
  // [cells/s] Speed below which spread is divided by precisionDivisor. Range: 0..unbounded.
  precisionSpeed: 1.15,
  // [ratio] Divisor applied to low-speed spread; values above 1 improve precision. Range: 1e-06..unbounded.
  precisionDivisor: 2.7,
} as const;
export const SNIPER = {
  // [cells] Muzzle offset to the right; negative values place it on the left. Range: -unbounded..unbounded.
  muzzleRight: 0.12225322723388672,
  // [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
  muzzleForward: 0.6327515029907227,
  // [cells] Muzzle height above the floor. Range: 0..unbounded.
  muzzleHeight: 0.2486686134338379,

  // [s] Delay added after each Sniper Rifle shot; lower means faster fire. Range: 1e-06..unbounded.
  fireIntervalSeconds: 2,
  // [HP] Damage per unshielded ray; one shot applies normalRays or scopedRays rays. Range: 0..unbounded.
  damage: 34,
  // [cells/s] Backward velocity impulse per Sniper Rifle shot. Range: 0..unbounded.
  recoil: 3,
  // [count] Coincident damage rays below scopeThreshold. Range: 1..unbounded (integer).
  normalRays: 2,
  // [count] Coincident damage rays at or above scopeThreshold. Range: 1..unbounded (integer).
  scopedRays: 3,
  // [cells] Scope height that enables scopedRays; keep within minHeight..maxHeight. Range: 0..unbounded.
  scopeThreshold: 10,
  // [cells] Minimum scope height; must not exceed maxHeight. Range: 1e-06..unbounded.
  minHeight: 5,
  // [cells] Maximum scope height; must not be below minHeight. Range: 1e-06..unbounded.
  maxHeight: 12,
  // [ratio] Aim distance multiplier used to choose a clamped target scope height. Range: 0..unbounded.
  aimScale: 2,
  // [1/s] Linear scope-height follow coefficient; each step is capped at full convergence. Range: 0..unbounded.
  follow: 2.5,
} as const;
export const BAZOOKA = {
  // [cells] Muzzle offset to the right; negative values place it on the left. Range: -unbounded..unbounded.
  muzzleRight: 0.17580467224121094,
  // [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
  muzzleForward: 0.4,
  // [cells] Muzzle height above the floor. Range: 0..unbounded.
  muzzleHeight: 0.4197410202026367,

  // [s] Delay added after each Bazooka shot; lower means faster fire. Range: 1e-06..unbounded.
  fireIntervalSeconds: 1.75,
  // [HP] Peak explosion damage before distance falloff, cover and protection. Range: 0..unbounded.
  damage: 85,
  // [cells/s] Backward velocity impulse per Bazooka shot. Range: 0..unbounded.
  recoil: 3,
  // [cells/s] Rocket launch speed; must not exceed maxSpeed. Range: 1e-06..unbounded.
  speed: 2.5,
  // [cells/s] Rocket speed cap applied before movement. Range: 1e-06..unbounded.
  maxSpeed: 10,
  // [1/s] Rocket velocity grows by 1 + acceleration * dt after movement. Range: 0..unbounded.
  acceleration: 3,
  // [s] Minimum rocket age before the fire input can request remote detonation. Range: 0..unbounded.
  remoteDelaySeconds: 0.25,
  // [cells] Explosion radius for distance falloff and cover checks. Range: 1e-06..unbounded.
  radius: 2,
  // [s] Maximum rocket lifetime before forced detonation; bounds entity persistence. Range: 1e-06..unbounded.
  lifetimeSeconds: 20,
} as const;
export const PHOTON = {
  // [cells] Muzzle offset to the right; negative values place it on the left. Range: -unbounded..unbounded.
  muzzleRight: 0.14311842918395998,
  // [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
  muzzleForward: 0.2884313201904297,
  // [cells] Muzzle height above the floor. Range: 0..unbounded.
  muzzleHeight: 0.2502646064758301,

  // [s] Delay added after each Photon Rifle shot; lower means faster fire. Range: 1e-06..unbounded.
  fireIntervalSeconds: 1.5,
  // [HP] Initial beam damage before the distance curve; persistent pulses scale this value. Range: 0..unbounded.
  damage: 24,
  // [cells/s] Backward velocity impulse per Photon Rifle shot. Range: 0..unbounded.
  recoil: 5,
  // [s] Fire-input time needed to charge; releasing fire preserves accumulated charge. Range: 0..unbounded.
  chargeSeconds: 0.5,
  // [s] Persistent beam lifetime after the initial hit. Range: 1e-06..unbounded.
  durationSeconds: 1,
  // [s] Time between persistent beam damage pulses. Range: 1e-06..unbounded.
  pulseIntervalSeconds: 0.1,
  // [ratio] Persistent pulse damage multiplier relative to the initial beam damage. Range: 0..unbounded.
  pulseMultiplier: 0.5,
  // [cells] Target collision radius used by persistent beam pulses. Range: 1e-06..unbounded.
  pulseRadius: 0.35,
  // [ratio] Far-distance floor of the damage multiplier before adding the arctangent term. Range: 0..unbounded.
  verticalShift: 0.5,
  // [ratio] Scale of the arctangent contribution to the distance damage multiplier. Range: 0..unbounded.
  coefficient: 0.65,
  // [cells] Distance at the midpoint of the arctangent damage transition. Range: 0..unbounded.
  horizontalShift: 2,
  // [1/cells] Steepness of the arctangent damage transition; larger values sharpen falloff. Range: 0..unbounded.
  distanceMultiplier: 0.65,
} as const;
export const FLAMETHROWER = {
  // [cells] Muzzle offset to the right; negative values place it on the left. Range: -unbounded..unbounded.
  muzzleRight: 0.1955849838256836,
  // [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
  muzzleForward: 0.34907398223876956,
  // [cells] Muzzle height above the floor. Range: 0..unbounded.
  muzzleHeight: 0.24853231430053713,

  // [s] Delay added after each Flamethrower shot; lower means faster fire. Range: 1e-06..unbounded.
  fireIntervalSeconds: 0.1,
  // [HP] Damage per hit before linear distance falloff and protection. Range: 0..unbounded.
  damage: 6.5,
  // [cells/s] Backward velocity impulse per Flamethrower shot. Range: 0..unbounded.
  recoil: 0,
  // [degrees] Fixed angular deviation of each flame shot. Range: 0..89.
  spreadDegrees: 10,
  // [cells] Initial flame reach and distance-damage falloff scale; at least minRange. Range: 1e-06..unbounded.
  maxRange: 8,
  // [cells] Lower bound on reach as continuous fire shortens the flame; at most maxRange. Range: 0..unbounded.
  minRange: 1,
  // [s] Continuous-fire time scale for linear reach decay, clamped to minRange. Range: 1e-06..unbounded.
  expirationSeconds: 1.5,
  // [s] Gap since the last shot that restores full reach; keep above fireIntervalSeconds. Range: 1e-06..unbounded.
  resetGapSeconds: 0.15,
  // [cells] Target collision radius for flame hits. Range: 1e-06..unbounded.
  hitRadius: 0.5,
} as const;
export const MINIBOT = {
  // [degrees] Fixed angular deviation of each turret shot. Range: 0..89.
  spreadDegrees: 10,
  // [cells] Turret muzzle offset to the right of its aim direction. Range: -unbounded..unbounded.
  muzzleRight: 0.1,
  // [cells] Turret ray length; keep at least as large as the target search radius. Range: 1e-06..unbounded.
  shotRange: 10,
  // [s] Primary and secondary action lock after deployment; only one owned turret persists. Range: 1e-06..unbounded.
  cooldownSeconds: 1,
  // [s] Turret lifetime after deployment; owner death also removes it. Range: 1e-06..unbounded.
  lifetimeSeconds: 5,
  // [cells] Search radius for the nearest visible target. Range: 1e-06..unbounded.
  radius: 6,
  // [s] Delay between turret shots after the first immediate shot. Range: 1e-06..unbounded.
  fireIntervalSeconds: 0.25,
  // [HP] Damage per unshielded turret hit. Range: 0..unbounded.
  damage: 5,
  // [cells] Deployment offset along the owner aim; obstructed placement is rejected. Range: 0..unbounded.
  spawnOffset: 1,
  // [cells] Turret position and firing height above the floor. Range: 0..unbounded.
  height: 0.15,
} as const;
