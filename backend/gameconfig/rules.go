// Gameplay parameters. Edit directly and mirror changes in frontend/src/gameconfig/tuning.ts.
// npm test checks alignment; no generation step.
package gameconfig

// Player movement and collision.
const (
	// [cells/s^2] Input acceleration per axis; diagonal input accelerates faster before the speed cap. Range: 0..unbounded.
	MovementAcceleration float64 = 12.5
	// [cells/s^2] Constant speed loss per second when integrating motion; higher values stop sliding sooner. Range: 0..unbounded.
	MovementFriction float64 = 4.0
	// [cells/s] Speed cap after controls, firing recoil and throwing impulse. Range: 0.001..unbounded.
	MovementMaxSpeed float64 = 3.25
	// [cells] Player collision sphere radius; also its center height. Revalidate map clearance and art when changing. Range: 0.001..0.49.
	MovementRadius float64 = 0.25
	// [ratio] Fraction of velocity retained with reversed sign after player collisions. Range: 0..1.
	MovementBounce float64 = 0.45
	// [cells] Extra gap from grid walls after collision resolution. Range: 0..unbounded.
	MovementClearance float64 = 0.05
	// [cells] Extra separation beyond two player radii when resolving player contacts. Range: 0..unbounded.
	MovementContactGap float64 = 0.01
)

// Submachine gun, the default primary.
const (
	// [s] Delay added after each SMG shot; lower means faster fire. Range: 1e-06..unbounded.
	SmgFireIntervalSeconds float64 = 0.1
	// [s] Delay before primary fire after spawning or swapping either primary. Range: 0..unbounded.
	SmgEquipDelaySeconds float64 = 1.0
	// [HP] Damage per unshielded SMG hit. Range: 0..unbounded.
	SmgDamage float64 = 10.0
	// [cells/s] Backward velocity impulse per SMG shot. Range: 0..unbounded.
	SmgRecoil float64 = 0.5
	// [degrees] Minimum SMG angular deviation after recovery. Range: 0..unbounded.
	SmgMinSpreadDegrees float64 = 1.0
	// [degrees] Maximum accumulated SMG spread. Range: 0..89.
	SmgMaxSpreadDegrees float64 = 8.0
	// [degrees] Spread added before sampling each SMG shot. Range: 0..unbounded.
	SmgSpreadPerShotDegrees float64 = 3.0
	// [degrees/s] Spread recovered per second toward minSpreadDegrees. Range: 0..unbounded.
	SmgSpreadRecoveryDegreesPerSecond float64 = 10.0
	// [cells] Within this 3D distance to the floor aim point, both primaries aim from player center. Range: 0..unbounded.
	SmgCloseAimDistance float64 = 1.5
	// [ratio] Vertical deviation multiplier for both primaries; lower values flatten the spread. Range: 0..unbounded.
	SmgVerticalSpreadScale float64 = 0.5
)

// SMG muzzle offsets.
const (
	// [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
	SmgMuzzleForward float64 = 0.39787338256835936
	// [cells] Muzzle offset to the right. Range: 0..unbounded.
	SmgMuzzleRight float64 = 0.16505887985229492
	// [cells] Muzzle height above the floor. Range: 0..unbounded.
	SmgMuzzleHeight float64 = 0.2486686134338379
)

// Shotgun primary.
const (
	// [count] Number of rays per shot, centered symmetrically around aim. Range: 1..64 (integer).
	ShotgunPellets int = 5
	// [degrees] Angle between neighboring pellet rays before random deviation. Range: 0..89.
	ShotgunPelletAngleDegrees float64 = 5.0
	// [degrees] Random angular deviation per pellet. Range: 0..89.
	ShotgunSpreadDegrees float64 = 3.5
	// [cells] Range numerator divided by off-axis sine and direction length; not a fixed maximum range. Range: 1e-06..unbounded.
	ShotgunRangeScale float64 = 0.35
	// [HP] Damage per unshielded pellet. Range: 0..unbounded.
	ShotgunDamage float64 = 21.0
	// [cells/s] Backward velocity impulse once per shell. Range: 0..unbounded.
	ShotgunRecoil float64 = 3.0
	// [count] Shells fired before the automatic full reload. Range: 1..1000 (integer).
	ShotgunShells int = 6
	// [s] Cooldown after the last shell; spent-shell counter resets when it expires. Range: 1e-06..unbounded.
	ShotgunReloadSeconds float64 = 3.0
	// [s] Cooldown between non-final shells. Range: 1e-06..unbounded.
	ShotgunFireIntervalSeconds float64 = 0.85
	// [cells] Shotgun forward muzzle offset; shared muzzle height comes from smgMuzzle. Range: 0..unbounded.
	ShotgunMuzzleForward float64 = 0.5478733825683594
	// [cells] Shotgun right muzzle offset. Range: 0..unbounded.
	ShotgunMuzzleRight float64 = 0.07929281234741212
)

