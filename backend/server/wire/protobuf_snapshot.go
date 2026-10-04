package wire

import (
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	"baboreborn/backend/gameconfig"
	"baboreborn/backend/server/wire/pb"
)

// SnapshotParts keeps capture-owned Protobuf submessages reusable across peers.
// A nil group means retain previous state; an empty encoded wrapper means clear.
type SnapshotParts struct {
	CapturedAtMS                              int64
	EventCut, Version, Tick                   int
	Type                                      string
	Players, Local, Flags, Items, Projectiles []byte
	Match                                     MatchParts
}
type MatchParts struct {
	Round, Started, Ends   int
	Phase                  string
	Rules, Scores, Ranking []byte
}

func (s SnapshotParts) headers() (*pb.Snapshot, *pb.Match) {
	header := new(pb.Snapshot)
	header.SetCapturedAtMs(uint64(s.CapturedAtMS))
	header.SetEventCut(uint64(s.EventCut))
	header.SetType(s.Type)
	header.SetVersion(uint32(s.Version))
	header.SetTick(uint64(s.Tick))
	match := new(pb.Match)
	match.SetRound(uint64(s.Match.Round))
	match.SetPhase(s.Match.Phase)
	match.SetStartedTick(int64(s.Match.Started))
	match.SetEndsTick(int64(s.Match.Ends))
	return header, match
}

func encodedLength(data []byte) int {
	if data == nil {
		return -1
	}
	return len(data)
}
func nestedSize(field protowire.Number, size int) int {
	if size < 0 {
		return 0
	}
	return protowire.SizeTag(field) + protowire.SizeBytes(size)
}
func (s SnapshotParts) matchSize(match *pb.Match) int {
	return proto.Size(match) + nestedSize(5, encodedLength(s.Match.Rules)) +
		nestedSize(6, encodedLength(s.Match.Scores)) + nestedSize(7, encodedLength(s.Match.Ranking))
}
func (s SnapshotParts) size(header *pb.Snapshot, match *pb.Match, items, projectiles int) int {
	return proto.Size(header) + len(s.Players) + nestedSize(3, s.matchSize(match)) +
		nestedSize(5, encodedLength(s.Local)) + nestedSize(9, encodedLength(s.Flags)) +
		nestedSize(10, items) + nestedSize(11, projectiles)
}

// FullSize accounts for complete entity lists without assembling their bytes.
// Their sizes are the sums of EncodedEntitySize for each retained record.
func (s SnapshotParts) FullSize(items, projectiles int) int {
	header, match := s.headers()
	return s.size(header, match, items, projectiles)
}

func (s SnapshotParts) Marshal() ([]byte, error) {
	header, match := s.headers()
	m, err := (proto.MarshalOptions{}).MarshalAppend(make([]byte, 0, s.matchSize(match)), match)
	if err != nil {
		return nil, err
	}
	if s.Match.Rules != nil {
		m = appendMessage(m, 5, s.Match.Rules)
	}
	if s.Match.Scores != nil {
		m = appendMessage(m, 6, s.Match.Scores)
	}
	if s.Match.Ranking != nil {
		m = appendMessage(m, 7, s.Match.Ranking)
	}
	size := s.size(header, match, encodedLength(s.Items), encodedLength(s.Projectiles))
	b, err := (proto.MarshalOptions{}).MarshalAppend(make([]byte, 0, size), header)
	if err != nil {
		return nil, err
	}
	b = appendMessage(b, 3, m)
	b = append(b, s.Players...)
	for _, group := range []struct {
		field protowire.Number
		data  []byte
	}{
		{5, s.Local}, {9, s.Flags}, {10, s.Items}, {11, s.Projectiles},
	} {
		if group.data != nil {
			b = appendMessage(b, group.field, group.data)
		}
	}
	return b, nil
}

// EncodeSnapshot is the complete-state path for measurements and fixtures.
func EncodeSnapshot(s RecipientSnapshot) ([]byte, error) {
	e := &protoEncoder{}
	players := make([]*pb.Player, 0, len(s.Players))
	for _, v := range s.Players {
		players = append(players, e.player(v, true))
	}
	flags := new(pb.Flags)
	for _, v := range s.Flags {
		flags.SetValues(append(flags.GetValues(), e.flag(v)))
	}
	items := new(pb.Items)
	for _, v := range s.Items {
		items.SetValues(append(items.GetValues(), e.item(v)))
	}
	projectiles := new(pb.Projectiles)
	for _, v := range s.Projectiles {
		projectiles.SetValues(append(projectiles.GetValues(), e.projectile(v)))
	}
	ranking := new(pb.Ranking)
	for _, v := range s.Match.Ranking {
		ranking.SetValues(append(ranking.GetValues(), e.standing(v)))
	}
	p := new(pb.Snapshot)
	p.SetCapturedAtMs(uint64(s.CapturedAtMS))
	p.SetEventCut(uint64(s.EventCut))
	p.SetType(s.Type)
	p.SetVersion(uint32(s.Version))
	p.SetTick(uint64(s.Tick))
	p.SetPlayers(players)
	p.SetFlags(flags)
	p.SetItems(items)
	p.SetProjectiles(projectiles)
	m := new(pb.Match)
	m.SetRound(uint64(s.Match.Round))
	m.SetPhase(s.Match.Phase)
	m.SetStartedTick(int64(s.Match.StartedTick))
	m.SetEndsTick(int64(s.Match.EndsTick))
	m.SetRules(e.rules(s.Match.Rules))
	m.SetScores(e.scores(s.Match.Scores))
	m.SetRanking(ranking)
	p.SetMatch(m)

	if s.Local != nil {
		p.SetLocal(e.local(*s.Local))
	}
	return e.marshal(p)
}

func EncodeStateDelivery(connection string, sequence, generation, eventThrough int, sentAtMS int64, body []byte) ([]byte, error) {
	p := new(pb.Delivery)
	p.SetType("delivery")
	p.SetVersion(gameconfig.ProtocolVersion)
	p.SetConnection(connection)
	p.SetSequence(uint64(sequence))
	p.SetGeneration(uint64(generation))
	p.SetEventThrough(uint64(eventThrough))
	p.SetSentAtMs(uint64(sentAtMS))
	p.SetKind("state")
	size := proto.Size(p) + protowire.SizeTag(9) + protowire.SizeBytes(len(body))
	b, err := (proto.MarshalOptions{}).MarshalAppend(make([]byte, 0, size), p)
	if err != nil {
		return nil, err
	}
	return appendMessage(b, 9, body), nil
}
