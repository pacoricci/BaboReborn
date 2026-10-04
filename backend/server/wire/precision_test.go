package wire_test

import (
	"encoding/json"
	"math"
	"math/rand/v2"
	"os"
	"reflect"
	"testing"

	"google.golang.org/protobuf/proto"

	"baboreborn/backend/core"
	"baboreborn/backend/server/wire"
	"baboreborn/backend/server/wire/pb"
)

func TestQuantizedRosterContract(t *testing.T) {
	type record struct {
		Input [3]float64 `json:"input"`
		Units [3]int64   `json:"units"`
		Data  []byte     `json:"data"`
	}
	records := []record{
		{Input: [3]float64{0, math.Copysign(0, -1), 0}, Units: [3]int64{0, 0, 0}},
		{Input: [3]float64{1.25, -2.5, math.Pi / 2}, Units: [3]int64{5120, -10240, 16384}},
		{Input: [3]float64{1.0 / 8192, -1.0 / 8192, -math.Pi / 2}, Units: [3]int64{1, -1, 49152}},
		{Input: [3]float64{math.MaxInt32 / 4096.0, math.MinInt32 / 4096.0, math.Pi}, Units: [3]int64{math.MaxInt32, math.MinInt32, 32768}},
		{Input: [3]float64{4, 8, -math.Pi}, Units: [3]int64{16384, 32768, 32768}},
		{Input: [3]float64{4, 8, 2 * math.Pi}, Units: [3]int64{16384, 32768, 0}},
		{Input: [3]float64{4, 8, -1e-10}, Units: [3]int64{16384, 32768, 0}},
		{Input: [3]float64{4, 8, 2*math.Pi - 1e-10}, Units: [3]int64{16384, 32768, 0}},
	}
	for i := range records {
		r := &records[i]
		local := core.Player{X: r.Input[0], Y: r.Input[1], Angle: r.Input[2]}
		remote := wire.RemoteState{X: local.X, Y: local.Y, Angle: local.Angle}
		s := wire.RecipientSnapshot{Players: []wire.RemotePlayer{{ID: 1, State: remote}}, Local: &wire.LocalCheckpoint{ID: 1, State: local}}
		body, err := wire.EncodeSnapshot(s)
		if err != nil {
			t.Fatal(err)
		}
		var decoded pb.Snapshot
		if err := proto.Unmarshal(body, &decoded); err != nil {
			t.Fatal(err)
		}
		got := decoded.GetPlayers()[0].GetState()
		if units := [3]int64{int64(got.GetX()), int64(got.GetY()), int64(got.GetAngle())}; units != r.Units {
			t.Fatalf("case %d: %v != %v", i, units, r.Units)
		}
		checkpoint := decoded.GetLocal().GetState()
		for k, v := range []float64{checkpoint.GetX(), checkpoint.GetY(), checkpoint.GetAngle()} {
			if math.Float64bits(v) != math.Float64bits(r.Input[k]) {
				t.Fatal("local pose lost precision")
			}
		}
		r.Data, err = wire.EncodeStateDelivery("quantized", 1, 1, 0, 0, body)
		if err != nil {
			t.Fatal(err)
		}
	}
	path := "testdata/protobuf-precision.json"
	if os.Getenv("UPDATE_PROTOCOL_FIXTURES") == "1" {
		data, err := json.MarshalIndent(records, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var expected []record
	if err := json.Unmarshal(data, &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(expected, records) {
		t.Fatal("quantized fixture changed")
	}
}

func TestQuantizedRosterBoundsAndRejection(t *testing.T) {
	rng := rand.New(rand.NewPCG(43, 91))
	for range 10000 {
		x, y, angle := rng.Float64()*2048-1024, rng.Float64()*2048-1024, (rng.Float64()*2-1)*math.Pi
		b, err := wire.EncodePlayers([]wire.RemotePlayer{{State: wire.RemoteState{X: x, Y: y, Angle: angle}}}, false)
		if err != nil {
			t.Fatal(err)
		}
		var decoded pb.Snapshot
		if err := proto.Unmarshal(b, &decoded); err != nil {
			t.Fatal(err)
		}
		p := decoded.GetPlayers()[0].GetState()
		if math.Abs(float64(p.GetX())/4096-x) > 1.0/8192 || math.Abs(float64(p.GetY())/4096-y) > 1.0/8192 || math.Abs(math.Remainder(float64(p.GetAngle())*(2*math.Pi/65536)-angle, 2*math.Pi)) > math.Pi/65536+1e-15 {
			t.Fatal("quantization exceeds specified error")
		}
	}
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), 524288, -524288.001} {
		for _, state := range []wire.RemoteState{{X: v}, {Y: v}} {
			if _, err := wire.EncodePlayers([]wire.RemotePlayer{{State: state}}, false); err == nil {
				t.Fatal("accepted invalid coordinate", v)
			}
		}
	}
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, err := wire.EncodePlayers([]wire.RemotePlayer{{State: wire.RemoteState{Angle: v}}}, false); err == nil {
			t.Fatal("accepted invalid angle")
		}
	}
}
