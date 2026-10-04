package wire

import "google.golang.org/protobuf/encoding/protowire"

// Items and Projectiles share the group layout in snapshot.proto. Replication
// supplies changed records and IDs; only this codec knows their wire fields.
const (
	entityValuesField protowire.Number = 1
	entityUpsertField protowire.Number = 2
	entityRemoveField protowire.Number = 3
	entityDeltaField  protowire.Number = 4
)

func EncodedEntitySize(record []byte) int {
	return protowire.SizeTag(entityValuesField) + protowire.SizeBytes(len(record))
}

type EntityPatch struct{ upsert, remove []byte }

func (p *EntityPatch) Upsert(record []byte) {
	p.upsert = appendMessage(p.upsert, entityUpsertField, record)
}

func (p *EntityPatch) Remove(id int) {
	p.remove = protowire.AppendVarint(p.remove, uint64(id))
}

// Bytes returns nil when there is no change, preserving the receiver's baseline.
func (p EntityPatch) Bytes() []byte {
	if len(p.upsert) == 0 && len(p.remove) == 0 {
		return nil
	}
	b := p.upsert
	if len(p.remove) > 0 {
		b = appendMessage(b, entityRemoveField, p.remove)
	}
	b = protowire.AppendTag(b, entityDeltaField, protowire.VarintType)
	return protowire.AppendVarint(b, 1)
}
