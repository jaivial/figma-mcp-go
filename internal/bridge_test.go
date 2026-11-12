package internal

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestMatchFiles(t *testing.T) {
	files := []FileInfo{
		{ID: "c1", FileName: "Design System.fig"},
		{ID: "c2", FileName: "design-system-v2.fig"},
		{ID: "c3", FileName: "Landing.fig"},
	}

	cases := []struct {
		name   string
		target string
		want   []string
	}{
		{"exact name wins over substring", "design system.fig", []string{"c1"}},
		{"exact match is case-insensitive", "LANDING.FIG", []string{"c3"}},
		{"unique substring matches one file", "landing", []string{"c3"}},
		{"ambiguous substring matches several files", "design", []string{"c1", "c2"}},
		{"no match", "mobile", nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			matches := matchFiles(files, tc.target)
			var got []string
			for _, f := range matches {
				got = append(got, f.ID)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("matchFiles(%q) = %v, want %v", tc.target, got, tc.want)
			}
		})
	}
}

func TestOriginAllowed(t *testing.T) {
	cases := []struct {
		origin string
		want   bool
	}{
		{"", true}, // non-browser clients send no Origin
		{"null", true},
		{"https://www.figma.com", true},
		{"https://figma.com", true},
		{"https://www.figma.com:443", true},
		{"https://evil.com", false},
		{"https://www.figma.com.evil.com", false},
		{"http://localhost:3000", false},
	}
	for _, tc := range cases {
		if got := originAllowed(tc.origin); got != tc.want {
			t.Errorf("originAllowed(%q) = %v, want %v", tc.origin, got, tc.want)
		}
	}
}

func TestRequireToken(t *testing.T) {
	newReq := func(header, query string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/rpc"+query, nil)
		if header != "" {
			r.Header.Set("X-Figma-MCP-Token", header)
		}
		return r
	}

	t.Run("no token configured allows everything", func(t *testing.T) {
		l := &Leader{}
		w := httptest.NewRecorder()
		if !l.requireToken(w, newReq("", ""), false) || w.Code != http.StatusOK {
			t.Errorf("want allow, got status %d", w.Code)
		}
	})

	t.Run("header token required for rpc and files", func(t *testing.T) {
		l := &Leader{token: "s3cret"}
		for _, tc := range []struct {
			header string
			query  string
			want   int
		}{
			{"s3cret", "", http.StatusOK},
			{"", "", http.StatusUnauthorized},
			{"wrong", "", http.StatusUnauthorized},
			{"", "?token=s3cret", http.StatusUnauthorized}, // query param is /ws-only
		} {
			w := httptest.NewRecorder()
			allowed := l.requireToken(w, newReq(tc.header, tc.query), false)
			if (w.Code == http.StatusOK) != allowed || w.Code != tc.want {
				t.Errorf("header=%q query=%q: got status %d (allowed=%v), want %d",
					tc.header, tc.query, w.Code, allowed, tc.want)
			}
		}
	})

	t.Run("query token required for ws upgrade", func(t *testing.T) {
		l := &Leader{token: "s3cret"}
		for _, tc := range []struct {
			header string
			query  string
			want   int
		}{
			{"", "?token=s3cret", http.StatusOK},
			{"", "", http.StatusUnauthorized},
			{"s3cret", "", http.StatusUnauthorized}, // header does not pass for /ws
		} {
			w := httptest.NewRecorder()
			allowed := l.requireToken(w, newReq(tc.header, tc.query), true)
			if (w.Code == http.StatusOK) != allowed || w.Code != tc.want {
				t.Errorf("header=%q query=%q: got status %d (allowed=%v), want %d",
					tc.header, tc.query, w.Code, allowed, tc.want)
			}
		}
	})
}
