// Package match owns authoritative match state and rules without transport or graphics dependencies.
package match

import (
	"errors"
	"fmt"
	"math"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/maps"
)

var ErrInputBacklog = errors.New("input backlog exceeds 500 ms")

const MaxPlayers = 16
const maxQueue = 60

var Geometry = core.ShotGeometry{MuzzleOffset: gameconfig.SmgMuzzleForward, MuzzleSide: gameconfig.SmgMuzzleRight, MuzzleHeight: gameconfig.SmgMuzzleHeight, MaxDistance: 128, WallHeight: .7}

type Arena = maps.Arena
type Command struct {
	Seq  int       `json:"seq"`
	Life int       `json:"life"`
	View *ShotView `json:"view,omitempty"`
	core.Input
}
type Player struct {
	Team           Team
	bot            *botController
	Nickname       string
	NicknameColors string
	Appearance     Appearance
	NextAppearance Appearance
	Score          int
	NextPrimary    string
	NextSecondary  string
	ID             int
	State          core.Player
	HP             float64
	Status         string
	Life           int
	Born           int
	Died           int
	Ack            int
	Seed           uint32
	Kills          int
	Deaths         int
	queue          []Command
	accepted       int
	lastInput      int
	lastSeen       int
	body           core.Body
}

// IsBot reports whether this player is controlled by the server.
func (p *Player) IsBot() bool { return p.bot != nil }

// PendingInputs is read only by the world owner for bounded diagnostic traces.
func (p *Player) PendingInputs() int { return len(p.queue) }

type World struct {
	// TimeMS is supplied by the room owner from its monotonic delivery clock.
	TimeMS      int64
	skinIDs     map[string]bool
	defaultSkin string
	Flags       []Flag
	Activities  []Activity
	rotation    []preparedMap
	Rules       MatchRules
	Match       Match
	Items       []*Item
	Projectiles []*Projectile
	entityID    int
	Arena       Arena
	Geometry    core.World
	Players     []*Player
	Tick        int
	nextID      int
	eventID     int
	Events      []Event
	Cues        []Cue
	cueID       int
	eventFrom   int
	seed        uint32
	history     [rewindTicks + 1]hitFrame
}

// New starts a world on its own copy of a validated arena.
func New(a Arena) (*World, error) {
	arena, err := ownArena(a)
	if err != nil {
		return nil, err
	}
	walls := arena.GeometryWalls()
	return &World{
		skinIDs:     map[string]bool{"geometric": true},
		defaultSkin: "geometric",
		Flags:       []Flag{},
		Activities:  []Activity{},
		Rules:       DefaultRules(),
		Match:       Match{Round: 1, Phase: "playing", Ranking: []Standing{}},
		Items:       []*Item{},
		Projectiles: []*Projectile{},
		Arena:       arena,
		Geometry:    core.World{Walls: walls, Grid: core.NewGrid(core.Wall{W: arena.Width, H: arena.Height}, walls)},
		Players:     []*Player{},
		Events:      []Event{},
		seed:        7291,
	}, nil
}

