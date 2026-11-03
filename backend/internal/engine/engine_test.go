package engine

import (
	"testing"
	"time"

	"lumieres/backend/internal/model"
)

type testClock struct{ t time.Time }

func (c *testClock) now() time.Time { return c.t }
func (c *testClock) add(ms int)     { c.t = c.t.Add(time.Duration(ms) * time.Millisecond) }
func newTest() (*Engine, *testClock) {
	e := New()
	c := &testClock{t: time.Unix(1000, 0)}
	e.clock = c.now
	return e, c
}

func rgb(id string, addr int) model.Fixture {
	return model.Fixture{ID: id, Name: id, Address: addr, Channels: []model.Channel{
		{Key: "red", Type: model.ChRed}, {Key: "green", Type: model.ChGreen}, {Key: "blue", Type: model.ChBlue},
	}}
}

func dimRgb(id string, addr int) model.Fixture {
	return model.Fixture{ID: id, Name: id, Address: addr, Channels: []model.Channel{
		{Key: "dimmer", Type: model.ChDimmer}, {Key: "red", Type: model.ChRed}, {Key: "green", Type: model.ChGreen}, {Key: "blue", Type: model.ChBlue},
	}}
}

func TestBlueThenGreenWithCrossfade(t *testing.T) {
	e, c := newTest()
	e.SetFixtures([]model.Fixture{rgb("a", 1)})
	e.SetScenes([]model.Scene{{ID: "repas", Steps: []model.Step{
		{DurationMs: 5000, Looks: model.Look{"a": {"blue": 255}}},
		{DurationMs: 5000, FadeMs: 1000, Looks: model.Look{"a": {"green": 255}}},
	}}})
	if err := e.Play("repas", 0); err != nil {
		t.Fatal(err)
	}
	f := e.Tick()
	if f[2] != 255 || f[1] != 0 {
		t.Fatalf("step 1 should be blue, got %v", f[:3])
	}
	c.add(5500) // halfway through the 1 s fade
	f = e.Tick()
	if f[2] < 120 || f[2] > 135 || f[1] < 120 || f[1] > 135 {
		t.Fatalf("expected a half crossfade, got %v", f[:3])
	}
	c.add(600)
	f = e.Tick()
	if f[1] != 255 || f[2] != 0 {
		t.Fatalf("step 2 should be green, got %v", f[:3])
	}
}

func TestSceneOnlyDrivesItsFixtures(t *testing.T) {
	e, _ := newTest()
	e.SetFixtures([]model.Fixture{rgb("a", 1), rgb("b", 4)})
	e.SetScenes([]model.Scene{{ID: "s", Steps: []model.Step{{DurationMs: 1000, Looks: model.Look{"a": {"red": 200}}}}}})
	_ = e.Play("s", 0)
	f := e.Tick()
	if f[0] != 200 || f[3] != 0 {
		t.Fatalf("got %v", f[:6])
	}
}

func TestColorOpensRestingDimmer(t *testing.T) {
	e, _ := newTest()
	e.SetFixtures([]model.Fixture{dimRgb("a", 1)})
	e.Live([]string{"a"}, map[string]int{"blue": 255})
	f := e.Tick()
	if f[0] != 255 || f[3] != 255 {
		t.Fatalf("colour alone must light the fixture, got %v", f[:4])
	}
}

func TestDimmerOnFixtureWithoutDimmerChannel(t *testing.T) {
	e, _ := newTest()
	e.SetFixtures([]model.Fixture{rgb("a", 1)})
	e.Live([]string{"a"}, map[string]int{"red": 200, "dimmer": 128})
	f := e.Tick()
	if f[0] < 98 || f[0] > 103 {
		t.Fatalf("virtual dimmer should halve red, got %d", f[0])
	}
}

func TestMasterAndBlackout(t *testing.T) {
	e, _ := newTest()
	moving := model.Fixture{ID: "m", Name: "m", Address: 10, Channels: []model.Channel{
		{Key: "pan", Type: model.ChPan, Default: 100}, {Key: "dimmer", Type: model.ChDimmer},
	}}
	fog := model.Fixture{ID: "f", Name: "f", Address: 20, Channels: []model.Channel{{Key: "fog", Type: model.ChFog}}}
	e.SetFixtures([]model.Fixture{moving, fog})
	e.Live([]string{"m"}, map[string]int{"dimmer": 200})
	e.Live([]string{"f"}, map[string]int{"fog": 255})
	e.SetMaster(0.5)
	f := e.Tick()
	if f[10] != 100 {
		t.Fatalf("master should scale dimmer, got %d", f[10])
	}
	if f[19] != 255 {
		t.Fatalf("master must not scale fog, got %d", f[19])
	}
	e.SetBlackout(true)
	f = e.Tick()
	if f[10] != 0 || f[19] != 0 {
		t.Fatalf("blackout must cut light and fog, got dim=%d fog=%d", f[10], f[19])
	}
	if f[9] != 100 {
		t.Fatalf("blackout must keep pan, got %d", f[9])
	}
}

