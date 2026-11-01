// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package password decides whether a new password is acceptable
// (docs/decisions.md, "Password rules"). Applied when a password is set
// (registration, change), never at login.
//
// Rules, in the order they are reported:
//
//  1. 12 to 256 characters, counted as a person would (runes, not bytes).
//  2. At least three of four kinds: upper-case letter, lower-case letter,
//     digit, symbol (anything not a letter, digit or whitespace).
//  3. Does not contain the username.
//  4. Is not a common password, or a common password dressed up: the
//     check lower-cases it, undoes look-alike swaps (@ for a, 0 for o, $
//     for s and so on) and strips digits and symbols off both ends, so
//     "Password12345" and "P@ssw0rd!2024" both come down to "password".
//     The list is the UK NCSC's 100,000 most common passwords from breach
//     data, embedded in the binary: nothing is sent anywhere to check.
//  5. Is not mostly a simple pattern: runs of three or more repeated,
//     consecutive (abc, 321) or keyboard-adjacent (qwerty, asdf)
//     characters may not make up more than half of it.
//
// client-web/src/password.ts mirrors 1-3 and 5 for live feedback; 4 needs
// the list and is only checked here.
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
	MinLen        = 12
	MaxLen        = 256
	RequiredKinds = 3

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

// Problem returns a message fit to show the user, or "" when the password
// is acceptable.
func Problem(pw, username string) string {
	if n := utf8.RuneCountInString(pw); n < MinLen || n > MaxLen {
		return fmt.Sprintf("password must be between %d and %d characters", MinLen, MaxLen)
	}
	if missing := missingKinds(pw); len(missing) > 4-RequiredKinds {
		return fmt.Sprintf("password needs at least %d of: upper-case letter, lower-case letter, "+
			"number, symbol; add %s", RequiredKinds, joinOr(missing))
	}
	if containsUsername(pw, username) {
		return "password must not contain your username"
	}
	if IsCommon(pw) {
		return "this password is too close to a commonly used one; pick something less predictable"
	}
	if MostlyPattern(pw) {
		return "password is mostly a simple pattern (like qwerty, 12345 or aaaa); pick something less predictable"
	}
	return ""
}

func missingKinds(pw string) []string {
	var upper, lower, digit, symbol bool
	for _, r := range pw {
		switch {
		case unicode.IsUpper(r):
			upper = true
		case unicode.IsLower(r):
			lower = true
		case unicode.IsDigit(r):
			digit = true
		case unicode.IsLetter(r), unicode.IsSpace(r):
		default:
			symbol = true
		}
	}
	var missing []string
	if !upper {
		missing = append(missing, "an upper-case letter")
	}
	if !lower {
		missing = append(missing, "a lower-case letter")
	}
	if !digit {
		missing = append(missing, "a number")
	}
	if !symbol {
		missing = append(missing, "a symbol")
	}
	return missing
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

var keyboardRows = []string{"1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"}

// Kinds of predictable step from one character to the next, as bits so
// a pair that fits several (f to g is both next-in-alphabet and next on
// the keyboard) keeps all of them.
const (
	stepSame = 1 << iota
	stepUp   // next letter or digit: a->b, 1->2
	stepDown // previous: b->a, 2->1
	stepKeyRight
	stepKeyLeft
)

func steps(a, b rune) int {
	k := 0
	if a == b {
		k |= stepSame
	}
	if (unicode.IsLetter(a) && unicode.IsLetter(b)) || (unicode.IsDigit(a) && unicode.IsDigit(b)) {
		switch b - a {
		case 1:
			k |= stepUp
		case -1:
			k |= stepDown
		}
	}
	for _, row := range keyboardRows {
		i, j := strings.IndexRune(row, a), strings.IndexRune(row, b)
		if i >= 0 && j >= 0 {
			switch j - i {
			case 1:
				k |= stepKeyRight
			case -1:
				k |= stepKeyLeft
			}
		}
	}
	return k
}

// MostlyPattern reports whether runs of three or more characters that
// keep the same predictable step (aaa, abc, 321, qwe, lkj) cover more
// than half of pw. The step must stay the same through the run, so a zigzag
// like "qrq" or a mix like "vvb" is not a pattern.
func MostlyPattern(pw string) bool {
	rs := []rune(strings.ToLower(pw))
	covered, run, kind := 0, 1, 0
	for i := 1; i <= len(rs); i++ {
		if i < len(rs) {
			k := steps(rs[i-1], rs[i])
			if run == 1 && k != 0 {
				kind, run = k, 2
				continue
			}
			if run > 1 && kind&k != 0 {
				kind &= k
				run++
				continue
			}
		}
		if run >= 3 {
			covered += run
		}
		// The pair that broke the run may start the next one.
		run, kind = 1, 0
		if i < len(rs) {
			if k := steps(rs[i-1], rs[i]); k != 0 {
				kind, run = k, 2
			}
		}
	}
	return covered*2 > len(rs)
}

// joinOr writes "a, b or c".
func joinOr(items []string) string {
	if len(items) == 1 {
		return items[0]
	}
	return strings.Join(items[:len(items)-1], ", ") + " or " + items[len(items)-1]
}
