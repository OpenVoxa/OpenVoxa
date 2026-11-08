// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/openvoxa/openvoxa/server/internal/db"
	"github.com/openvoxa/openvoxa/server/internal/hub"
	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// mayDMSQL lists the switches that let an account send DMs: all of them.
// A new switch must be added there too, or its holders (staff) would lose
// the "staff can always DM" rule.
func TestDMSwitchList(t *testing.T) {
	got := regexp.MustCompile(`'([a-z_]+)'`).FindAllStringSubmatch(dmSwitchesSQL, -1)
	var names []string
	for _, m := range got {
		names = append(names, m[1])
	}
	var want []string
	for _, p := range perm.All {
		want = append(want, string(p))
	}
	sort.Strings(names)
	sort.Strings(want)
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("dmSwitchesSQL = %v, perm.All = %v", names, want)
	}
}

func TestStaffIgnoresDirectMessages(t *testing.T) {
	if perm.NewSet([]string{"direct_messages"}).Staff() {
		t.Fatal("direct_messages alone must not make an account staff")
	}
	if !perm.NewSet([]string{"direct_messages", "ban"}).Staff() {
		t.Fatal("ban is a staff switch")
	}
}

// The database tests need a throwaway Postgres; they are skipped without
// one. OPENVOXA_TEST_DATABASE_URL must point at an empty database: the
// test migrates it and leaves its rows behind.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("OPENVOXA_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("OPENVOXA_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

type dmFixture struct {
	t    *testing.T
	pool *pgxpool.Pool
	api  *API
}

func (f *dmFixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.pool.Exec(context.Background(), sql, args...); err != nil {
		f.t.Fatalf("%s: %v", sql, err)
	}
}

// user creates an account in the named groups, with one device.
func (f *dmFixture) user(name string, groups ...string) string {
	f.t.Helper()
	ctx := context.Background()
	var id string
	if err := f.pool.QueryRow(ctx,
		`INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id::text`,
		name).Scan(&id); err != nil {
		f.t.Fatal(err)
	}
	for _, g := range groups {
		f.exec(`INSERT INTO user_perm_groups (user_id, group_id)
		        SELECT $1, id FROM perm_groups WHERE name = $2`, id, g)
	}
	f.exec(`INSERT INTO devices (user_id, signature_key) VALUES ($1, '\x00')`, id)
	return id
}

// call runs a handler as userID and decodes the JSON answer into out.
func (f *dmFixture) call(h http.HandlerFunc, userID, method, path, body string, out any) int {
	f.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for _, part := range strings.Split(path, "/") {
		if uuidPattern.MatchString(part) {
			req.SetPathValue("id", part)
		}
	}
	req = req.WithContext(context.WithValue(req.Context(), sessionKey, Session{UserID: userID}))
	rec := httptest.NewRecorder()
	h(rec, req)
	if out != nil && rec.Code < 300 {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			f.t.Fatalf("%s %s: %v (%s)", method, path, err, rec.Body.String())
		}
	}
	return rec.Code
}

func (f *dmFixture) canPost(userID, channelID string) bool {
	f.t.Helper()
	p, err := f.api.channelPermsFor(context.Background(), Session{UserID: userID}, channelID)
	if err != nil {
		f.t.Fatalf("channelPermsFor: %v", err)
	}
	return p.CanPost
}

func (f *dmFixture) canView(userID, channelID string) bool {
	f.t.Helper()
	ok, err := f.api.userCanView(context.Background(), userID, channelID)
	if err != nil {
		f.t.Fatal(err)
	}
	return ok
}

