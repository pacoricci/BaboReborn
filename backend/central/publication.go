package central

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"time"

	"baboreborn/backend/identity"
	"baboreborn/backend/registry"
)

const roomCatalogSchemaVersion = 1

type publishedSnapshot struct {
	Publication      registry.Publication
	Key              string
	Issued, Received time.Time
}
type directoryRoom struct {
	registry.PublishedRoom
	Ref          string    `json:"ref"`
	ServerName   string    `json:"serverName"`
	ServerOrigin string    `json:"serverOrigin"`
	Region       string    `json:"region"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func (s *Service) publication(w http.ResponseWriter, r *http.Request) {
	var packet registry.Packet
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*registry.PublicationLimit))
	var extra any
	if decoder.Decode(&packet) != nil || decoder.Decode(&extra) != io.EOF {
		identity.Error(w, http.StatusBadRequest, "invalid_publication")
		return
	}
	var p registry.Publication
	if packet.VerifyLimit(&p, registry.PublicationLimit) != nil || p.Validate() != nil {
		identity.Error(w, http.StatusBadRequest, "invalid_publication")
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	defer tx.Rollback() //nolint:errcheck // Commit owns success.
	d, err := s.readServer(r.Context(), tx, p.ServerID, true)
	if err != nil || d.PublicKey != packet.Key || d.Revision != p.Revision || !d.Online {
		identity.Error(w, http.StatusConflict, "association_unavailable")
		return
	}
	var expires time.Time
	err = tx.QueryRowContext(r.Context(), `UPDATE registry_nonces SET consumed_at=$3
		WHERE nonce=$1 AND public_key=$2 AND expires_at>$3 AND consumed_at IS NULL
		AND purpose='publication' AND server_id=$4 RETURNING expires_at`, p.Nonce, packet.Key, s.now(), p.ServerID).Scan(&expires)
	if err != nil {
		identity.Error(w, http.StatusUnauthorized, "invalid_nonce")
		return
	}
	for _, room := range p.Rooms {
		if room.Protocol != s.VerifierRegistry.Expected.Protocol || room.Profile != s.VerifierRegistry.Expected.Profile {
			identity.Error(w, http.StatusConflict, "incompatible_publication")
			return
		}
	}
	// Nonce issuance is central-clock ordered and survives publisher restarts. A delayed
	// timed-out request cannot replace a snapshot sampled after a newer challenge.
	issued := expires.Add(-nonceLifetime)
	s.publicationMu.Lock()
	previous, exists := s.publications[p.ServerID]
	if exists && previous.Key == packet.Key && !issued.After(previous.Issued) {
		s.publicationMu.Unlock()
		identity.Error(w, http.StatusConflict, "stale_publication")
		return
	}
	if err = tx.Commit(); err != nil {
		s.publicationMu.Unlock()
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	if s.publications == nil {
		s.publications = make(map[string]publishedSnapshot)
	}
	s.publications[p.ServerID] = publishedSnapshot{p, packet.Key, issued, s.now()}
	s.publicationMu.Unlock()
	identity.JSON(w, http.StatusOK, map[string]bool{"published": true})
}
func (s *Service) snapshot(d registry.Descriptor) (publishedSnapshot, bool) {
	s.publicationMu.Lock()
	defer s.publicationMu.Unlock()
	p, ok := s.publications[d.ID]
	if ok && (d.Status == "removed" || p.Key != d.PublicKey || p.Publication.Revision != d.Revision) {
		return publishedSnapshot{}, false
	}
	return p, ok
}
func (s *Service) fresh(p publishedSnapshot, d registry.Descriptor) bool {
	return d.Online && p.Received.After(s.now().Add(-registry.PublicationLifetime))
}
func publishedRoom(room registry.PublishedRoom, d registry.Descriptor, p publishedSnapshot) directoryRoom {
	return directoryRoom{room, registry.RoomRef(d.ID, room.ID), d.Name, d.Origin, d.Region, p.Received}
}
func (s *Service) publicRooms(w http.ResponseWriter, r *http.Request) {
	if ref := r.PathValue("ref"); ref != "" {
		server, room, valid := registry.ParseRoomRef(ref)
		if !valid {
			identity.Error(w, http.StatusBadRequest, "invalid_room_reference")
			return
		}
		d, err := s.readServer(r.Context(), s.DB, server, false)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			identity.Error(w, http.StatusServiceUnavailable, "catalog_unavailable")
			return
		}
		if err != nil || d.Status == "removed" {
			identity.Error(w, http.StatusNotFound, "room_not_found")
			return
		}
		p, ok := s.snapshot(d)
		if !ok || !s.fresh(p, d) {
			identity.Error(w, http.StatusServiceUnavailable, "room_unavailable")
			return
		}
		for _, entry := range p.Publication.Rooms {
			if entry.ID == room {
				identity.JSON(w, http.StatusOK, map[string]any{"room": publishedRoom(entry, d, p), "server": publicServer(d)})
				return
			}
		}
		identity.Error(w, http.StatusNotFound, "room_not_found")
		return
	}
	ds, err := s.listServers(r.Context(), "")
	if err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "catalog_unavailable")
		return
	}
	rooms := []directoryRoom{}
	for _, d := range ds {
		p, ok := s.snapshot(d)
		if !ok || !s.fresh(p, d) {
			continue
		}
		for _, room := range p.Publication.Rooms {
			rooms = append(rooms, publishedRoom(room, d, p))
		}
	}
	sort.Slice(rooms, func(i, j int) bool {
		if rooms[i].Name == rooms[j].Name {
			return rooms[i].Ref < rooms[j].Ref
		}
		return rooms[i].Name < rooms[j].Name
	})
	identity.JSON(w, http.StatusOK, map[string]any{"schema": roomCatalogSchemaVersion, "rooms": rooms, "updatedAt": s.now()})
}

type managedServer struct {
	Release releaseStatus `json:"release"`
	registry.Descriptor
	Role               string `json:"role"`
	AssignmentVerified bool   `json:"assignmentVerified"`
}

func (s *Service) managementServers(ctx context.Context, account string) ([]managedServer, error) {
	// One query covers owned, incoming and delegated servers, including offline entries.
	ds, err := s.queryServers(ctx, "", true)
	if err != nil {
		return nil, err
	}
	result := []managedServer{}
	for _, d := range ds {
		p, ok := s.snapshot(d)
		role := ""
		if d.Owner == account {
			role = "owner"
		} else if ok {
			for _, a := range p.Publication.Staff {
				if a.Account == account {
					role = a.Role
					break
				}
			}
		}
		if role == "" && d.TransferTo != account {
			continue
		}
		verified := role == "owner" || ok && s.fresh(p, d)
		if role != "owner" && d.TransferTo != account {
			// Delegated readers receive connection data, never ownership operations or candidates.
			d = registry.Descriptor{ID: d.ID, Name: d.Name, Region: d.Region, Origin: d.Origin, PublicKey: d.PublicKey, Online: d.Online, Compatible: d.Compatible, Status: d.Status}
		}
		result = append(result, managedServer{Release: s.serverRelease(d), Descriptor: d, Role: role, AssignmentVerified: verified})
	}
	return result, nil
}