// Shield secondary.
const (
	// [s] Secondary cooldown after activation; also prevents primary fire. Range: 0..unbounded.
	ShieldCooldownSeconds float64 = 2.5
	// [s] Initial protection timer at activation. Range: 0..unbounded.
	ShieldProtectionSeconds float64 = 2.0
	// [s] Damage reduction and shield visual remain active only above this timer value; baseline effective duration is about 1.4 s. Range: 0..unbounded.
	ShieldInactiveTailSeconds float64 = 0.6
	// [ratio] Fraction of incoming damage retained while active: 0 blocks all, 1 gives no reduction. Range: 0..1.
	ShieldDamageMultiplier float64 = 0.5
)

// Knives secondary.
const (
	// [s] Secondary cooldown after activation; also prevents primary fire. Range: 0..unbounded.
	KnivesCooldownSeconds float64 = 1.0
	// [cells] 3D melee damage radius from player center. Range: 1e-06..unbounded.
	KnivesRadius float64 = 1.0
	// [HP] Uniform unshielded damage inside the unobstructed radius. Range: 0..unbounded.
	KnivesDamage float64 = 60.0
	// [s] Duration of the blade animation after activation; presentation only. Range: 1e-06..unbounded.
	KnivesVisualSeconds float64 = 0.25
)

// Throwing shared by grenades and molotovs.
const (
	// [s] Shared throwing cooldown; blocks primary fire and another throw. Range: 0..unbounded.
	ThrowingCooldownSeconds float64 = 1.0
	// [cells/s] Forward velocity impulse applied to the thrower. Range: 0..unbounded.
	ThrowingImpulse float64 = 1.0
	// [cells] Right-side launch offset; center-to-muzzle ray repairs overlap with cover. Range: 0..unbounded.
	ThrowingMuzzleRight float64 = 0.1513409996032715
	// [cells] Launch height above floor. Range: 0..unbounded.
	ThrowingMuzzleHeight float64 = 0.21839080810546876
)

// Grenade.
const (
	// [count] Grenades granted at each spawn. Range: 0..100 (integer).
	GrenadeSpawnCount int = 2
	// [count] Maximum grenades after automatic pickup. Range: 0..100 (integer).
	GrenadeMaxCarry int = 3
	// [cells/s] Initial horizontal projectile speed. Range: 0..unbounded.
	GrenadeHorizontalSpeed float64 = 5.0
	// [cells/s] Initial upward projectile speed. Range: 0..unbounded.
	GrenadeVerticalSpeed float64 = 5.0
	// [s] Time from launch to explosion, rounded up to a simulation tick. Range: 1e-06..unbounded.
	GrenadeFuseSeconds float64 = 2.0
	// [cells] 3D explosion radius; damage decreases linearly to zero at the edge and cover blocks it. Range: 1e-06..unbounded.
	GrenadeRadius float64 = 3.0
	// [HP] Unshielded explosion damage at zero distance; can damage the owner. Range: 0..unbounded.
	GrenadeDamage float64 = 150.0
	// [cells] Explosion effect radius sent to rendering; does not set damage reach. Range: 1e-06..unbounded.
	GrenadeVisualRadius float64 = 1.5
)

