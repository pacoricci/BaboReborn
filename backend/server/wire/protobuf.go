package wire

import (
	"fmt"
	"math"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	"baboreborn/backend/core"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/wire/pb"
)

// The adapter only maps domain records. The generated Protobuf runtime owns
// number encoding; optional doubles preserve negative zero and subnormals.
type protoEncoder struct{ err error }

func (e *protoEncoder) number(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		e.err = fmt.Errorf("non-finite snapshot number")
	}
	return v
}
func (e *protoEncoder) marshal(v proto.Message) ([]byte, error) {
	if e.err != nil {
		return nil, e.err
	}
	b, err := proto.Marshal(v)
	if err == nil && b == nil {
		b = []byte{}
	}
	return b, err
}

// appendMessage reuses immutable pre-encoded groups without decoding or
// re-encoding them for every recipient. Tags match protocol/snapshot.proto.
func appendMessage(b []byte, field protowire.Number, data []byte) []byte {
	b = protowire.AppendTag(b, field, protowire.BytesType)
	return protowire.AppendBytes(b, data)
}

func (e *protoEncoder) appearance(v Appearance) *pb.Appearance {
	p := new(pb.Appearance)
	p.SetTemplate(v.Template)
	p.SetColors(v.Colors)
	return p
}
func (e *protoEncoder) player(v RemotePlayer, metadata bool) *pb.Player {
	p := new(pb.Player)
	p.SetId(uint64(v.ID))
	p.SetHp(e.number(v.HP))
	p.SetStatus(v.Status)
	p.SetLife(uint64(v.Life))
	p.SetBornTick(int64(v.BornTick))
	p.SetState(e.remotestate(v.State))
	if metadata {
		p.SetTeam(v.Team)
		p.SetNickname(v.Nickname)
		p.SetAppearance(e.appearance(v.Appearance))
	}
	if metadata && v.NicknameColors != "" {
		p.SetNicknameColors(v.NicknameColors)
	}
	return p
}
func (e *protoEncoder) remotestate(v RemoteState) *pb.RemoteState {
	p := new(pb.RemoteState)
	p.SetX(e.position(v.X))
	p.SetY(e.position(v.Y))
	p.SetAngle(e.angle(v.Angle))
	p.SetCooldown(e.number(v.Cooldown))
	p.SetEquipment(e.remoteequipment(v.Equipment))
	return p
}
func (e *protoEncoder) remoteequipment(v RemoteEquipment) *pb.RemoteEquipment {
	p := new(pb.RemoteEquipment)
	p.SetPrimary(v.Primary)
	p.SetSecondary(v.Secondary)
	p.SetShells(uint32(v.Shells))
	p.SetCharge(e.number(v.Charge))
	p.SetSinceShot(e.number(v.SinceShot))
	p.SetProtection(e.number(v.Protection))
	p.SetMeleeDelay(e.number(v.MeleeDelay))
	return p
}
func (e *protoEncoder) local(v LocalCheckpoint) *pb.Local {
	p := new(pb.Local)
	p.SetId(uint64(v.ID))
	p.SetState(e.state(v.State))
	p.SetAck(uint64(v.Ack))
	p.SetDiedTick(int64(v.DiedTick))
	p.SetSeed(uint32(v.Seed))
	return p
}
func EncodeLocal(v LocalCheckpoint) ([]byte, error) {
	e := &protoEncoder{}
	p := e.local(v)
	return e.marshal(p)
}
func (e *protoEncoder) state(v core.Player) *pb.State {
	p := new(pb.State)
	p.SetX(e.number(v.X))
	p.SetY(e.number(v.Y))
	p.SetVx(e.number(v.VX))
	p.SetVy(e.number(v.VY))
	p.SetAngle(e.number(v.Angle))
	p.SetCooldown(e.number(v.Cooldown))
	p.SetSpread(e.number(v.Spread))
	p.SetEquipment(e.equipment(v.Equipment))
	return p
}
func (e *protoEncoder) equipment(v core.Equipment) *pb.Equipment {
	p := new(pb.Equipment)
	p.SetHeat(e.number(v.Heat))
	p.SetOverheated(v.Overheated)
	p.SetCharge(e.number(v.Charge))
	p.SetFireTime(e.number(v.FireTime))
	p.SetSinceShot(e.number(v.SinceShot))
	p.SetScopeHeight(e.number(v.ScopeHeight))
	p.SetRocketActive(v.RocketActive)
	p.SetRocketAge(e.number(v.RocketAge))
	p.SetPrimaryAction(v.PrimaryAction)
	p.SetBarrel(uint32(v.Barrel))
	p.SetSecondaryActivated(v.SecondaryActivated)
	p.SetPrimary(v.Primary)
	p.SetSecondary(v.Secondary)
	p.SetGrenades(uint32(v.Grenades))
	p.SetMolotovs(uint32(v.Molotovs))
	p.SetShells(uint32(v.Shells))
	p.SetMeleeDelay(e.number(v.MeleeDelay))
	p.SetThrowDelay(e.number(v.ThrowDelay))
	p.SetProtection(e.number(v.Protection))
	p.SetAction(v.Action)
	return p
}
func (e *protoEncoder) rules(v MatchRules) *pb.Rules {
	p := new(pb.Rules)
	p.SetMode(v.Mode)
	p.SetScoreLimit(int64(v.ScoreLimit))
	p.SetTimeLimitTicks(int64(v.TimeLimitTicks))
	p.SetRespawnTicks(int64(v.RespawnTicks))
	p.SetEndTicks(int64(v.EndTicks))
	p.SetForceRespawn(v.ForceRespawn)
	return p
}
func EncodeRules(v MatchRules) ([]byte, error) {
	e := &protoEncoder{}
	p := e.rules(v)
	return e.marshal(p)
}
func (e *protoEncoder) scores(v TeamScores) *pb.Scores {
	p := func() *pb.Scores { p := new(pb.Scores); p.SetBlue(int64(v.Blue)); p.SetRed(int64(v.Red)); return p }()
	return p
}
func EncodeScores(v TeamScores) ([]byte, error) {
	e := &protoEncoder{}
	p := e.scores(v)
	return e.marshal(p)
}
func (e *protoEncoder) standing(v Standing) *pb.Standing {
	p := new(pb.Standing)
	p.SetId(uint64(v.ID))
	p.SetTeam(v.Team)
	p.SetScore(int64(v.Score))
	p.SetKills(int64(v.Kills))
	p.SetDeaths(int64(v.Deaths))
	return p
}
func (e *protoEncoder) point(v Point2) *pb.Point {
	p := func() *pb.Point { p := new(pb.Point); p.SetX(e.number(v.X)); p.SetY(e.number(v.Y)); return p }()
	return p
}
func (e *protoEncoder) vec3(v core.Vec3) *pb.Vec3 {
	p := new(pb.Vec3)
	p.SetX(e.number(v.X))
	p.SetY(e.number(v.Y))
	p.SetZ(e.number(v.Z))
	return p
}
func (e *protoEncoder) flag(v Flag) *pb.Flag {
	p := new(pb.Flag)
	p.SetTeam(v.Team)
	p.SetState(v.State)
	p.SetCarrierId(uint64(v.CarrierID))
	p.SetPosition(e.point(v.Position))
	return p
}
func EncodeItem(v Item) ([]byte, error) { e := &protoEncoder{}; p := e.item(v); return e.marshal(p) }
func (e *protoEncoder) projectile(v Projectile) *pb.Projectile {
	p := new(pb.Projectile)
	p.SetId(uint64(v.ID))
	p.SetMotion(v.Motion)
	p.SetMotionTick(uint64(v.MotionTick))
	p.SetPosition(e.vec3(v.Position))
	p.SetVelocity(e.vec3(v.Velocity))
	p.SetExpiresTick(int64(v.ExpiresTick))
	p.SetKind(v.Kind)
	p.SetOwnerId(uint64(v.OwnerID))
	p.SetBornTick(uint64(v.BornTick))
	p.SetAttachedId(uint64(v.AttachedID))
	if v.Turret != nil {
		p.SetTurret(e.turret(*v.Turret))
	}
	return p
}
func EncodeProjectile(v Projectile) ([]byte, error) {
	e := &protoEncoder{}
	p := e.projectile(v)
	return e.marshal(p)
}
func (e *protoEncoder) turret(v Turret) *pb.Turret {
	p := new(pb.Turret)
	p.SetAngle(e.number(v.Angle))
	p.SetLastShotTick(uint64(v.LastShotTick))
	return p
}