func TestDMAccess(t *testing.T) {
	pool := testPool(t)
	f := &dmFixture{t: t, pool: pool, api: &API{pool: pool, hub: hub.New()}}

	// Unique names, so the test can run again on the same database.
	sfx := "-" + randomSuffix(t)
	alice := f.user("alice"+sfx, "Member")
	bob := f.user("bob"+sfx, "Member")
	admin := f.user("admin"+sfx, "Member", "Administrator")
	mod := f.user("mod"+sfx, "Moderator") // staff, without Member's switch
	guest := f.user("guest"+sfx)          // Everyone only: no switch

	// alice starts a DM with bob; a second call gets the same one.
	var dm dmResponse
	if code := f.call(f.api.startDM, alice, "POST", "/api/v1/dms", `{"user_id":"`+bob+`"}`, &dm); code != http.StatusCreated {
		t.Fatalf("start DM: %d", code)
	}
	var again dmResponse
	if code := f.call(f.api.startDM, bob, "POST", "/api/v1/dms", `{"user_id":"`+alice+`"}`, &again); code != http.StatusOK || again.ChannelID != dm.ChannelID {
		t.Fatalf("bob's get-or-create: %d %s, want 200 %s", code, again.ChannelID, dm.ChannelID)
	}
	ch := dm.ChannelID

	t.Run("only the two", func(t *testing.T) {
		if !f.canView(alice, ch) || !f.canView(bob, ch) {
			t.Fatal("both people must see their DM")
		}
		if f.canView(admin, ch) {
			t.Fatal("an administrator must not see someone else's DM")
		}
		if _, err := f.api.channelPermsFor(context.Background(), Session{UserID: admin}, ch); err != errChannelNotFound {
			t.Fatalf("admin channelPermsFor: %v, want not found", err)
		}
		devs, err := f.api.allowedDevices(context.Background(), ch, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range devs {
			if d.UserID != alice && d.UserID != bob {
				t.Fatalf("allowed devices include %s", d.Username)
			}
		}
		if len(devs) != 2 {
			t.Fatalf("allowed devices: %d, want 2", len(devs))
		}
		if !f.canPost(alice, ch) || !f.canPost(bob, ch) {
			t.Fatal("both may post")
		}
	})

	t.Run("not in the channel list", func(t *testing.T) {
		var list []channelResponse
		f.call(f.api.listChannels, admin, "GET", "/api/v1/channels", "", &list)
		for _, c := range list {
			if c.Kind == "dm" {
				t.Fatal("listChannels shows a DM to an administrator")
			}
		}
		f.call(f.api.listChannels, alice, "GET", "/api/v1/channels", "", &list)
		for _, c := range list {
			if c.Kind == "dm" {
				t.Fatal("listChannels shows a DM to its member")
			}
		}
		var dms []dmResponse
		f.call(f.api.listDMs, alice, "GET", "/api/v1/dms", "", &dms)
		if len(dms) != 1 || dms[0].ChannelID != ch || dms[0].User.ID != bob {
			t.Fatalf("alice's DMs: %+v", dms)
		}
	})

	t.Run("admin endpoints refuse DMs", func(t *testing.T) {
		for _, c := range []struct {
			h    http.HandlerFunc
			m, b string
			path string
		}{
			{f.api.deleteChannel, "DELETE", "", "/api/v1/channels/" + ch},
			{f.api.renameChannel, "PATCH", `{"name":"hijack"}`, "/api/v1/channels/" + ch + "/name"},
		} {
			if code := f.call(c.h, admin, c.m, c.path, c.b, nil); code != http.StatusNotFound {
				t.Errorf("%s %s: %d, want 404", c.m, c.path, code)
			}
		}
		if !f.canView(alice, ch) {
			t.Fatal("the DM is gone")
		}
	})

	t.Run("block", func(t *testing.T) {
		if code := f.call(f.api.putBlock, alice, "PUT", "/api/v1/blocks/"+bob, "", nil); code != http.StatusNoContent {
			t.Fatalf("block: %d", code)
		}
		if f.canPost(alice, ch) || f.canPost(bob, ch) {
			t.Fatal("a block makes the DM read-only for both")
		}
		if !f.canView(bob, ch) {
			t.Fatal("the blocked person still sees the DM")
		}
		var dms []dmResponse
		f.call(f.api.listDMs, alice, "GET", "/api/v1/dms", "", &dms)
		if len(dms) != 0 {
			t.Fatal("the blocker's list must leave it out")
		}
		f.call(f.api.listDMs, bob, "GET", "/api/v1/dms", "", &dms)
		if len(dms) != 1 || dms[0].ReadOnlyReason != "unavailable" {
			t.Fatalf("bob's DMs: %+v", dms)
		}
		var got dmResponse
		f.call(f.api.startDM, alice, "POST", "/api/v1/dms", `{"user_id":"`+bob+`"}`, &got)
		if got.ReadOnlyReason != "you_blocked" {
			t.Fatalf("alice's reason: %q", got.ReadOnlyReason)
		}
		var cands []dmCandidate
		f.call(f.api.listDMCandidates, alice, "GET", "/api/v1/dm-candidates", "", &cands)
		for _, c := range cands {
			if c.ID == bob {
				t.Fatal("the blocker's picker lists the blocked")
			}
		}
		f.call(f.api.deleteBlock, alice, "DELETE", "/api/v1/blocks/"+bob, "", nil)
		if !f.canPost(alice, ch) || !f.canPost(bob, ch) {
			t.Fatal("unblocking restores posting")
		}
	})

	t.Run("switch", func(t *testing.T) {
		// Nobody without a switch: guest can't start one, and nobody can
		// start one with them.
		if code := f.call(f.api.startDM, guest, "POST", "/api/v1/dms", `{"user_id":"`+alice+`"}`, nil); code != http.StatusForbidden {
			t.Fatalf("guest starting a DM: %d, want 403", code)
		}
		if code := f.call(f.api.startDM, alice, "POST", "/api/v1/dms", `{"user_id":"`+guest+`"}`, nil); code != http.StatusForbidden {
			t.Fatalf("DM with guest: %d, want 403", code)
		}
		// Staff can DM without the switch.
		var md dmResponse
		if code := f.call(f.api.startDM, mod, "POST", "/api/v1/dms", `{"user_id":"`+alice+`"}`, &md); code != http.StatusCreated {
			t.Fatalf("moderator starting a DM: %d", code)
		}
		// Taking the switch from Member makes alice's DMs read-only, but
		// the moderator's side still may (staff), so the reason differs.
		f.exec(`UPDATE perm_groups SET permissions = array_remove(permissions, 'direct_messages') WHERE name = 'Member'`)
		defer f.exec(`UPDATE perm_groups SET permissions = array_append(permissions, 'direct_messages') WHERE name = 'Member'`)
		if f.canPost(alice, ch) || f.canPost(mod, md.ChannelID) {
			t.Fatal("losing the switch makes the DM read-only for both")
		}
		var dms []dmResponse
		f.call(f.api.listDMs, alice, "GET", "/api/v1/dms", "", &dms)
		for _, d := range dms {
			if d.ReadOnlyReason != "you_cannot" {
				t.Fatalf("alice's reason: %q", d.ReadOnlyReason)
			}
		}
	})

	t.Run("ban and deletion", func(t *testing.T) {
		f.exec(`INSERT INTO bans (user_id) VALUES ($1)`, bob)
		if f.canPost(alice, ch) {
			t.Fatal("a banned person's DMs are read-only")
		}
		f.exec(`DELETE FROM bans WHERE user_id = $1`, bob)
		f.exec(`UPDATE users SET deleted_at = now() WHERE id = $1`, bob)
		if f.canPost(alice, ch) || !f.canView(alice, ch) {
			t.Fatal("a deleted person's DM stays, read-only")
		}
		var dms []dmResponse
		f.call(f.api.listDMs, alice, "GET", "/api/v1/dms", "", &dms)
		found := false
		for _, d := range dms {
			if d.ChannelID == ch {
				found = true
				if d.ReadOnlyReason != "deleted" || d.User.Username != "" {
					t.Fatalf("deleted DM: %+v", d)
				}
			}
		}
		if !found {
			t.Fatal("the deleted person's DM left the list")
		}
	})
}

func randomSuffix(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	const hex = "0123456789abcdef"
	out := make([]byte, 0, 8)
	for _, c := range b {
		out = append(out, hex[c>>4], hex[c&15])
	}
	return string(out)
}
