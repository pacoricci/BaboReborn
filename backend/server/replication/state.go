package replication

import (
	"bytes"
	"slices"
	"time"

	"baboreborn/backend/server/wire"
)

// Encoded components detach producer state once. Selection assembles only the
// groups this peer needs, without retaining a cache of every possible variant.
type stateGroups struct {
	metadata                      []playerMetadata
	rules, scores, ranking, flags []byte
	items                         entityGroup[wire.Item]
	projectiles                   entityGroup[projectileStamp]
}
type playerMetadata struct {
	ID                                       int
	Team, Nickname, NicknameColors, Template string
	Colors                                   []string
}

func sameMetadata(a, b []playerMetadata) bool {
	return slices.EqualFunc(a, b, func(a, b playerMetadata) bool {
		return a.ID == b.ID && a.Team == b.Team && a.Nickname == b.Nickname &&
			a.NicknameColors == b.NicknameColors && a.Template == b.Template &&
			(a.Colors == nil) == (b.Colors == nil) && slices.Equal(a.Colors, b.Colors)
	})
}

// Comparable stamps own turret values; neither producer mutation nor a later
// capture can change an encoded record retained by a slower recipient.
type projectileStamp struct {
	value     wire.Projectile
	turret    wire.Turret
	hasTurret bool
}

func stampProjectile(p wire.Projectile) projectileStamp {
	stamp := projectileStamp{value: p}
	if p.Turret != nil {
		stamp.turret, stamp.hasTurret = *p.Turret, true
	}
	stamp.value.Turret = nil
	return stamp
}

func captureCheckpoint(s wire.Snapshot, previous *checkpoint) (*checkpoint, error) {
	if previous == nil {
		previous = &checkpoint{}
	}
	c := &checkpoint{locals: make(map[int][]byte, len(s.Players)), round: s.Match.Round, tick: s.Tick, cut: s.EventCut}
	// Encode each shared group and owner checkpoint once per capture.
	c.payload = wire.SnapshotParts{CapturedAtMS: s.CapturedAtMS, EventCut: s.EventCut, Type: s.Type, Version: s.Version, Tick: s.Tick,
		Items: []byte{}, Projectiles: []byte{},
		Match: wire.MatchParts{Round: s.Match.Round, Phase: s.Match.Phase, Started: s.Match.StartedTick, Ends: s.Match.EndsTick}}
	for _, group := range []struct {
		encode func() ([]byte, error)
		out    *[]byte
	}{
		{func() ([]byte, error) { return wire.EncodeFlags(s.Flags) }, &c.payload.Flags}, {func() ([]byte, error) { return wire.EncodeRules(s.Match.Rules) }, &c.payload.Match.Rules}, {func() ([]byte, error) { return wire.EncodeScores(s.Match.Scores) }, &c.payload.Match.Scores}, {func() ([]byte, error) { return wire.EncodeRanking(s.Match.Ranking) }, &c.payload.Match.Ranking},
	} {
		data, err := group.encode()
		if err != nil {
			return nil, err
		}
		*group.out = data
	}
	var err error
	metadata := make([]playerMetadata, len(s.Players))
	players := make([]wire.RemotePlayer, len(s.Players))
	for i, p := range s.Players {
		metadata[i] = playerMetadata{ID: p.ID, Team: p.Team, Nickname: p.Nickname, NicknameColors: p.NicknameColors, Template: p.Appearance.Template, Colors: slices.Clone(p.Appearance.Colors)}
		players[i] = p.Remote()
		c.locals[p.ID], err = wire.EncodeLocal(p.Checkpoint())
		if err != nil {
			return nil, err
		}
	}
	c.groups.metadata = metadata
	c.dynamicPlayers, err = wire.EncodePlayers(players, false)
	if err != nil {
		return nil, err
	}
	c.payload.Players, err = wire.EncodePlayers(players, true)
	if err != nil {
		return nil, err
	}
	c.groups.items, err = encodeEntities(s.Items, func(v wire.Item) int { return v.ID }, func(v wire.Item) wire.Item { return v }, previous.groups.items, wire.EncodeItem)
	if err != nil {
		return nil, err
	}
	c.groups.projectiles, err = encodeEntities(s.Projectiles, func(v wire.Projectile) int { return v.ID }, stampProjectile, previous.groups.projectiles, wire.EncodeProjectile)
	if err != nil {
		return nil, err
	}
	// Measure the largest full recipient encoding, including nested length prefixes.
	full := c.payload
	for _, local := range c.locals {
		if len(local) > len(full.Local) {
			full.Local = local
		}
	}
	c.size = full.FullSize(c.groups.items.size, c.groups.projectiles.size)
	c.groups.flags = c.payload.Flags
	c.groups.rules = c.payload.Match.Rules
	c.groups.scores = c.payload.Match.Scores
	c.groups.ranking = c.payload.Match.Ranking
	return c, nil
}

func (c *checkpoint) selectState(p *peer, now time.Time) (candidate, error) {
	payload := c.payload
	payload.Local = c.locals[p.id]
	if bytes.Equal(c.groups.flags, p.groups.flags) {
		payload.Flags = nil
	}
	metadataChanged := !sameMetadata(c.groups.metadata, p.groups.metadata)
	rulesChanged := !bytes.Equal(c.groups.rules, p.groups.rules)
	if !metadataChanged {
		payload.Players = c.dynamicPlayers
	}
	if !rulesChanged {
		payload.Match.Rules = nil
	}
	payload.Items = c.groups.items.delta(p.groups.items)
	payload.Projectiles = c.groups.projectiles.delta(p.groups.projectiles)
	standingsChanged := !bytes.Equal(c.groups.scores, p.groups.scores) || !bytes.Equal(c.groups.ranking, p.groups.ranking)
	// Membership/team and phase transitions carry coherent standings immediately,
	// including the final score. Ordinary score changes are capped at 4 Hz.
	standings := standingsChanged && (metadataChanged || rulesChanged || payload.Match.Phase != p.phase || !now.Before(p.nextStandings))
	if !standings {
		payload.Match.Scores, payload.Match.Ranking = nil, nil
	}
	body, err := payload.Marshal()
	return candidate{kind: State, body: body, through: p.sentThrough, generation: p.sentGeneration, state: c, standings: standings}, err
}

func (p *peer) retainState(c *checkpoint, now time.Time, standings bool) {
	p.groups.items, p.groups.projectiles = c.groups.items, c.groups.projectiles
	p.groups.metadata, p.groups.rules = c.groups.metadata, c.groups.rules
	p.groups.flags = c.groups.flags
	p.phase = c.payload.Match.Phase
	if standings {
		p.groups.scores, p.groups.ranking = c.groups.scores, c.groups.ranking
		p.nextStandings = now.Add(standingsInterval)
	}
}
