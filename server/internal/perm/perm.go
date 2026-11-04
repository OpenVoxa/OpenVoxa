// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package perm defines the permission switches that permission groups
// carry, and the rank rule that limits whom a permission can be used on.
//
// Two separate questions, deliberately kept apart (Ryan, 2026-10-31):
//
//   - WHAT may you do? The union of the switches on every group you are
//     in. Rank never grants anything: a group with no switches gives no
//     powers however high it sits.
//   - WHO may you do it to? Only accounts whose highest group sits
//     strictly below yours. A moderator with Ban can ban members and
//     guests but not another moderator.
//
// Channel access is not a switch. Each channel lists the groups that may
// view and post in it (see migration 0012 and httpapi/access.go).
package perm

import "sort"

// Perm is one switch a permission group can carry.
type Perm string

const (
	// Administrator implies every other switch and sees every channel.
	Administrator Perm = "administrator"
	// ManageGroups: create, edit and delete groups below your rank, and
	// put people below your rank in and out of them.
	ManageGroups Perm = "manage_groups"
	// ManageChannels: create and delete channels, set retention and who
	// may view and post.
	ManageChannels Perm = "manage_channels"
	// DeleteMessages: remove other people's messages.
	DeleteMessages Perm = "delete_messages"
	// ViewReports: read and resolve reported messages.
	ViewReports Perm = "view_reports"
	// Ban: ban and unban accounts below your rank.
	Ban Perm = "ban"
	// ForcePTT: force push-to-talk in a voice channel.
	ForcePTT Perm = "force_ptt"
	// ManageStickers: add, rename and remove the server's stickers.
	ManageStickers Perm = "manage_stickers"
)

// All lists every switch, in display order.
var All = []Perm{Administrator, ManageGroups, ManageChannels,
	DeleteMessages, ViewReports, Ban, ForcePTT, ManageStickers}

// Valid reports whether s names a known switch.
func Valid(s string) bool {
	for _, p := range All {
		if string(p) == s {
			return true
		}
	}
	return false
}

// Set is the switches an account holds. Unknown names (from a newer
// server, or a hand-edited row) are kept but never match a check, so a
// corrupt value fails closed.
type Set map[Perm]bool

// NewSet builds a Set from names as stored in the database.
func NewSet(names []string) Set {
	s := make(Set, len(names))
	for _, n := range names {
		s[Perm(n)] = true
	}
	return s
}

// Has reports whether the set includes p. Administrator includes all.
func (s Set) Has(p Perm) bool {
	return s[Administrator] || s[p]
}

// Staff reports whether the set holds any switch at all: the line between
// ordinary accounts and power users. Used for things every staff member
// needs, such as the account list.
func (s Set) Staff() bool {
	for _, p := range All {
		if s[p] {
			return true
		}
	}
	return false
}

// Covers reports whether s holds every switch in names. Granting a switch
// you do not hold yourself is refused, so ManageGroups cannot be used to
// mint an Administrator.
func (s Set) Covers(names []string) bool {
	for _, n := range names {
		if !s.Has(Perm(n)) {
			return false
		}
	}
	return true
}

// List returns the held switches, known ones only, sorted. With
// Administrator held it returns every switch, so a client never has to
// know that Administrator implies the rest.
func (s Set) List() []string {
	out := make([]string, 0, len(All))
	for _, p := range All {
		if s.Has(p) {
			out = append(out, string(p))
		}
	}
	sort.Strings(out)
	return out
}

// Outranks reports whether an account of rank a may act on one of rank b.
// Equal ranks do not outrank each other, so administrators cannot fight
// over each other's accounts.
func Outranks(a, b int) bool { return a > b }
