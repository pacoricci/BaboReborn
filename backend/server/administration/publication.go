package administration

import (
	"context"

	"baboreborn/backend/registry"
)

// Administration owns durable assignments; hosting supplies already captured room information.
func (s *Service) Publication(ctx context.Context) (registry.Publication, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := registry.Publication{Rooms: []registry.PublishedRoom{}, Staff: []registry.Assignment{}}
	for _, r := range s.Rooms.Directory().Rooms {
		i := r.Info
		p.Rooms = append(p.Rooms, registry.PublishedRoom{Details: i.Details, ID: r.ID, Name: i.Name, Mode: i.Mode, Map: i.Map, Occupied: i.Occupied, Capacity: i.Capacity, Protocol: i.Protocol, Profile: i.Profile})
	}
	rows, err := s.DB.QueryContext(ctx, "SELECT account_id,role FROM roles WHERE role IN ('admin','moderator') ORDER BY account_id")
	if err != nil {
		return p, err
	}
	for rows.Next() {
		var a registry.Assignment
		if err = rows.Scan(&a.Account, &a.Role); err != nil {
			break
		}
		p.Staff = append(p.Staff, a)
	}
	return p, finishRows(rows, err)
}
