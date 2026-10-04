package wire

import "baboreborn/backend/core"

// RemoteState contains only contact/interpolation and presentation inputs. It is
// deliberately not a core.Player: missing mechanics must never become zeroes.
type RemoteState struct {
	X         float64         `json:"x"`
	Y         float64         `json:"y"`
	Angle     float64         `json:"angle"`
	Cooldown  float64         `json:"cooldown"`
	Equipment RemoteEquipment `json:"equipment"`
}

type RemoteEquipment struct {
	Primary    string  `json:"primary"`
	Secondary  string  `json:"secondary"`
	Shells     int     `json:"shells"`
	Charge     float64 `json:"charge"`
	SinceShot  float64 `json:"sinceShot"`
	Protection float64 `json:"protection"`
	MeleeDelay float64 `json:"meleeDelay"`
}

type RemotePlayer struct {
	Team           string      `json:"team"`
	Nickname       string      `json:"nickname"`
	NicknameColors string      `json:"nicknameColors,omitempty"`
	Appearance     Appearance  `json:"appearance"`
	ID             int         `json:"id"`
	State          RemoteState `json:"state"`
	HP             float64     `json:"hp"`
	Status         string      `json:"status"`
	Life           int         `json:"life"`
	BornTick       int         `json:"bornTick"`
}

// LocalCheckpoint is complete even for spectators/dead players. Identity and
// life metadata come from the same capture's shared roster, joined by ID.
type LocalCheckpoint struct {
	ID       int         `json:"id"`
	State    core.Player `json:"state"`
	Ack      int         `json:"ack"`
	DiedTick int         `json:"diedTick"`
	Seed     uint32      `json:"seed"`
}

type RecipientSnapshot struct {
	Snapshot
	Players []RemotePlayer   `json:"players"`
	Local   *LocalCheckpoint `json:"local"`
}

func (p Player) Remote() RemotePlayer {
	e := p.State.Equipment
	return RemotePlayer{Team: p.Team, Nickname: p.Nickname, NicknameColors: p.NicknameColors, Appearance: p.Appearance,
		ID: p.ID, HP: p.HP, Status: p.Status, Life: p.Life, BornTick: p.BornTick,
		State: RemoteState{X: p.State.X, Y: p.State.Y, Angle: p.State.Angle, Cooldown: p.State.Cooldown,
			Equipment: RemoteEquipment{Primary: e.Primary, Secondary: e.Secondary, Shells: e.Shells,
				Charge: e.Charge, SinceShot: e.SinceShot, Protection: e.Protection, MeleeDelay: e.MeleeDelay}}}
}

func (p Player) Checkpoint() LocalCheckpoint {
	return LocalCheckpoint{ID: p.ID, State: p.State, Ack: p.Ack, Seed: p.Seed, DiedTick: p.DiedTick}
}

// ForRecipient is used for complete installations. Ordinary publication encodes
// the shared roster and each owner's checkpoint once, then selects encoded bytes.
func (s Snapshot) ForRecipient(id int) RecipientSnapshot {
	out := RecipientSnapshot{Snapshot: s, Players: project(s.Players, Player.Remote)}
	for _, p := range s.Players {
		if p.ID == id {
			local := p.Checkpoint()
			out.Local = &local
			break
		}
	}
	return out
}