func EncodePlayers(players []RemotePlayer, metadata bool) ([]byte, error) {
	if len(players) > match.MaxPlayers {
		return nil, fmt.Errorf("roster exceeds room capacity")
	}
	e := &protoEncoder{}
	var out []byte
	for _, v := range players {
		p := e.player(v, metadata)
		b, err := e.marshal(p)
		if err != nil {
			return nil, err
		}
		out = appendMessage(out, 4, b)
	}
	return out, nil
}
func EncodeFlags(values []Flag) ([]byte, error) {
	e := &protoEncoder{}
	p := new(pb.Flags)
	p.SetValues(make([]*pb.Flag, 0, len(values)))
	for _, v := range values {
		p.SetValues(append(p.GetValues(), e.flag(v)))
	}
	return e.marshal(p)
}
func EncodeRanking(values []Standing) ([]byte, error) {
	e := &protoEncoder{}
	p := new(pb.Ranking)
	p.SetValues(make([]*pb.Standing, 0, len(values)))
	for _, v := range values {
		p.SetValues(append(p.GetValues(), e.standing(v)))
	}
	return e.marshal(p)
}

func (e *protoEncoder) item(v Item) *pb.Item {
	p := new(pb.Item)
	p.SetId(uint64(v.ID))
	p.SetMotion(v.Motion)
	p.SetMotionTick(uint64(v.MotionTick))
	p.SetPosition(e.vec3(v.Position))
	p.SetVelocity(e.vec3(v.Velocity))
	p.SetExpiresTick(int64(v.ExpiresTick))
	p.SetKind(v.Kind)
	if v.Primary != "" {
		p.SetPrimary(v.Primary)
	}
	return p
}
