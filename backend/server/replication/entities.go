package replication

import "baboreborn/backend/server/wire"

// Captures and per-peer baselines share immutable encoded records. Deltas are
// always against committed delivery, never against an unsent/replaced capture.
type entityGroup[K comparable] struct {
	order    []int
	records  map[int][]byte
	versions map[int]K
	size     int
}

func encodeEntities[T any, K comparable](values []T, id func(T) int, version func(T) K, previous entityGroup[K], encode func(T) ([]byte, error)) (entityGroup[K], error) {
	// Stable lists share their entire immutable index, not only encoded records.
	// In particular, resting pickups must not allocate two maps every publication.
	unchanged := previous.records != nil && len(values) == len(previous.order)

	if unchanged {
		for index, value := range values {
			key := id(value)
			if previous.order[index] != key || previous.versions[key] != version(value) {
				unchanged = false
				break
			}
		}
		if unchanged {
			return previous, nil
		}
	}
	group := entityGroup[K]{order: make([]int, 0, len(values)), records: make(map[int][]byte, len(values)), versions: make(map[int]K, len(values)), size: 0}

	for _, v := range values {
		key, stamp := id(v), version(v)
		body := previous.records[key]
		old, exists := previous.versions[key]
		if !exists || old != stamp {
			var err error
			body, err = encode(v)
			if err != nil {
				return entityGroup[K]{}, err
			}
		}
		group.order = append(group.order, key)
		group.records[key], group.versions[key] = body, stamp
		group.size += wire.EncodedEntitySize(body)
	}
	return group, nil
}
func (g entityGroup[K]) delta(previous entityGroup[K]) []byte {
	var patch wire.EntityPatch
	for _, id := range g.order {
		if old, exists := previous.versions[id]; !exists || old != g.versions[id] {
			patch.Upsert(g.records[id])
		}
	}
	for _, id := range previous.order {
		if _, ok := g.records[id]; !ok {
			patch.Remove(id)
		}
	}
	return patch.Bytes()
}