// Molotov and its flames.
const (
	// [count] Molotovs granted each spawn; not dropped or replenished by pickups. Range: 0..100 (integer).
	MolotovSpawnCount int = 1
	// [cells/s] Initial horizontal projectile speed. Range: 0..unbounded.
	MolotovHorizontalSpeed float64 = 6.0
	// [cells/s] Initial upward projectile speed. Range: 0..unbounded.
	MolotovVerticalSpeed float64 = 2.0
	// [s] Maximum intact bottle lifetime. Range: 1e-06..unbounded.
	MolotovFlightSeconds float64 = 10.0
	// [cells] 3D bottle-to-player-center contact distance; excludes owner. Range: 1e-06..unbounded.
	MolotovHitRadius float64 = 0.5
	// [cells] Offset from hit surface before creating or locking fire. Range: 0..unbounded.
	MolotovImpactClearance float64 = 0.1
	// [ratio] Velocity retained by the second flame after reflecting a wall impact. Range: 0..1.
	MolotovReflectionScale float64 = 0.5
	// [cells/s] Symmetric random velocity added to each horizontal axis of the second flame. Range: 0..unbounded.
	MolotovScatterHorizontal float64 = 1.0
	// [cells/s] Random upward velocity added to the second flame. Range: 0..unbounded.
	MolotovScatterVertical float64 = 1.0
	// [s] Lifetime of each flame from creation. Range: 1e-06..unbounded.
	MolotovFlameSeconds float64 = 10.0
	// [s] Time between fire damage pulses, including the first delay; reference is 20 updates at 30 Hz (80 ticks at 120 Hz). Range: 1e-06..unbounded.
	MolotovDamageIntervalSeconds float64 = 0.6666666666666666
	// [cells] Fire pulse radius with linear falloff and cover occlusion. Range: 1e-06..unbounded.
	MolotovDamageRadius float64 = 0.5
	// [HP] Unshielded damage per flame pulse at zero distance. Range: 0..unbounded.
	MolotovDamage float64 = 15.0
	// [cells] Distance at which a flame attaches to a living player. Range: 1e-06..unbounded.
	MolotovAttachRadius float64 = 0.75
	// [s] Duration of a single attachment before detaching. Range: 1e-06..unbounded.
	MolotovAttachSeconds float64 = 3.0
	// [s] Delay before a detached flame may attach again. Range: 0..unbounded.
	MolotovReattachDelaySeconds float64 = 1.0
	// [s] Owner cannot acquire a newly created flame during this initial interval. Range: 0..unbounded.
	MolotovOwnerGraceSeconds float64 = 0.5
)

// Projectile and dropped-item flight.
const (
	// [cells/s^2] Downward acceleration. Range: 0..unbounded.
	FlightGravity float64 = 9.8
	// [ratio] Velocity retained after a bouncing projectile hits a surface. Range: 0..1.
	FlightBounceRetention float64 = 0.65
	// [cells/s] Bouncing entities at or below this speed can stop near the floor. Range: 0..unbounded.
	FlightRestSpeed float64 = 0.5
	// [cells] Maximum height at which a slow bouncing entity stops. Range: 0..unbounded.
	FlightRestHeight float64 = 0.2
	// [cells] Small offset along the impact normal; also used to repair primary and throwing muzzles. Range: 0..unbounded.
	FlightSurfaceClearance float64 = 0.01
	// [1/(cells/s)] Multiply/truncate/divide factor for dropped-item and scattered-flame velocities; 10 gives steps of 0.1 cells/s. Range: 1e-06..unbounded.
	FlightVelocityQuantization float64 = 10.0
)

// Player health.
const (
	// [HP] Health at spawn and maximum after healing. Range: 1e-06..unbounded.
	PlayerMaxHealth float64 = 100.0
)

