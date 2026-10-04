package core

import "testing"

func TestPlayerEquipmentHasValueOwnership(t *testing.T) {
	player := NewPlayer(Vec2{X: 4, Y: 4}, 0)
	if player.Equipment.Primary != "smg" || player.Equipment.Grenades != 2 {
		t.Fatal("ordinary player must start with complete equipment")
	}
	checkpoint := player
	updateEquipment(&player, .1)
	act(&player, Input{Secondary: true})
	if player.Equipment.MeleeDelay == 0 || checkpoint.Equipment.MeleeDelay != 0 {
		t.Fatal("action state must mutate the player without changing copied checkpoints")
	}
}
