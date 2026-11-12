// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openvoxa/openvoxa/server/internal/hub"
	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// TestCategoryAccess: category permissions and channels that follow them
// (categories.go, "Category permissions"). Needs a database, like
// TestDMAccess.
func TestCategoryAccess(t *testing.T) {
	pool := testPool(t)
	f := &dmFixture{t: t, pool: pool, api: &API{pool: pool, hub: hub.New()}}
	ctx := context.Background()

	sfx := "-" + randomSuffix(t)
	admin := f.user("cadmin"+sfx, "Member", "Administrator")
	member := f.user("cmember"+sfx, "Member")
	mod := f.user("cmod"+sfx, "Member", "Moderator")

	groupID := func(name string) string {
		var id string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM perm_groups WHERE name = $1`, name).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	modGroup := groupID("Moderator")
	staffOnly := `[{"group_id":"` + modGroup + `","can_post":true}]`

	// Handlers that check manage_channels read it from the session.
	as := func(h http.HandlerFunc, method, path, body string, out any) int {
		t.Helper()
		return f.callPerms(h, admin, perm.Set{perm.Administrator: true, perm.ManageChannels: true}, method, path, body, out)
	}

	var staff, other categoryResponse
	if code := as(f.api.createCategory, "POST", "/api/v1/channel-categories",
		`{"kind":"text","name":"Staff`+sfx+`","access":`+staffOnly+`}`, &staff); code != http.StatusCreated {
		t.Fatalf("create Staff: %d", code)
	}
	// No access given: the server default (Everyone views).
	if code := as(f.api.createCategory, "POST", "/api/v1/channel-categories",
		`{"kind":"text","name":"Other`+sfx+`"}`, &other); code != http.StatusCreated {
		t.Fatalf("create Other: %d", code)
	}

	var follower, custom channelResponse
	if code := as(f.api.createChannel, "POST", "/api/v1/channels",
		`{"name":"f`+sfx[1:9]+`","kind":"text","category_id":"`+staff.ID+`","follow_category":true}`, &follower); code != http.StatusCreated {
		t.Fatalf("create follower: %d", code)
	}
	if code := as(f.api.createChannel, "POST", "/api/v1/channels",
		`{"name":"c`+sfx[1:9]+`","kind":"text","category_id":"`+staff.ID+`"}`, &custom); code != http.StatusCreated {
		t.Fatalf("create custom: %d", code)
	}

	t.Run("new follower takes the category's", func(t *testing.T) {
		if !follower.FollowsCategory {
			t.Fatal("follows_category not set")
		}
		if f.canView(member, follower.ID) || !f.canView(mod, follower.ID) {
			t.Fatal("follower should be staff only")
		}
		if !f.canView(member, custom.ID) {
			t.Fatal("custom channel should have the default")
		}
	})

	t.Run("category change reaches followers only", func(t *testing.T) {
		if code := as(f.api.setCategoryAccess, "PUT", "/api/v1/channel-categories/"+staff.ID+"/access",
			`{"access":[{"group_id":"`+groupID("Member")+`","can_post":false}]}`, nil); code != http.StatusNoContent {
			t.Fatalf("set access: %d", code)
		}
		if !f.canView(member, follower.ID) || f.canPost(member, follower.ID) {
			t.Fatal("follower should now be read-only for members")
		}
		if !f.canPost(member, custom.ID) {
			t.Fatal("custom channel must not change")
		}
	})

	t.Run("apply to all", func(t *testing.T) {
		if code := as(f.api.setCategoryAccess, "PUT", "/api/v1/channel-categories/"+staff.ID+"/access",
			`{"access":`+staffOnly+`,"apply_to_all":true}`, nil); code != http.StatusNoContent {
			t.Fatalf("set access: %d", code)
		}
		if f.canView(member, custom.ID) || f.canView(member, follower.ID) {
			t.Fatal("both should be staff only")
		}
	})

	followsOf := func(id string) bool {
		var on bool
		if err := pool.QueryRow(ctx, `SELECT follows_category FROM channels WHERE id = $1`, id).Scan(&on); err != nil {
			t.Fatal(err)
		}
		return on
	}

	t.Run("move to another category takes its permissions", func(t *testing.T) {
		if code := as(f.api.moveChannel, "POST", "/api/v1/channels/"+follower.ID+"/move",
			`{"category_id":"`+other.ID+`","before_id":null}`, nil); code != http.StatusNoContent {
			t.Fatalf("move: %d", code)
		}
		if !followsOf(follower.ID) || !f.canView(member, follower.ID) {
			t.Fatal("should follow Other now (members view)")
		}
	})

	t.Run("keep_access makes it Custom", func(t *testing.T) {
		if code := as(f.api.moveChannel, "POST", "/api/v1/channels/"+follower.ID+"/move",
			`{"category_id":"`+staff.ID+`","before_id":null,"keep_access":true}`, nil); code != http.StatusNoContent {
			t.Fatalf("move: %d", code)
		}
		if followsOf(follower.ID) || !f.canView(member, follower.ID) {
			t.Fatal("should be Custom with Other's permissions")
		}
	})

	t.Run("follow_category on a move makes a Custom channel follow", func(t *testing.T) {
		if code := as(f.api.moveChannel, "POST", "/api/v1/channels/"+follower.ID+"/move",
			`{"category_id":"`+other.ID+`","before_id":null,"follow_category":true}`, nil); code != http.StatusNoContent {
			t.Fatalf("move: %d", code)
		}
		if !followsOf(follower.ID) || !f.canView(member, follower.ID) {
			t.Fatal("should follow Other")
		}
		if code := as(f.api.moveChannel, "POST", "/api/v1/channels/"+follower.ID+"/move",
			`{"category_id":"`+staff.ID+`","before_id":null,"keep_access":true}`, nil); code != http.StatusNoContent {
			t.Fatalf("move back: %d", code)
		}
		if code := as(f.api.moveChannel, "POST", "/api/v1/channels/"+follower.ID+"/move",
			`{"category_id":null,"before_id":null,"follow_category":true}`, nil); code != http.StatusBadRequest {
			t.Fatalf("follow with no category: %d, want 400", code)
		}
	})

	t.Run("follow again, then out to the top level", func(t *testing.T) {
		if code := as(f.api.setChannelAccess, "PUT", "/api/v1/channels/"+follower.ID+"/access",
			`{"follow_category":true}`, nil); code != http.StatusNoContent {
			t.Fatalf("follow: %d", code)
		}
		if f.canView(member, follower.ID) {
			t.Fatal("should be staff only again")
		}
		if code := as(f.api.moveChannel, "POST", "/api/v1/channels/"+follower.ID+"/move",
			`{"category_id":null,"before_id":null}`, nil); code != http.StatusNoContent {
			t.Fatalf("move out: %d", code)
		}
		if followsOf(follower.ID) || f.canView(member, follower.ID) || !f.canView(mod, follower.ID) {
			t.Fatal("should be Custom and still staff only")
		}
		if code := as(f.api.setChannelAccess, "PUT", "/api/v1/channels/"+follower.ID+"/access",
			`{"follow_category":true}`, nil); code != http.StatusBadRequest {
			t.Fatalf("following with no category: %d, want 400", code)
		}
	})

	t.Run("deleting the category leaves Custom channels", func(t *testing.T) {
		if code := as(f.api.setChannelAccess, "PUT", "/api/v1/channels/"+custom.ID+"/access",
			`{"follow_category":true}`, nil); code != http.StatusNoContent {
			t.Fatalf("follow: %d", code)
		}
		if code := as(f.api.deleteCategory, "DELETE", "/api/v1/channel-categories/"+staff.ID, "", nil); code != http.StatusNoContent {
			t.Fatalf("delete: %d", code)
		}
		if followsOf(custom.ID) || f.canView(member, custom.ID) || !f.canView(mod, custom.ID) {
			t.Fatal("should be Custom and still staff only")
		}
	})

	t.Run("category permissions only for managers", func(t *testing.T) {
		var list []categoryResponse
		f.callPerms(f.api.listCategories, member, perm.Set{}, "GET", "/api/v1/channel-categories", "", &list)
		for _, c := range list {
			if c.Access != nil {
				t.Fatal("a member was sent a category's permissions")
			}
		}
	})
}

// callPerms is call with the session's switches set, for handlers that
// read them (listCategories).
func (f *dmFixture) callPerms(h http.HandlerFunc, userID string, perms perm.Set, method, path, body string, out any) int {
	f.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for _, part := range strings.Split(path, "/") {
		if uuidPattern.MatchString(part) {
			req.SetPathValue("id", part)
		}
	}
	req = req.WithContext(context.WithValue(req.Context(), sessionKey, Session{UserID: userID, Perms: perms}))
	rec := httptest.NewRecorder()
	h(rec, req)
	if out != nil && rec.Code < 300 {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			f.t.Fatalf("%s %s: %v (%s)", method, path, err, rec.Body.String())
		}
	}
	return rec.Code
}