// Pickups and death drops.
const (
	// [count] World items up to which death drops are guaranteed; probability then falls linearly to zero at PickupsMaxItems. Range: 0..PickupsMaxItems-1 (integer).
	PickupsGuaranteedDropItems int = 20
	// [count] Maximum world items created by death drops; weapon swaps replace an existing item. Range: PickupsGuaranteedDropItems+1..unbounded (integer).
	PickupsMaxItems int = 50
	// [cells] Horizontal distance for automatic pickups or manual primary swap. Range: 1e-06..unbounded.
	PickupsRadius float64 = 0.5
	// [HP] Health restored by a medikit, capped at player.maxHealth. Range: 0..unbounded.
	PickupsHealthRestore float64 = 50.0
	// [s] Dropped primary lifetime, including a primary replaced by a swap. Range: 1e-06..unbounded.
	PickupsWeaponSeconds float64 = 30.0
	// [s] Dropped single-grenade lifetime. Range: 1e-06..unbounded.
	PickupsGrenadeSeconds float64 = 25.0
	// [s] Dropped medikit lifetime. Range: 1e-06..unbounded.
	PickupsHealthSeconds float64 = 20.0
	// [cells/s] Initial randomized item ejection speed. Range: 0..unbounded.
	PickupsDropSpeed float64 = 3.0
	// [ratio] Fraction of player horizontal velocity inherited by dropped items. Range: 0..unbounded.
	PickupsInheritedVelocity float64 = 0.25
	// [degrees] Maximum absolute ejection tilt from vertical. Range: 0..90.
	PickupsDropTiltDegrees float64 = 45.0
)

// Round rules and spawn protection.
const (
	// [points] Score needed to end the round; zero disables the score limit. Range: 0..unbounded (integer).
	DeathmatchScoreLimit int = 50
	// [s] Round duration; zero disables the time limit. Range: 0..unbounded.
	DeathmatchTimeLimitSeconds float64 = 1800.0
	// [s] Minimum wait after death before respawning. Range: 0..unbounded.
	DeathmatchRespawnSeconds float64 = 1.0
	// [s] Intermission duration before the next round. Range: 1e-06..unbounded.
	DeathmatchEndSeconds float64 = 10.0
	// [boolean] Automatically respawn once eligible; otherwise the player requests it.
	DeathmatchForceRespawn bool = false
	// [s] Initial spawn immunity timer; actual immunity excludes spawnInactiveTailSeconds. Range: 0..unbounded.
	DeathmatchSpawnProtectionSeconds float64 = 2.0
	// [s] Final inactive part of spawn immunity; baseline effective immunity is 1.7 seconds. Range: 0..unbounded.
	DeathmatchSpawnInactiveTailSeconds float64 = 0.3
	// [s] Both players must be older than this before player contact resolution. Range: 0..unbounded.
	DeathmatchContactDelaySeconds float64 = 3.0
)

// Gameplay and spectator camera.
const (
	// [cells] Alive/dead camera height. Range: 1e-06..unbounded.
	CameraHeight float64 = 7.0
	// [radians] Vertical field of view; baseline is pi/3. Range: 1e-06..3.13.
	CameraVerticalFovRadians float64 = 1.0471975511965976
	// [ratio] Fixed projection aspect from the reference full viewport. Range: 1e-06..unbounded.
	CameraAspect float64 = 1.333
	// [cells] Near clipping plane. Range: 1e-06..unbounded.
	CameraNear float64 = 1.0
	// [cells] Far clipping plane. Range: 1e-06..unbounded.
	CameraFar float64 = 50.0
	// [1/s] Linear follow coefficient applied each frame; not exponential smoothing. Range: 0..unbounded.
	CameraFollow float64 = 2.5
	// [ratio] Player contribution divided by the sum of player and aim weights. Range: 0..unbounded.
	CameraPlayerWeight float64 = 5.0
	// [ratio] Floor aim contribution divided by the sum of player and aim weights. Range: 0..unbounded.
	CameraAimWeight float64 = 4.0
	// [cells] Camera target horizontal map-edge inset. Range: 0..unbounded.
	CameraMarginX float64 = 5.0
	// [cells] Camera target vertical map-edge inset. Range: 0..unbounded.
	CameraMarginY float64 = 4.0
	// [cells] Spectator base height before zoom. Range: 1e-06..unbounded.
	CameraSpectatorHeight float64 = 14.0
	// [cells/s] Spectator target movement speed. Range: 0..unbounded.
	CameraSpectatorSpeed float64 = 10.0
	// [cells/input-unit] Spectator height change per wheel delta unit. Range: 0..unbounded.
	CameraZoomScale float64 = 0.01
	// [cells] Minimum spectator zoom offset. Range: -1000..unbounded.
	CameraMinZoom float64 = -8.0
)