// MustNew builds fixtures from static map JSON; configured rooms use New.
func MustNew(data []byte) *World {
	a, err := maps.Parse(data)
	if err != nil {
		panic(err)
	}
	w, err := New(a)
	if err != nil {
		panic(err)
	}
	return w
}
func (w *World) Add() *Player {
	w.nextID++
	p := &Player{Team: TeamNone, Nickname: fmt.Sprintf("Player %d", w.nextID), Appearance: DefaultAppearance(), NextAppearance: DefaultAppearance(), NextPrimary: "smg", NextSecondary: "knives", ID: w.nextID, Status: "spectator", State: core.NewPlayer(w.Arena.Spawns[0], math.Pi/2), Seed: uint32(7291 + w.nextID), lastSeen: w.Tick}
	p.Appearance.Template = w.defaultSkin
	p.NextAppearance.Template = w.defaultSkin
	w.Players = append(w.Players, p)
	w.activity("connected", p, nil, "")
	return p
}
func (w *World) Remove(id int) {
	for i, p := range w.Players {
		if p.ID == id {
			w.dropFlag(p)
			w.activity("disconnected", p, nil, "")
			w.Players = append(w.Players[:i], w.Players[i+1:]...)
			return
		}
	}
}
func (w *World) Find(id int) *Player {
	for _, p := range w.Players {
		if p.ID == id {
			return p
		}
	}
	return nil
}
func (w *World) Release(p *Player) { p.queue = p.queue[:0]; p.Ack = p.accepted; p.lastInput = w.Tick }
func (w *World) Spawn(p *Player) bool {
	if w.Match.Phase != "playing" || p.Status == "alive" || p.Status == "dead" && w.Tick-p.Died < w.Rules.RespawnTicks {
		return false
	}
	w.assignTeam(p)
	spawns := w.spawnPoints(p)
	best := int(core.NextRandom(&w.seed) * float64(len(spawns)))
	distance := -1.
	for i, spawn := range spawns {
		nearest := math.Inf(1)
		for _, other := range w.Players {
			if w.enemies(p, other) && other.Status == "alive" {
				nearest = math.Min(nearest, math.Hypot(other.State.X-spawn.X, other.State.Y-spawn.Y))
			}
		}
		if !math.IsInf(nearest, 1) && nearest > distance {
			distance = nearest
			best = i
		}
	}
	if p.bot != nil {
		// Rotate only at an accepted spawn, never while waiting for respawn.
		p.NextPrimary, p.NextSecondary = botLoadout(p.ID, p.Life)
	}
	p.State = core.NewPlayer(spawns[best], math.Pi/2)
	p.State.Equipment = core.NewEquipment(p.NextPrimary, p.NextSecondary)
	p.Appearance = p.NextAppearance
	p.Appearance.Colors = append([]string(nil), p.NextAppearance.Colors...)
	p.HP = gameconfig.PlayerMaxHealth
	p.Status = "alive"
	p.Life++
	p.Born = w.Tick
	w.signal("spawn", p.ID, core.Vec3{X: p.State.X, Y: p.State.Y, Z: core.Radius})
	w.Release(p)
	return true
}
func finite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }
func (w *World) Submit(p *Player, commands []Command) error {
	if len(commands) == 0 || len(commands) > 16 {
		return errors.New("input batch must contain 1..16 commands")
	}
	last := p.accepted
	fresh := 0
	for _, c := range commands {
		if c.View != nil && !c.View.valid() {
			return errors.New("invalid shot view")
		}
		if c.Pickup < 0 || c.Pickup > 2147483647 || c.Seq <= 0 || c.Seq > 2147483647 || c.Life < 0 || !finite(c.X) || !finite(c.Y) || math.Abs(c.X) > 1 || math.Abs(c.Y) > 1 || !finite(c.Aim.X) || !finite(c.Aim.Y) || math.Abs(c.Aim.X) > 256 || math.Abs(c.Aim.Y) > 256 {
			return errors.New("invalid input")
		}
		if c.Seq <= p.accepted {
			continue
		}
		if c.Seq <= last || c.Seq-last > 1024 {
			return errors.New("invalid sequence")
		}
		last = c.Seq
		fresh++
	}
	if len(p.queue)+fresh > maxQueue {
		return ErrInputBacklog
	}
	for _, c := range commands {
		if c.Seq <= p.accepted {
			continue
		}
		p.accepted = c.Seq
		if p.Status != "alive" || w.Match.Phase != "playing" {
			p.Ack = c.Seq
			continue
		}
		if c.View != nil {
			view := *c.View
			c.View = &view
		}
		p.queue = append(p.queue, c)
	}
	if fresh > 0 {
		p.lastInput = w.Tick
	}
	p.lastSeen = w.Tick
	return nil
}
func (w *World) Step() {
	defer w.anchorEntities()
	w.Tick++
	if w.advanceMatch() {
		return
	}
	w.prepareBots()
	// Stable player-ID order is the authority's tie break for simultaneous shots and contacts.
	for _, p := range w.Players {
		p.body = core.Body{ID: p.ID, X: p.State.X, Y: p.State.Y, Radius: core.Radius, HP: p.HP, Immune: w.Tick-p.Born <= durationTicks(gameconfig.DeathmatchSpawnProtectionSeconds-gameconfig.DeathmatchSpawnInactiveTailSeconds), Shield: p.State.Equipment.Protection-gameconfig.TickSeconds > gameconfig.ShieldInactiveTailSeconds}
	}
	var bodies [MaxPlayers]*core.Body
	var historical [MaxPlayers]core.Body
	var targets [MaxPlayers]*core.Body
	for _, p := range w.Players {
		if p.Status != "alive" {
			continue
		}
		if w.Tick-p.lastInput > inputTimeoutTicks {
			w.Release(p)
		}
		input := core.Input{Aim: core.Vec2{X: p.State.X + math.Cos(p.State.Angle)*2, Y: p.State.Y + math.Sin(p.State.Angle)*2}}
		var view *ShotView
		if len(p.queue) > 0 {
			c := p.queue[0]
			p.queue = p.queue[1:]
			if c.Life == p.Life {
				input = c.Input
				view = c.View
			}
			p.Ack = c.Seq
		}
		count := 0
		for _, other := range w.Players {
			if w.enemies(p, other) && other.Status == "alive" {
				bodies[count] = &other.body
				count++
			}
		}
		angle := p.State.Angle
		beforeWeapon := weaponTransitionBefore(&p.State)
		beforeVX, beforeVY := p.State.VX, p.State.VY
		clear(targets[:])
		shotBodies := bodies[:count]
		if input.Fire && compensatedPrimary(p.State.Equipment.Primary) {
			shotBodies = w.shotBodies(p, view, shotBodies, &historical, &targets)
		}
		shot := core.Step(&p.State, input, gameconfig.TickSeconds, w.Geometry, shotBodies, &p.Seed, Geometry)
		// Only damage returns from the historical query; movement and contacts stay current.
		for i, target := range targets {
			if target != nil {
				target.HP = historical[i].HP
			}
		}
		w.weaponSignals(p, beforeWeapon)
		// A fast sign reversal without an action impulse comes from grid reflection.
		if shot == nil && p.State.Equipment.Action == "" && ((math.Abs(beforeVX) > playerContactCueMinSpeed && beforeVX*p.State.VX < 0) || (math.Abs(beforeVY) > playerContactCueMinSpeed && beforeVY*p.State.VY < 0)) {
			w.cue(Cue{Kind: "player-impact", Owner: p.ID, Position: core.Vec3{X: p.State.X, Y: p.State.Y, Z: core.Radius}})
		}
		p.body.X = p.State.X
		p.body.Y = p.State.Y
		// Resolve primary damage before secondary actions can apply a different cause.
		w.resolveDeaths(p.ID, p.State.Equipment.Primary)
		w.actions(p, input, angle)
		w.primaryShot(p, shot)
	}
	for _, p := range w.Players {
		if p.Status != "alive" || w.Tick-p.Born <= durationTicks(gameconfig.DeathmatchContactDelaySeconds) {
			continue
		}
		for _, other := range w.Players {
			if other.ID == p.ID || other.Status != "alive" || w.Tick-other.Born <= durationTicks(gameconfig.DeathmatchContactDelaySeconds) {
				continue
			}
			direction := 1.
			if p.ID > other.ID {
				direction = -1
			}
			core.ResolveContact(&p.State, core.Vec2{X: other.State.X, Y: other.State.Y}, w.Geometry.Grid, direction)
		}
	}
	w.updateEntities()
	w.updateFlags()
	w.checkLimits()
	w.rememberHitFrame()
}
func (w *World) Touch(p *Player)        { p.lastSeen = w.Tick }
func (w *World) Expired(p *Player) bool { return w.Tick-p.lastSeen > disconnectTicks }
