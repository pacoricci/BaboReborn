package central

import (
	"time"

	"baboreborn/backend/registry"
	"baboreborn/backend/release"
)

type releaseObservation struct {
	Key, Origin string
	Probe       registry.Probe
	Expected    registry.Compatibility
	CheckedAt   time.Time
}

type releaseStatus struct {
	Installed   string                        `json:"installed"`
	Recommended string                        `json:"recommended"`
	Status      string                        `json:"status"`
	CheckedAt   *time.Time                    `json:"checkedAt"`
	Differences []registry.ContractDifference `json:"differences"`
	NotesURL    string                        `json:"notesUrl"`
}

// Observations are ephemeral, like room publications. Restarting central requires
// a fresh signed probe; registration and its durable admission verdict stay separate.
func (s *Service) observeRelease(id, key, origin string, probe *registry.Probe, checkedAt time.Time) {
	s.releaseMu.Lock()
	defer s.releaseMu.Unlock()
	if s.releaseObservations == nil {
		s.releaseObservations = make(map[string]releaseObservation)
	}
	if previous, ok := s.releaseObservations[id]; ok && previous.CheckedAt.After(checkedAt) {
		return
	}
	if probe == nil || s.VerifierRegistry == nil {
		delete(s.releaseObservations, id)
		return
	}
	s.releaseObservations[id] = releaseObservation{key, origin, *probe, s.VerifierRegistry.Expected, checkedAt}
}

func (s *Service) serverRelease(d registry.Descriptor) releaseStatus {
	result := releaseStatus{Recommended: release.Version, Status: "unknown", Differences: []registry.ContractDifference{}, NotesURL: release.Notes(release.Version)}
	s.releaseMu.Lock()
	observation, ok := s.releaseObservations[d.ID]
	s.releaseMu.Unlock()
	if !ok || observation.Key != d.PublicKey || observation.Origin != d.Origin {
		return result
	}
	result.Installed = observation.Probe.Release
	result.CheckedAt = &observation.CheckedAt
	if s.VerifierRegistry == nil || observation.Expected != s.VerifierRegistry.Expected || !observation.CheckedAt.After(s.now().Add(-registry.Presence)) {
		return result
	}
	result.Differences = s.VerifierRegistry.Expected.Differences(observation.Probe.Compatibility)
	older := release.Older(result.Installed, result.Recommended)
	if len(result.Differences) != 0 {
		result.Status = "incompatible"
		if older {
			result.Status = "update_required"
		}
	} else if older {
		result.Status = "update_available"
	} else if release.Stable(result.Installed) && result.Installed == result.Recommended {
		result.Status = "current"
	} else {
		result.Status = "compatible"
	}
	return result
}
