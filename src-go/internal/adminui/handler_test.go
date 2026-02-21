package adminui

import (
	"net/http"
	"net/http/httptest"
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

func TestAdminTokenRequiredWhenConfigured(t *testing.T) {
	h := New(Options{Enabled: true, DistDir: "./does-not-exist", Token: "test-token"})

	unauthorizedReq := httptest.NewRequest(http.MethodGet, "/admin", nil)
	unauthorizedResp := httptest.NewRecorder()
	h.ServeHTTP(unauthorizedResp, unauthorizedReq)
	if unauthorizedResp.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized, got %d", unauthorizedResp.Code)
	}

	authorizedReq := httptest.NewRequest(http.MethodGet, "/admin", nil)
	authorizedReq.Header.Set("X-Admin-Token", "test-token")
	authorizedResp := httptest.NewRecorder()
	h.ServeHTTP(authorizedResp, authorizedReq)
	if authorizedResp.Code != http.StatusOK {
		t.Fatalf("expected authorized request to pass, got %d", authorizedResp.Code)
	}
}
