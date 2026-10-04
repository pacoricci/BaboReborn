package wire_test

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"reflect"
	"testing"

	"google.golang.org/protobuf/proto"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/server/wire"
	"baboreborn/backend/server/wire/pb"
)

func TestProtobufFloat64Contract(t *testing.T) {
	rng := rand.New(rand.NewPCG(17, 29))
	values := []float64{0, math.Copysign(0, -1), math.SmallestNonzeroFloat64, math.MaxFloat64, math.Pi, -math.Pi, 1e-7, 1e21}
	for range 128 {
		v := math.Float64frombits(rng.Uint64())
		if !math.IsNaN(v) && !math.IsInf(v, 0) {
			values = append(values, v)
		}
	}
	type record struct {
		Data []byte   `json:"data"`
		Bits []string `json:"bits"`
	}
	records := []record{}
	for _, v := range values {
		s := wire.RecipientSnapshot{Players: []wire.RemotePlayer{{ID: 9007199254740991, HP: v, State: wire.RemoteState{Cooldown: v / 8, Equipment: wire.RemoteEquipment{Charge: math.Nextafter(v, 0), SinceShot: v / 16, Protection: v / 32, MeleeDelay: v / 64}}}}}
		s.Local = &wire.LocalCheckpoint{ID: 9007199254740991, State: core.Player{X: -v, Y: v / 2, Angle: v / 4}}
		b, err := wire.EncodeSnapshot(s)
		if err != nil {
			t.Fatal(err)
		}
		var got pb.Snapshot
		if err = proto.Unmarshal(b, &got); err != nil {
			t.Fatal(err)
		}
		p := got.GetPlayers()[0]
		e := p.GetState().GetEquipment()
		original := []float64{v, -v, v / 2, v / 4, v / 8, math.Nextafter(v, 0), v / 16, v / 32, v / 64}
		decoded := []float64{p.GetHp(), got.GetLocal().GetState().GetX(), got.GetLocal().GetState().GetY(), got.GetLocal().GetState().GetAngle(), p.GetState().GetCooldown(), e.GetCharge(), e.GetSinceShot(), e.GetProtection(), e.GetMeleeDelay()}
		bits := []string{}
		for i, n := range original {
			if math.Float64bits(n) != math.Float64bits(decoded[i]) {
				t.Fatal("lost bits", i, n)
			}
			bits = append(bits, fmt.Sprintf("%016x", math.Float64bits(n)))
		}
		frame, err := wire.EncodeStateDelivery("numeric", 1, 1, 0, 0, b)
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, record{frame, bits})
	}
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := "testdata/protobuf-float64.json"
	if os.Getenv("UPDATE_PROTOCOL_FIXTURES") == "1" {
		if err = os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var expected []record
	if err := json.Unmarshal(want, &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(expected, records) {
		t.Fatal("numeric fixture changed")
	}
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, err := wire.EncodePlayers([]wire.RemotePlayer{{HP: v}}, false); err == nil {
			t.Fatal("accepted nonfinite number")
		}
	}
}

func TestProtobufRosterCapacityAndEmptyPresence(t *testing.T) {
	if _, err := wire.EncodePlayers(make([]wire.RemotePlayer, 17), false); err == nil {
		t.Fatal("accepted oversized roster")
	}
	b, err := wire.EncodeFlags(nil)
	if err != nil || b == nil {
		t.Fatal("empty group became omitted", err)
	}
	b, err = wire.EncodeRanking(nil)
	if err != nil || b == nil {
		t.Fatal("empty ranking became omitted", err)
	}
}

func TestEntityPatchMatchesGeneratedGroup(t *testing.T) {
	record, err := wire.EncodeItem(wire.Item{ID: 7, Kind: "health"})
	if err != nil {
		t.Fatal(err)
	}
	var item pb.Item
	if err := proto.Unmarshal(record, &item); err != nil {
		t.Fatal(err)
	}
	full := new(pb.Items)
	full.SetValues([]*pb.Item{&item})
	fullBytes, err := proto.Marshal(full)
	if err != nil || wire.EncodedEntitySize(record) != len(fullBytes) {
		t.Fatal("entity size", err)
	}
	for _, remove := range [][]uint64{nil, {1, 128, 16384, 9007199254740991}} {
		var patch wire.EntityPatch
		if patch.Bytes() != nil {
			t.Fatal("unchanged group must be omitted")
		}
		patch.Upsert(record)
		expected := new(pb.Items)
		expected.SetUpsert([]*pb.Item{&item})
		expected.SetDelta(true)
		for _, id := range remove {
			patch.Remove(int(id))
		}
		expected.SetRemove(remove)
		want, err := proto.Marshal(expected)
		if err != nil || !reflect.DeepEqual(patch.Bytes(), want) {
			t.Fatal("patch differs from generated schema", err)
		}
	}
}

func TestSnapshotSizeIncludesNestedLengthBoundaries(t *testing.T) {
	for _, length := range []int{0, 1, 126, 127, 128, 16382, 16383, 16384} {
		// Raw cached components need not be decoded to account for framing correctly.
		data := make([]byte, length)
		s := wire.SnapshotParts{CapturedAtMS: 128, EventCut: 16384, Version: gameconfig.ProtocolVersion, Tick: 9007199254740991,
			Type: "snapshot", Players: data, Local: data, Flags: data, Items: data, Projectiles: data,
			Match: wire.MatchParts{Round: 1, Phase: "playing", Rules: data, Scores: data, Ranking: data}}
		encoded, err := s.Marshal()
		if err != nil {
			t.Fatal(err)
		}
		if size := s.FullSize(length, length); size != len(encoded) {
			t.Fatalf("component length %d: size %d != encoded %d", length, size, len(encoded))
		}
	}
}
