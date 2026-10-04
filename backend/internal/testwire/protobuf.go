package testwire

import (
	"encoding/json"
	"math"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	"baboreborn/backend/server/wire/pb"
)

// Independent generated-message reader for Go tests and cross-language fixtures.
func Plain(m protoreflect.Message) map[string]any {
	out := map[string]any{}
	fields := m.Descriptor().Fields()
	for i := 0; i < fields.Len(); i++ {
		f := fields.Get(i)
		if !m.Has(f) && !f.IsList() {
			continue
		}
		if f.IsList() {
			list := m.Get(f).List()
			values := make([]any, 0, list.Len())
			for j := 0; j < list.Len(); j++ {
				values = append(values, plainValue(f, list.Get(j)))
			}
			out[f.JSONName()] = values
		} else {
			out[f.JSONName()] = plainValue(f, m.Get(f))
		}
	}
	// Independent semantic projection for the quantized wire units.
	if m.Descriptor().FullName() == "baboreborn.replication.RemoteState" {
		for _, key := range []string{"x", "y"} {
			if v, ok := out[key].(int32); ok {
				out[key] = float64(v) / 4096
			}
		}
		if v, ok := out["angle"].(uint32); ok {
			a := int64(v)
			if a >= 32768 {
				a -= 65536
			}
			out["angle"] = float64(a) * (2 * math.Pi / 65536)
		}
	}
	return out
}
func plainValue(f protoreflect.FieldDescriptor, v protoreflect.Value) any {
	if f.Kind() == protoreflect.MessageKind {
		return Plain(v.Message())
	}
	return v.Interface()
}
func snapshot(p *pb.Snapshot) map[string]any {
	s := Plain(p.ProtoReflect())
	if _, ok := s["local"]; !ok {
		s["local"] = nil
	}
	if p.GetFlags() != nil {
		s["flags"] = s["flags"].(map[string]any)["values"]
	}
	if p.GetMatch() != nil && p.GetMatch().GetRanking() != nil {
		s["match"].(map[string]any)["ranking"] = s["match"].(map[string]any)["ranking"].(map[string]any)["values"]
	}
	for _, key := range []string{"items", "projectiles"} {
		if g, ok := s[key].(map[string]any); ok {
			if g["delta"] == true {
				s[key] = map[string]any{"upsert": g["upsert"], "remove": g["remove"]}
			} else {
				s[key] = g["values"]
			}
		}
	}
	return s
}
func Snapshot(data []byte) ([]byte, error) {
	p := &pb.Snapshot{}
	if err := proto.Unmarshal(data, p); err != nil {
		return nil, err
	}
	return json.Marshal(snapshot(p))
}
func Delivery(data []byte) ([]byte, error) {
	p := &pb.Delivery{}
	if err := proto.Unmarshal(data, p); err != nil {
		return nil, err
	}
	v := Plain(p.ProtoReflect())
	if p.GetBody() != nil {
		v["body"] = snapshot(p.GetBody())
	}
	return json.Marshal(v)
}
func Projectiles(data []byte) ([]byte, error) {
	p := &pb.Projectiles{}
	if err := proto.Unmarshal(data, p); err != nil {
		return nil, err
	}
	v := Plain(p.ProtoReflect())
	delete(v, "values")
	delete(v, "delta")
	return json.Marshal(v)
}
