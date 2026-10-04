package maps

import (
	"io/fs"
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/server/navigation"
	"baboreborn/content"
)

func TestNewArenasHaveConnectedRoutesAndVerticalCover(t *testing.T) {
	for _, c := range []struct {
		id            string
		width, height float64
		spawns        int
		low, tall     [2]core.Vec2
	}{
		{"cryo-lab", 28, 28, 12, [2]core.Vec2{{X: 4.5, Y: 12}, {X: 4.5, Y: 14.5}}, [2]core.Vec2{{X: 9, Y: 10.5}, {X: 13, Y: 10.5}}},
		{"neon-relay", 32, 24, 12, [2]core.Vec2{{X: 6.5, Y: 4.5}, {X: 6.5, Y: 6.5}}, [2]core.Vec2{{X: 6, Y: 11.5}, {X: 10, Y: 11.5}}},
		{"kiln", 16, 16, 8, [2]core.Vec2{{X: 5.5, Y: 3.5}, {X: 5.5, Y: 5.5}}, [2]core.Vec2{{X: 8, Y: 6.5}, {X: 8, Y: 9.5}}},
		{"switchback", 16, 32, 12, [2]core.Vec2{{X: 2.5, Y: 8.5}, {X: 4.5, Y: 8.5}}, [2]core.Vec2{{X: 5.5, Y: 14.5}, {X: 5.5, Y: 17.5}}},
		{"bastion", 32, 32, 16, [2]core.Vec2{{X: 16, Y: 4.5}, {X: 16, Y: 6.5}}, [2]core.Vec2{{X: 8.5, Y: 10}, {X: 11.5, Y: 10}}},
		{"ion-foundry", 16, 16, 8, [2]core.Vec2{{X: 3.5, Y: 6.5}, {X: 5.5, Y: 6.5}}, [2]core.Vec2{{X: 3.5, Y: 4.5}, {X: 6.5, Y: 4.5}}},
		{"thorn-chapel", 16, 16, 8, [2]core.Vec2{{X: 6.5, Y: 7.5}, {X: 9.5, Y: 7.5}}, [2]core.Vec2{{X: 3.5, Y: 4.5}, {X: 6.5, Y: 4.5}}},
		{"neon-divide", 16, 32, 12, [2]core.Vec2{{X: 7.5, Y: 13.5}, {X: 7.5, Y: 15.5}}, [2]core.Vec2{{X: 3.5, Y: 7.5}, {X: 7.5, Y: 7.5}}},
		{"broadside", 32, 16, 12, [2]core.Vec2{{X: 8, Y: 1.5}, {X: 8, Y: 3.5}}, [2]core.Vec2{{X: 4.5, Y: 7.5}, {X: 10.5, Y: 7.5}}},
		{"crownfall", 32, 32, 16, [2]core.Vec2{{X: 14.5, Y: 15.5}, {X: 17.5, Y: 15.5}}, [2]core.Vec2{{X: 7.5, Y: 8.5}, {X: 11.5, Y: 8.5}}},
	} {
		t.Run(c.id, func(t *testing.T) {
			data, err := fs.ReadFile(content.Files, "maps/"+c.id+".json")
			if err != nil {
				t.Fatal(err)
			}
			a, err := Parse(data)
			if err != nil {
				t.Fatal(err)
			}
			if a.Width != c.width || a.Height != c.height || len(a.Spawns) != c.spawns {
				t.Fatal("requested dimensions or spawn count changed")
			}
			g := core.NewGrid(core.Wall{W: a.Width, H: a.Height}, a.GeometryWalls())
			nav := navigation.New(g)
			width, height := int(a.Width), int(a.Height)
			for _, wall := range a.Walls {
				if wall.Height <= 0 {
					t.Fatal("authored walls must have explicit vertical height")
				}
			}
			for y := 0; y < height; y++ {
				for x := 0; x < width; x++ {
					if (x == 0 || y == 0 || x == width-1 || y == height-1) && !g.Cells[y*width+x] {
						t.Fatal("perimeter has a hole")
					}
				}
			}
			// Traverse actual navigator-clear edges, including player radius and clearance.
			start := int(a.Spawns[0].Y)*width + int(a.Spawns[0].X)
			seen := map[int]bool{start: true}
			queue := []int{start}
			center := func(i int) core.Vec2 { return core.Vec2{X: float64(i%width) + .5, Y: float64(i/width) + .5} }
			for head := 0; head < len(queue); head++ {
				at := queue[head]
				for _, next := range []int{at - 1, at + 1, at - width, at + width} {
					if next < 0 || next >= len(g.Cells) || g.Cells[next] || seen[next] || !nav.CanTravel(center(at), center(next)) {
						continue
					}
					seen[next] = true
					queue = append(queue, next)
				}
			}
			for i, solid := range g.Cells {
				if !solid && !seen[i] {
					t.Fatalf("unreachable floor cell %v", center(i))
				}
			}
			for _, spawn := range a.Spawns {
				exits := 0
				for _, d := range []core.Vec2{{X: 1}, {X: -1}, {Y: 1}, {Y: -1}} {
					if nav.CanTravel(spawn, core.Vec2{X: spawn.X + d.X, Y: spawn.Y + d.Y}) {
						exits++
					}
				}
				if exits < 2 {
					t.Fatalf("spawn %v has fewer than two clear exits", spawn)
				}
				for _, target := range a.Spawns {
					if _, ok := nav.Waypoint(spawn, target); !ok {
						t.Fatalf("no bot route from %v to %v", spawn, target)
					}
				}
			}
			for _, ray := range []struct {
				segment [2]core.Vec2
				z       float64
				blocked bool
			}{{c.low, .25, true}, {c.low, 1.5, false}, {c.tall, 1.5, true}, {c.tall, 5.5, false}} {
				from, to := ray.segment[0], ray.segment[1]
				_, normal := core.MapImpact(core.Vec3{X: from.X, Y: from.Y, Z: ray.z}, core.Vec3{X: to.X, Y: to.Y, Z: ray.z}, a.GeometryWalls(), .7)
				if (normal != nil) != ray.blocked {
					t.Fatalf("cover at height %v: blocked=%v, want %v", ray.z, normal != nil, ray.blocked)
				}
			}
			t.Logf("%dx%d: %d connected floor cells, %d spawns, low/tall ballistic cover verified", width, height, len(seen), len(a.Spawns))
		})
	}
}

func TestCTFTeamRoutesAndClearance(t *testing.T) {
	for _, data := range testcontent.Maps() {
		a, err := Parse(data)
		if err != nil {
			t.Fatal(err)
		}
		if a.Teams == nil {
			t.Fatalf("%s lacks a CTF team layout", a.ID)
		}
		nav := navigation.New(core.NewGrid(core.Wall{W: a.Width, H: a.Height}, a.GeometryWalls()))
		for _, side := range []TeamBase{a.Teams.Blue, a.Teams.Red} {
			for _, spawn := range side.Spawns {
				for _, base := range []core.Vec2{a.Teams.Blue.Base, a.Teams.Red.Base} {
					if _, ok := nav.Waypoint(spawn, base); !ok {
						t.Fatalf("no route %v -> %v", spawn, base)
					}
				}
			}
		}
		broken := a
		teams := *a.Teams
		broken.Teams = &teams
		broken.Teams.Blue.Base = core.Vec2{}
		if broken.Validate() == nil {
			t.Fatal("base outside playable area accepted")
		}

	}
}
