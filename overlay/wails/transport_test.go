package main

import (
	"context"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// End-to-end smoke over the xport surface: bind the events socket,
// answer /api/xport/info, take a page log line, then dial the ws and
// push a sub frame — the same Accept path the WebView2 page hits.
func TestXportSurface(t *testing.T) {
	if err := wsStart(); err != nil {
		t.Fatalf("wsStart: %v", err)
	}
	h := apiHandler(t.TempDir())

	info := httptest.NewRecorder()
	h.ServeHTTP(info, httptest.NewRequest("GET", "/api/xport/info", nil))
	if info.Code != 200 || !strings.Contains(info.Body.String(), wsAddr) {
		t.Fatalf("info: %d %q", info.Code, info.Body.String())
	}

	lg := httptest.NewRecorder()
	h.ServeHTTP(lg, httptest.NewRequest("POST", "/api/xport/log",
		strings.NewReader("hello from test")))
	if lg.Code != 204 {
		t.Fatalf("log endpoint: %d", lg.Code)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws://"+wsAddr+"/events", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if err := c.Write(ctx, websocket.MessageText,
		[]byte(`{"t":"sub"}`)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := c.Close(websocket.StatusNormalClosure, "done"); err != nil {
		t.Fatalf("close: %v", err)
	}
}

// The mutex claim is what keeps a doomed second instance from draining
// the survivor's mailbox — first caller wins, second loses.
func TestXportClaim(t *testing.T) {
	if !xportClaim("test-inst") {
		t.Fatal("first claim lost")
	}
	if xportClaim("test-inst") {
		t.Fatal("second claim on same inst won")
	}
	if !xportClaim("test-inst-other") {
		t.Fatal("different inst should claim fine")
	}
}

// Same claim, but the loser is a real second process: the parent test
// holds the inst mutex while a re-executed child tries to take it —
// the child must lose the same-inst claim and win a different-inst one.
func TestXportClaimAcrossProcesses(t *testing.T) {
	const inst = "mp-test-inst"
	if os.Getenv("XIC_CLAIM_CHILD") == "1" {
		if xportClaim(inst) {
			os.Exit(3) // claimed a held mutex — the bug we're guarding
		}
		if !xportClaim(inst + "-other") {
			os.Exit(4) // couldn't claim a free one
		}
		os.Exit(0)
	}
	if !xportClaim(inst) {
		t.Fatal("parent claim lost")
	}
	cmd := exec.Command(os.Args[0],
		"-test.run=^TestXportClaimAcrossProcesses$")
	cmd.Env = append(os.Environ(), "XIC_CLAIM_CHILD=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("child claimed a held mutex: %v\n%s", err, out)
	}
}