// Extended Pro + Minibot catalog; mirrored in frontend/src/gameconfig/tuning.ts.
const (
	// [s] Delay added after each Dual Machine Gun shot; lower means faster fire. Range: 1e-06..unbounded.
	DualFireIntervalSeconds float64 = 0.1
	// [HP] Damage per unshielded Dual Machine Gun hit. Range: 0..unbounded.
	DualDamage float64 = 14
	// [cells/s] Backward velocity impulse per Dual Machine Gun shot. Range: 0..unbounded.
	DualRecoil float64 = 0.8
	// [degrees] Minimum angular deviation after recovery; must not exceed maxSpreadDegrees. Range: 0..89.
	DualMinSpreadDegrees float64 = 2
	// [degrees] Maximum accumulated spread; must not be below minSpreadDegrees. Range: 0..89.
	DualMaxSpreadDegrees float64 = 10
	// [s] Delay added after each Chain Gun shot; lower means faster fire. Range: 1e-06..unbounded.
	ChainFireIntervalSeconds float64 = 0.1
	// [HP] Damage per unshielded Chain Gun hit. Range: 0..unbounded.
	ChainDamage float64 = 16
	// [cells/s] Backward velocity impulse per Chain Gun shot. Range: 0..unbounded.
	ChainRecoil float64 = 2
	// [degrees] Minimum angular deviation after recovery; must not exceed maxSpreadDegrees. Range: 0..89.
	ChainMinSpreadDegrees float64 = 5
	// [degrees] Maximum accumulated spread; must not be below minSpreadDegrees. Range: 0..89.
	ChainMaxSpreadDegrees float64 = 15
	// [ratio] Remaining heat reserve consumed per shot; exhausting the reserve blocks firing. Range: 0..1.
	ChainHeatPerShot float64 = 0.052
	// [1/s] Heat reserve restored per second, including while firing; reserve is capped at 1. Range: 0..unbounded.
	ChainRecovery float64 = 0.25
	// [ratio] Overheat clears only when the remaining reserve exceeds this threshold. Range: 0..<1.
	ChainResumeAbove float64 = 0.5
	// [cells/s] Speed below which spread is divided by precisionDivisor. Range: 0..unbounded.
	ChainPrecisionSpeed float64 = 1.15
	// [ratio] Divisor applied to low-speed spread; values above 1 improve precision. Range: 1e-06..unbounded.
	ChainPrecisionDivisor float64 = 2.7
	// [s] Delay added after each Sniper Rifle shot; lower means faster fire. Range: 1e-06..unbounded.
	SniperFireIntervalSeconds float64 = 2
	// [HP] Damage per unshielded ray; one shot applies normalRays or scopedRays rays. Range: 0..unbounded.
	SniperDamage float64 = 34
	// [cells/s] Backward velocity impulse per Sniper Rifle shot. Range: 0..unbounded.
	SniperRecoil float64 = 3
	// [count] Coincident damage rays below scopeThreshold. Range: 1..unbounded (integer).
	SniperNormalRays int = 2
	// [count] Coincident damage rays at or above scopeThreshold. Range: 1..unbounded (integer).
	SniperScopedRays int = 3
	// [cells] Scope height that enables scopedRays; keep within minHeight..maxHeight. Range: 0..unbounded.
	SniperScopeThreshold float64 = 10
	// [cells] Minimum scope height; must not exceed maxHeight. Range: 1e-06..unbounded.
	SniperMinHeight float64 = 5
	// [cells] Maximum scope height; must not be below minHeight. Range: 1e-06..unbounded.
	SniperMaxHeight float64 = 12
	// [ratio] Aim distance multiplier used to choose a clamped target scope height. Range: 0..unbounded.
	SniperAimScale float64 = 2
	// [1/s] Linear scope-height follow coefficient; each step is capped at full convergence. Range: 0..unbounded.
	SniperFollow float64 = 2.5
	// [s] Delay added after each Bazooka shot; lower means faster fire. Range: 1e-06..unbounded.
	BazookaFireIntervalSeconds float64 = 1.75
	// [HP] Peak explosion damage before distance falloff, cover and protection. Range: 0..unbounded.
	BazookaDamage float64 = 85
	// [cells/s] Backward velocity impulse per Bazooka shot. Range: 0..unbounded.
	BazookaRecoil float64 = 3
	// [cells/s] Rocket launch speed; must not exceed maxSpeed. Range: 1e-06..unbounded.
	BazookaSpeed float64 = 2.5
	// [cells/s] Rocket speed cap applied before movement. Range: 1e-06..unbounded.
	BazookaMaxSpeed float64 = 10
	// [1/s] Rocket velocity grows by 1 + acceleration * dt after movement. Range: 0..unbounded.
	BazookaAcceleration float64 = 3
	// [s] Minimum rocket age before the fire input can request remote detonation. Range: 0..unbounded.
	BazookaRemoteDelaySeconds float64 = 0.25
	// [cells] Explosion radius for distance falloff and cover checks. Range: 1e-06..unbounded.
	BazookaRadius float64 = 2
	// [s] Maximum rocket lifetime before forced detonation; bounds entity persistence. Range: 1e-06..unbounded.
	BazookaLifetimeSeconds float64 = 20
	// [s] Delay added after each Photon Rifle shot; lower means faster fire. Range: 1e-06..unbounded.
	PhotonFireIntervalSeconds float64 = 1.5
	// [HP] Initial beam damage before the distance curve; persistent pulses scale this value. Range: 0..unbounded.
	PhotonDamage float64 = 24
	// [cells/s] Backward velocity impulse per Photon Rifle shot. Range: 0..unbounded.
	PhotonRecoil float64 = 5
	// [s] Fire-input time needed to charge; releasing fire preserves accumulated charge. Range: 0..unbounded.
	PhotonChargeSeconds float64 = 0.5
	// [s] Persistent beam lifetime after the initial hit. Range: 1e-06..unbounded.
	PhotonDurationSeconds float64 = 1
	// [s] Time between persistent beam damage pulses. Range: 1e-06..unbounded.
	PhotonPulseIntervalSeconds float64 = 0.1
	// [ratio] Persistent pulse damage multiplier relative to the initial beam damage. Range: 0..unbounded.
	PhotonPulseMultiplier float64 = 0.5
	// [cells] Target collision radius used by persistent beam pulses. Range: 1e-06..unbounded.
	PhotonPulseRadius float64 = 0.35
	// [ratio] Far-distance floor of the damage multiplier before adding the arctangent term. Range: 0..unbounded.
	PhotonVerticalShift float64 = 0.5
	// [ratio] Scale of the arctangent contribution to the distance damage multiplier. Range: 0..unbounded.
	PhotonCoefficient float64 = 0.65
	// [cells] Distance at the midpoint of the arctangent damage transition. Range: 0..unbounded.
	PhotonHorizontalShift float64 = 2
	// [1/cells] Steepness of the arctangent damage transition; larger values sharpen falloff. Range: 0..unbounded.
	PhotonDistanceMultiplier float64 = 0.65
	// [s] Delay added after each Flamethrower shot; lower means faster fire. Range: 1e-06..unbounded.
	FlamethrowerFireIntervalSeconds float64 = 0.1
	// [HP] Damage per hit before linear distance falloff and protection. Range: 0..unbounded.
	FlamethrowerDamage float64 = 6.5
	// [cells/s] Backward velocity impulse per Flamethrower shot. Range: 0..unbounded.
	FlamethrowerRecoil float64 = 0
	// [degrees] Fixed angular deviation of each flame shot. Range: 0..89.
	FlamethrowerSpreadDegrees float64 = 10
	// [cells] Initial flame reach and distance-damage falloff scale; at least minRange. Range: 1e-06..unbounded.
	FlamethrowerMaxRange float64 = 8
	// [cells] Lower bound on reach as continuous fire shortens the flame; at most maxRange. Range: 0..unbounded.
	FlamethrowerMinRange float64 = 1
	// [s] Continuous-fire time scale for linear reach decay, clamped to minRange. Range: 1e-06..unbounded.
	FlamethrowerExpirationSeconds float64 = 1.5
	// [s] Gap since the last shot that restores full reach; keep above fireIntervalSeconds. Range: 1e-06..unbounded.
	FlamethrowerResetGapSeconds float64 = 0.15
	// [cells] Target collision radius for flame hits. Range: 1e-06..unbounded.
	FlamethrowerHitRadius float64 = 0.5
	// [s] Primary and secondary action lock after deployment; only one owned turret persists. Range: 1e-06..unbounded.
	MinibotCooldownSeconds float64 = 1
	// [s] Turret lifetime after deployment; owner death also removes it. Range: 1e-06..unbounded.
	MinibotLifetimeSeconds float64 = 5
	// [cells] Search radius for the nearest visible target. Range: 1e-06..unbounded.
	MinibotRadius float64 = 6
	// [s] Delay between turret shots after the first immediate shot. Range: 1e-06..unbounded.
	MinibotFireIntervalSeconds float64 = 0.25
	// [HP] Damage per unshielded turret hit. Range: 0..unbounded.
	MinibotDamage float64 = 5
	// [cells] Deployment offset along the owner aim; obstructed placement is rejected. Range: 0..unbounded.
	MinibotSpawnOffset float64 = 1
	// [cells] Turret position and firing height above the floor. Range: 0..unbounded.
	MinibotHeight float64 = 0.15
)