func TestLiveFogExpiresWithoutRefresh(t *testing.T) {
	e, c := newTest()
	e.SetFixtures([]model.Fixture{{ID: "f", Name: "f", Address: 1, Channels: []model.Channel{{Key: "fog", Type: model.ChFog}}}})
	e.Live([]string{"f"}, map[string]int{"fog": 255})
	if f := e.Tick(); f[0] != 255 {
		t.Fatalf("fog should fire, got %d", f[0])
	}
	c.add(1000)
	e.Live([]string{"f"}, map[string]int{"fog": 255})
	c.add(1000)
	if f := e.Tick(); f[0] != 255 {
		t.Fatalf("refreshed fog should keep firing, got %d", f[0])
	}
	c.add(2000)
	if f := e.Tick(); f[0] != 0 {
		t.Fatalf("fog must stop when the client goes silent, got %d", f[0])
	}
}

func TestPlayReleasesLiveAndEndHolds(t *testing.T) {
	e, c := newTest()
	e.SetFixtures([]model.Fixture{rgb("a", 1)})
	e.SetScenes([]model.Scene{{ID: "s", Steps: []model.Step{{DurationMs: 1000, Looks: model.Look{"a": {"red": 50}}}}}})
	e.Live([]string{"a"}, map[string]int{"red": 255})
	_ = e.Play("s", 0)
	if f := e.Tick(); f[0] != 50 {
		t.Fatalf("scene must take over from live, got %d", f[0])
	}
	c.add(5000)
	f := e.Tick()
	if f[0] != 50 || !e.Status().Playback.Finished {
		t.Fatalf("last step should hold, got %d, status %+v", f[0], e.Status().Playback)
	}
}

func TestLoopWraps(t *testing.T) {
	e, c := newTest()
	e.SetFixtures([]model.Fixture{rgb("a", 1)})
	e.SetScenes([]model.Scene{{ID: "s", Loop: true, Steps: []model.Step{
		{DurationMs: 1000, Looks: model.Look{"a": {"red": 10}}},
		{DurationMs: 1000, Looks: model.Look{"a": {"red": 20}}},
	}}})
	_ = e.Play("s", 0)
	c.add(2100)
	if f := e.Tick(); f[0] != 10 {
		t.Fatalf("should be back on step 1, got %d", f[0])
	}
}

func TestMultiCellColorDrivesAllCells(t *testing.T) {
	e, _ := newTest()
	e.SetFixtures([]model.Fixture{{ID: "a", Name: "a", Address: 1, Channels: []model.Channel{
		{Key: "red", Type: model.ChRed}, {Key: "red_2", Type: model.ChRed},
	}}})
	e.Live([]string{"a"}, map[string]int{"red": 180})
	if f := e.Tick(); f[0] != 180 || f[1] != 180 {
		t.Fatalf("got %v", f[:2])
	}
}

func TestPreviewNeverFiresFog(t *testing.T) {
	e, _ := newTest()
	e.SetFixtures([]model.Fixture{
		{ID: "f", Name: "f", Address: 1, Channels: []model.Channel{{Key: "fog", Type: model.ChFog}}},
		rgb("a", 2),
	})
	e.SetScenes([]model.Scene{{ID: "s", Steps: []model.Step{{DurationMs: 1000, Looks: model.Look{"f": {"fog": 255}}}}}})
	e.Preview(model.Look{"f": {"fog": 255}, "a": {"red": 200}})
	if f := e.Tick(); f[0] != 0 || f[1] != 200 {
		t.Fatalf("preview should show the colour but not fire the fog, got %v", f[:2])
	}
	_ = e.Play("s", 0)
	if f := e.Tick(); f[0] != 255 {
		t.Fatalf("the playing scene should fire the fog, got %d", f[0])
	}
}
