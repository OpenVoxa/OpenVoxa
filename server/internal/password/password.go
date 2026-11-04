// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package password decides whether a new password is acceptable
// (docs/decisions.md, "Password rules"). Applied when a password is set
// (registration, change), never at login.
//
// Rules, in the order they are reported:
//
//  1. 12 to 256 characters, counted as a person would (runes, not bytes).
//  2. Does not contain the username.
//  3. Is not a common password, or a common password dressed up: the
//     check lower-cases it, undoes look-alike swaps (@ for a, 0 for o, $
//     for s and so on) and strips digits and symbols off both ends, so
//     "Password12345" and "P@ssw0rd!2024" both come down to "password".
//     The list is the UK NCSC's 100,000 most common passwords from breach
//     data, embedded in the binary: nothing is sent anywhere to check.
//  4. Is hard to guess: zxcvbn (strength.go) scores it 3 or 4 out of 4,
//     which means an estimated 10^8 guesses or more. zxcvbn spots words,
//     names, dates, keyboard rows, sequences and repeats, so it replaces
//     the old "3 of 4 character kinds" and "mostly a pattern" rules: a
//     long passphrase in lower case passes, Summer2025! does not.
//
// The client asks POST /api/v1/auth/password-check as the user types and
// shows the result; only 1 and 2 are also checked in the browser.
package password

import (
	"bufio"
	"bytes"
	"compress/gzip"
	_ "embed"
	"fmt"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

const (
	MinLen = 12
	MaxLen = 256

	// MinScore is the lowest zxcvbn score (0-4) accepted.
	MinScore = 3

	// Stripped cores shorter than this are not looked up: a long random
	// password of mostly digits and symbols can have a one- or two-letter
	// core that happens to be on the list.
	minCoreLen = 4
)

//go:embed common-passwords.txt.gz
var commonGz []byte

var (
	loadOnce sync.Once
	common   map[string]struct{}
)

// loadCommon builds the lookup set once, on first use: every listed
// password lower-cased, plus its stripped, look-alike-free core.
func loadCommon() {
	common = make(map[string]struct{}, 150_000)
	zr, err := gzip.NewReader(bytes.NewReader(commonGz))
	if err != nil {
		panic("password: embedded list is not gzip: " + err.Error())
	}
	sc := bufio.NewScanner(zr)
	for sc.Scan() {
		line := strings.ToLower(strings.TrimSpace(sc.Text()))
		if line == "" {
			continue
		}
		common[line] = struct{}{}
		for _, c := range cores(line) {
			if utf8.RuneCountInString(c) >= minCoreLen {
				common[c] = struct{}{}
			}
		}
	}
	if err := sc.Err(); err != nil {
		panic("password: reading embedded list: " + err.Error())
	}
}

// Check is the full verdict on a new password: Problem is "" when it is
// acceptable, otherwise a message fit to show the user. Strength is
// filled in whenever the length is within limits, so the meter can show
// it alongside a problem.
type Check struct {
	Problem  string
	Strength Strength
}

// Problem returns a message fit to show the user, or "" when the password
// is acceptable.
func Problem(pw, username string) string {
	return Evaluate(pw, username).Problem
}

// Evaluate checks pw against every rule and scores it.
func Evaluate(pw, username string) Check {
	n := utf8.RuneCountInString(pw)
	if n > MaxLen {
		return Check{Problem: fmt.Sprintf("password must be between %d and %d characters", MinLen, MaxLen)}
	}
	var c Check
	c.Strength = Score(pw, username)
	switch {
	case n < MinLen:
		c.Problem = fmt.Sprintf("password must be between %d and %d characters", MinLen, MaxLen)
	case containsUsername(pw, username):
		c.Problem = "password must not contain your username"
	case c.Strength.Common:
		c.Problem = "this password is too close to a commonly used one; pick something less predictable"
	case c.Strength.Score < MinScore:
		c.Problem = "password is too easy to guess"
		if c.Strength.Warning != "" {
			c.Problem += " (" + c.Strength.Warning + ")"
		}
	}
	return c
}

// IsCommon reports whether pw is, or dresses up, a common password.
func IsCommon(pw string) bool {
	loadOnce.Do(loadCommon)
	lower := strings.ToLower(pw)
	if _, ok := common[lower]; ok {
		return true
	}
	for _, c := range cores(lower) {
		if utf8.RuneCountInString(c) < minCoreLen {
			continue
		}
		if _, ok := common[c]; ok {
			return true
		}
	}
	return false
}

// Look-alike swaps undone before lookup. '1' is tried as both i and l.
var deleet = strings.NewReplacer(
	"@", "a", "4", "a", "0", "o", "3", "e", "$", "s", "5", "s", "7", "t", "!", "i", "|", "l", "+", "t",
)

// cores returns the forms of a lower-cased password worth looking up:
// with look-alikes undone (before and after stripping the ends, since
// "password1" must keep its 1 as a digit to be stripped, while "p4ss"
// needs its 4 read as a letter).
func cores(lower string) []string {
	var out []string
	for _, one := range []string{"i", "l"} {
		d := strings.ReplaceAll(deleet.Replace(lower), "1", one)
		s := strip(lower)
		ds := strings.ReplaceAll(deleet.Replace(s), "1", one)
		out = append(out, d, strip(d), s, ds)
	}
	return out
}

// strip removes everything that is not a letter from both ends.
func strip(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return !unicode.IsLetter(r) })
}

func containsUsername(pw, username string) bool {
	u := strings.ToLower(strings.TrimSpace(username))
	if utf8.RuneCountInString(u) < 3 {
		return false
	}
	lower := strings.ToLower(pw)
	if strings.Contains(lower, u) {
		return true
	}
	for _, one := range []string{"i", "l"} {
		if strings.Contains(strings.ReplaceAll(deleet.Replace(lower), "1", one), u) {
			return true
		}
	}
	return false
}