const (
	// [cells] Muzzle offset to the right; negative values place it on the left. Range: -unbounded..unbounded.
	DualMuzzleRight float64 = -0.22430870056152344
	// [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
	DualMuzzleForward float64 = 0.39787338256835936
	// [cells] Muzzle height above the floor. Range: 0..unbounded.
	DualMuzzleHeight float64 = 0.2531485366821289
	// [cells] Second barrel offset to the right; firing alternates between barrels. Range: -unbounded..unbounded.
	DualMuzzleRight2 float64 = 0.22429021835327148
	// [cells] Second barrel offset along the facing direction. Range: 0..unbounded.
	DualMuzzleForward2 float64 = 0.39787338256835936
	// [cells] Second barrel height above the floor. Range: 0..unbounded.
	DualMuzzleHeight2 float64 = 0.2486686134338379
)

const (
	// [cells] Rightmost barrel anchor; the other three offsets derive from this position. Range: -unbounded..unbounded.
	ChainMuzzleRight float64 = 0.30159927368164063
	// [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
	ChainMuzzleForward float64 = 0.39787338256835936
	// [cells] Barrel anchor height above the floor; rotating barrels add vertical offsets. Range: 0..unbounded.
	ChainMuzzleHeight float64 = 0.2486686134338379
)

const (
	// [cells] Muzzle offset to the right; negative values place it on the left. Range: -unbounded..unbounded.
	SniperMuzzleRight float64 = 0.12225322723388672
	// [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
	SniperMuzzleForward float64 = 0.6327515029907227
	// [cells] Muzzle height above the floor. Range: 0..unbounded.
	SniperMuzzleHeight float64 = 0.2486686134338379
)

