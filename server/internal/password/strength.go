// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package password

import (
	"math"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/trustelem/zxcvbn"
	"github.com/trustelem/zxcvbn/match"
)

// Only the first scoreLen characters are scored. zxcvbn's repeat matcher
// slows down sharply on long repetitive input (256 characters of "aB3$"
// take ~180 ms), and 100 characters that score well cannot be made weak
// by what follows them, so nothing is lost.
const scoreLen = 100

// Strength is zxcvbn's estimate plus the hint shown under the meter.
type Strength struct {
	// Score is 0 (too guessable) to 4 (very unguessable): under 10^3,
	// 10^6, 10^8, 10^10 estimated guesses, or more.
	Score int
	// Common is true when the NCSC list matched (rule 3). Score is then
	// capped at 1 so the meter agrees with the refusal.
	Common bool
	// Warning says what is wrong ("" when nothing stands out).
	Warning string
	// Suggestions say what to do about it. Empty at MinScore and above.
	Suggestions []string
}

// Score estimates how hard pw is to guess. username is passed to zxcvbn
// as a word an attacker would try first.
func Score(pw, username string) Strength {
	if !utf8.ValidString(pw) {
		return Strength{Warning: "This password contains invalid characters"}
	}
	scored := pw
	if utf8.RuneCountInString(pw) > scoreLen {
		scored = string([]rune(pw)[:scoreLen])
	}
	var inputs []string
	if u := strings.TrimSpace(username); u != "" {
		inputs = []string{u}
	}
	r := zxcvbn.PasswordStrength(scored, inputs)
	s := Strength{Score: r.Score}
	s.Warning, s.Suggestions = feedback(r.Score, r.Sequence)
	if pw != "" && IsCommon(pw) {
		s.Common = true
		// zxcvbn's own warning is more specific when it has one.
		if s.Warning == "" || s.Score >= MinScore {
			s.Warning = "This is close to a commonly used password"
		}
		if s.Score > 1 {
			s.Score = 1
		}
		if len(s.Suggestions) == 0 {
			s.Suggestions = []string{extraWords}
		}
	}
	return s
}

// The hint text below is ported from zxcvbn 4.4.2 (src/feedback.coffee,
// MIT licence, Dropbox), which the Go port does not include. British
// spelling; otherwise the same rules.

const extraWords = "Add another word or two. Uncommon words are better."

func feedback(score int, seq []*match.Match) (string, []string) {
	if len(seq) == 0 {
		return "", []string{
			"Use a few words, avoid common phrases",
			"No need for symbols, digits or upper-case letters",
		}
	}
	if score >= MinScore {
		return "", nil
	}
	longest := seq[0]
	for _, m := range seq[1:] {
		if utf8.RuneCountInString(m.Token) > utf8.RuneCountInString(longest.Token) {
			longest = m
		}
	}
	warning, suggestions := matchFeedback(longest, len(seq) == 1)
	return warning, append([]string{extraWords}, suggestions...)
}

func matchFeedback(m *match.Match, sole bool) (string, []string) {
	switch m.Pattern {
	case "dictionary":
		return dictionaryFeedback(m, sole)
	case "spatial":
		w := "Short keyboard patterns are easy to guess"
		if m.Turns == 1 {
			w = "Straight rows of keys are easy to guess"
		}
		return w, []string{"Use a longer keyboard pattern with more turns"}
	case "repeat":
		w := `Repeats like "abcabcabc" are only slightly harder to guess than "abc"`
		if utf8.RuneCountInString(m.BaseToken) == 1 {
			w = `Repeats like "aaa" are easy to guess`
		}
		return w, []string{"Avoid repeated words and characters"}
	case "sequence":
		return "Sequences like abc or 6543 are easy to guess", []string{"Avoid sequences"}
	case "regex":
		if m.RegexName == "recent_year" {
			return "Recent years are easy to guess",
				[]string{"Avoid recent years", "Avoid years that are associated with you"}
		}
	case "date":
		return "Dates are often easy to guess", []string{"Avoid dates and years that are associated with you"}
	}
	return "", nil
}

func dictionaryFeedback(m *match.Match, sole bool) (string, []string) {
	var warning string
	switch m.DictionaryName {
	case "passwords":
		switch {
		case sole && !m.L33t && !m.Reversed:
			switch {
			case m.Rank <= 10:
				warning = "This is a top-10 common password"
			case m.Rank <= 100:
				warning = "This is a top-100 common password"
			default:
				warning = "This is a very common password"
			}
		case m.Guesses > 0 && math.Log10(m.Guesses) <= 4:
			warning = "This is similar to a commonly used password"
		}
	case "english_wikipedia":
		if sole {
			warning = "A word by itself is easy to guess"
		}
	case "surnames", "male_names", "female_names":
		warning = "Common names and surnames are easy to guess"
		if sole {
			warning = "Names and surnames by themselves are easy to guess"
		}
	}

	var suggestions []string
	word := m.Token
	first, _ := utf8.DecodeRuneInString(word)
	switch {
	case unicode.IsUpper(first) && strings.ToLower(word[len(string(first)):]) == word[len(string(first)):]:
		suggestions = append(suggestions, "Capitalisation doesn't help very much")
	case strings.ToUpper(word) == word && strings.ToLower(word) != word:
		suggestions = append(suggestions, "All upper case is almost as easy to guess as all lower case")
	}
	if m.Reversed && utf8.RuneCountInString(word) >= 4 {
		suggestions = append(suggestions, "Reversed words aren't much harder to guess")
	}
	if m.L33t {
		suggestions = append(suggestions, "Predictable substitutions like '@' instead of 'a' don't help very much")
	}
	return warning, suggestions
}
