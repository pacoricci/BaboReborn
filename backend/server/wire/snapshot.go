// Package wire projects authority state into owned outgoing protocol records.
// Capture must run on the world owner; its result can outlive later world updates.
package wire

import "baboreborn/backend/core"

type Appearance struct {
	Template string   `json:"template"`
	Colors   []string `json:"colors"`
}

// Player is the detached internal capture, never a recipient wire record.
// Project through ForRecipient before emitting an installation.
type Player struct {
	Team           string     `json:"team"`
	Nickname       string     `json:"nickname"`
	NicknameColors string     `json:"nicknameColors,omitempty"`
	Appearance     Appearance `json:"appearance"`
	ID             int        `json:"id"`
	// The prediction checkpoint is an intentionally shared value-only contract.
	State    core.Player `json:"state"`
	HP       float64     `json:"hp"`
	Status   string      `json:"status"`
	Life     int         `json:"life"`
	BornTick int         `json:"bornTick"`
	DiedTick int         `json:"diedTick"`
	Ack      int         `json:"ack"`
	Seed     uint32      `json:"seed"`
}

type Item struct {
	Motion      string    `json:"motion"`
	MotionTick  int       `json:"motionTick"`
	Position    core.Vec3 `json:"position"`
	Velocity    core.Vec3 `json:"velocity"`
	ExpiresTick int       `json:"expiresTick"`
	ID          int       `json:"id"`
	Kind        string    `json:"kind"`
	Primary     string    `json:"primary,omitempty"`
}

type Turret struct {
	Angle        float64 `json:"angle"`
	LastShotTick int     `json:"lastShotTick"`
}

type Projectile struct {
	Motion      string    `json:"motion"`
	MotionTick  int       `json:"motionTick"`
	Position    core.Vec3 `json:"position"`
	Velocity    core.Vec3 `json:"velocity"`
	Turret      *Turret   `json:"turret,omitempty"`
	ID          int       `json:"id"`
	Kind        string    `json:"kind"`
	OwnerID     int       `json:"ownerId"`
	BornTick    int       `json:"bornTick"`
	ExpiresTick int       `json:"expiresTick"`
	AttachedID  int       `json:"attachedId"`
}

// Shot is owned presentation geometry. Killed only selects the impact size;
// hit confirmation and death feedback belong to required events.
type Shot struct {
	Surface bool      `json:"surface,omitempty"`
	Kind    string    `json:"kind,omitempty"`
	Pellets []*Shot   `json:"pellets,omitempty"`
	From    core.Vec3 `json:"from"`
	To      core.Vec3 `json:"to"`
	Killed  bool      `json:"killed"`
}

type Participant struct {
	ID             int    `json:"id"`
	Nickname       string `json:"nickname"`
	NicknameColors string `json:"nicknameColors,omitempty"`
	Team           string `json:"team"`
}

type Activity struct {
	OccurredAtMS int64        `json:"occurredAtMs"`
	ID           int          `json:"id"`
	Tick         int          `json:"tick"`
	Round        int          `json:"round"`
	Kind         string       `json:"kind"`
	Actor        Participant  `json:"actor"`
	Victim       *Participant `json:"victim,omitempty"`
	Weapon       string       `json:"weapon,omitempty"`
}

type MatchRules struct {
	Mode           string `json:"mode"`
	ScoreLimit     int    `json:"scoreLimit"`
	TimeLimitTicks int    `json:"timeLimitTicks"`
	RespawnTicks   int    `json:"respawnTicks"`
	EndTicks       int    `json:"endTicks"`
	ForceRespawn   bool   `json:"forceRespawn"`
}

type Standing struct {
	Team   string `json:"team"`
	ID     int    `json:"id"`
	Score  int    `json:"score"`
	Kills  int    `json:"kills"`
	Deaths int    `json:"deaths"`
}

type TeamScores struct {
	Blue int `json:"blue"`
	Red  int `json:"red"`
}
type Point2 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type Flag struct {
	Team      string `json:"team"`
	State     string `json:"state"`
	CarrierID int    `json:"carrierId"`
	Position  Point2 `json:"position"`
}
type Match struct {
	Scores      TeamScores `json:"scores"`
	Round       int        `json:"round"`
	Phase       string     `json:"phase"`
	StartedTick int        `json:"startedTick"`
	EndsTick    int        `json:"endsTick"`
	Rules       MatchRules `json:"rules"`
	Ranking     []Standing `json:"ranking"`
}

type Snapshot struct {
	CapturedAtMS int64        `json:"capturedAtMs"`
	EventCut     int          `json:"eventCut"`
	Flags        []Flag       `json:"flags"`
	Match        Match        `json:"match"`
	Items        []Item       `json:"items"`
	Projectiles  []Projectile `json:"projectiles"`
	Type         string       `json:"type"`
	Version      int          `json:"version"`
	Tick         int          `json:"tick"`
	Players      []Player     `json:"players"`
}