const (
	// [cells] Muzzle offset to the right; negative values place it on the left. Range: -unbounded..unbounded.
	BazookaMuzzleRight float64 = 0.17580467224121094
	// [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
	BazookaMuzzleForward float64 = 0.4
	// [cells] Muzzle height above the floor. Range: 0..unbounded.
	BazookaMuzzleHeight float64 = 0.4197410202026367
)

const (
	// [cells] Muzzle offset to the right; negative values place it on the left. Range: -unbounded..unbounded.
	PhotonMuzzleRight float64 = 0.14311842918395998
	// [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
	PhotonMuzzleForward float64 = 0.2884313201904297
	// [cells] Muzzle height above the floor. Range: 0..unbounded.
	PhotonMuzzleHeight float64 = 0.2502646064758301
)

const (
	// [cells] Muzzle offset to the right; negative values place it on the left. Range: -unbounded..unbounded.
	FlamethrowerMuzzleRight float64 = 0.1955849838256836
	// [cells] Muzzle offset along the facing direction. Range: 0..unbounded.
	FlamethrowerMuzzleForward float64 = 0.34907398223876956
	// [cells] Muzzle height above the floor. Range: 0..unbounded.
	FlamethrowerMuzzleHeight float64 = 0.24853231430053713
)

const (
	// [degrees] Fixed angular deviation of each turret shot. Range: 0..89.
	MinibotSpreadDegrees float64 = 10
	// [cells] Turret muzzle offset to the right of its aim direction. Range: -unbounded..unbounded.
	MinibotMuzzleRight float64 = .1
	// [cells] Turret ray length; keep at least as large as the target search radius. Range: 1e-06..unbounded.
	MinibotShotRange float64 = 10
)
