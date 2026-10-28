// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package perm defines the role hierarchy and the comparisons built on it.
//
// Roles are totally ordered, so every permission question reduces to "is
// this role at least that role". The ranks here must match the roles table
// in migration 0003.
package perm

import "fmt"

type Role string

const (
	Guest         Role = "guest"
	User          Role = "user"
	Moderator     Role = "moderator"
	Administrator Role = "administrator"
)

var ranks = map[Role]int{
	Guest:         0,
	User:          1,
	Moderator:     2,
	Administrator: 3,
}

// Parse validates a role name coming from a request or the database.
func Parse(s string) (Role, error) {
	r := Role(s)
	if _, ok := ranks[r]; !ok {
		return "", fmt.Errorf("perm: unknown role %q", s)
	}
	return r, nil
}

// Rank returns the role's position in the hierarchy. An unknown role ranks
// below everything, so a corrupt value fails closed rather than open.
func Rank(r Role) int {
	rank, ok := ranks[r]
	if !ok {
		return -1
	}
	return rank
}

// AtLeast reports whether have is at least as privileged as need.
func AtLeast(have, need Role) bool {
	return Rank(have) >= Rank(need) && Rank(have) >= 0
}

// Outranks reports whether a is strictly more privileged than b.
//
// Used to stop an administrator demoting a peer: equal ranks do not
// outrank each other, so administrators cannot fight over each other's
// accounts.
func Outranks(a, b Role) bool {
	return Rank(a) > Rank(b) && Rank(a) >= 0
}

func (r Role) String() string { return string(r) }
