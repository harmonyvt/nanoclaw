package adminui

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFallbackServedWhenDistMissing(t *testing.T) {
	h := New(Options{Enabled: true, DistDir: "./does-not-exist"})

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.Code)
	}
	if !strings.Contains(resp.Body.String(), "NanoClaw Admin") {
		t.Fatalf("expected fallback html body")
	}
}

func TestConfigExposesRuntimeDetails(t *testing.T) {
	h := New(Options{
		Enabled:      true,
		DistDir:      "./does-not-exist",
		APIBasePath:  "/v1",
		BuildVersion: "abc123",
	})

	req := httptest.NewRequest(http.MethodGet, "/admin/config.json", nil)
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.Code)
	}
	body := resp.Body.String()
	if !strings.Contains(body, "apiBasePath") || !strings.Contains(body, "abc123") {
		t.Fatalf("expected config response, got %s", body)
	}
}

func TestAdminTokenLoginFlowWhenConfigured(t *testing.T) {
	h := New(Options{Enabled: true, DistDir: "./does-not-exist", Token: "test-token"})

	unauthReq := httptest.NewRequest(http.MethodGet, "/admin", nil)
	unauthResp := httptest.NewRecorder()
	h.ServeHTTP(unauthResp, unauthReq)
	if unauthResp.Code != http.StatusFound {
		t.Fatalf("expected redirect to login, got %d", unauthResp.Code)
	}
	if loc := unauthResp.Header().Get("Location"); loc != "/admin/login" {
		t.Fatalf("expected login redirect, got %q", loc)
	}

	loginPageReq := httptest.NewRequest(http.MethodGet, "/admin/login", nil)
	loginPageResp := httptest.NewRecorder()
	h.ServeHTTP(loginPageResp, loginPageReq)
	if loginPageResp.Code != http.StatusOK {
		t.Fatalf("expected login page, got %d", loginPageResp.Code)
	}
	if !strings.Contains(loginPageResp.Body.String(), "Enter the admin token") {
		t.Fatalf("expected login page body")
	}

	loginForm := url.Values{}
	loginForm.Set("token", "test-token")
	loginReq := httptest.NewRequest(http.MethodPost, "/admin/login", strings.NewReader(loginForm.Encode()))
	loginReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	loginResp := httptest.NewRecorder()
	h.ServeHTTP(loginResp, loginReq)
	if loginResp.Code != http.StatusFound {
		t.Fatalf("expected login redirect, got %d", loginResp.Code)
	}
	if loc := loginResp.Header().Get("Location"); loc != "/admin" {
		t.Fatalf("expected redirect to /admin, got %q", loc)
	}
	cookies := loginResp.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatalf("expected auth cookie")
	}

	authorizedReq := httptest.NewRequest(http.MethodGet, "/admin", nil)
	authorizedReq.AddCookie(cookies[0])
	authorizedResp := httptest.NewRecorder()
	h.ServeHTTP(authorizedResp, authorizedReq)
	if authorizedResp.Code != http.StatusOK {
		t.Fatalf("expected authorized request to pass, got %d", authorizedResp.Code)
	}
}

func TestFallbackServedWhenBuiltIndexRemovedAfterStartup(t *testing.T) {
	tmp := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmp, "index.html"), []byte("<html><body>built</body></html>"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}

	h := New(Options{Enabled: true, DistDir: tmp})
	if !h.hasDist {
		t.Fatalf("expected built dist to be detected")
	}

	if err := os.Remove(filepath.Join(tmp, "index.html")); err != nil {
		t.Fatalf("remove index: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected fallback 200, got %d", resp.Code)
	}
	if !strings.Contains(resp.Body.String(), "NanoClaw Admin") {
		t.Fatalf("expected fallback html body")
	}
}
