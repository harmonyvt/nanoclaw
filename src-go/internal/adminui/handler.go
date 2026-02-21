package adminui

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

//go:embed fallback fallback/* fallback/assets/*
var fallbackFS embed.FS

const adminTokenCookieName = "nanoclaw_admin_token"

type Options struct {
	Enabled      bool
	Token        string
	DistDir      string
	APIBasePath  string
	BuildVersion string
}

type Handler struct {
	enabled      bool
	token        string
	apiBasePath  string
	buildVersion string
	distFS       fs.FS
	hasDist      bool
}

func New(opts Options) *Handler {
	distFS, hasDist := resolveDistFS(opts.DistDir)
	apiBasePath := strings.TrimSpace(opts.APIBasePath)
	if apiBasePath == "" {
		apiBasePath = "/v1"
	}
	buildVersion := strings.TrimSpace(opts.BuildVersion)
	if buildVersion == "" {
		buildVersion = "dev"
	}

	return &Handler{
		enabled:      opts.Enabled,
		token:        strings.TrimSpace(opts.Token),
		apiBasePath:  apiBasePath,
		buildVersion: buildVersion,
		distFS:       distFS,
		hasDist:      hasDist,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.enabled {
		http.NotFound(w, r)
		return
	}
	if r.URL.Path == "/admin/login" {
		switch r.Method {
		case http.MethodGet:
			h.serveLogin(w, r)
		case http.MethodPost:
			h.handleLogin(w, r)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
		return
	}
	if r.URL.Path == "/admin/logout" {
		h.handleLogout(w, r)
		return
	}
	if !h.authorized(r) {
		http.Redirect(w, r, "/admin/login", http.StatusFound)
		return
	}

	switch {
	case r.URL.Path == "/admin/config.json":
		h.serveConfig(w)
	case strings.HasPrefix(r.URL.Path, "/admin/assets/"):
		h.serveAsset(w, strings.TrimPrefix(r.URL.Path, "/admin/"))
	case r.URL.Path == "/admin" || r.URL.Path == "/admin/":
		h.serveIndex(w)
	case strings.HasPrefix(r.URL.Path, "/admin/"):
		// SPA route fallback.
		h.serveIndex(w)
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) serveLogin(w http.ResponseWriter, r *http.Request) {
	if h.token == "" {
		http.Redirect(w, r, "/admin", http.StatusFound)
		return
	}
	errorMessage := ""
	if strings.TrimSpace(r.URL.Query().Get("error")) != "" {
		errorMessage = `<p style="color:#b91c1c;margin:0 0 0.75rem 0">Invalid admin token. Try again.</p>`
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = fmt.Fprintf(w, `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>NanoClaw Admin Login</title>
    <style>
      body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a;margin:0;display:grid;place-items:center;min-height:100vh}
      .card{width:min(420px,90vw);background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;box-shadow:0 10px 20px rgba(2,6,23,.05)}
      h1{font-size:1.125rem;margin:0 0 .5rem 0}
      p{font-size:.875rem;color:#475569;margin:.5rem 0 1rem}
      input{width:100%%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:.55rem .65rem;font-size:.95rem}
      button{margin-top:.75rem;width:100%%;border:0;border-radius:8px;padding:.6rem .8rem;background:#0f172a;color:#fff;font-weight:600;cursor:pointer}
    </style>
  </head>
  <body>
    <form class="card" action="/admin/login" method="post">
      <h1>NanoClaw Admin</h1>
      <p>Enter the admin token to continue.</p>
      %s
      <input type="password" name="token" autocomplete="current-password" placeholder="Admin token" required />
      <button type="submit">Sign In</button>
    </form>
  </body>
</html>`, errorMessage)
}

func (h *Handler) handleLogin(w http.ResponseWriter, r *http.Request) {
	if h.token == "" {
		http.Redirect(w, r, "/admin", http.StatusFound)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Redirect(w, r, "/admin/login?error=1", http.StatusFound)
		return
	}
	provided := strings.TrimSpace(r.FormValue("token"))
	if provided != h.token {
		http.Redirect(w, r, "/admin/login?error=1", http.StatusFound)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     adminTokenCookieName,
		Value:    h.token,
		Path:     "/",
		MaxAge:   86400 * 30,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
	})
	http.Redirect(w, r, "/admin", http.StatusFound)
}

func (h *Handler) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     adminTokenCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
	})
	http.Redirect(w, r, "/admin/login", http.StatusFound)
}

func (h *Handler) serveConfig(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"apiBasePath":  h.apiBasePath,
		"buildVersion": h.buildVersion,
		"hasBuiltUI":   h.hasDist,
	})
}

func (h *Handler) serveIndex(w http.ResponseWriter) {
	if h.hasDist {
		content, err := fs.ReadFile(h.distFS, "index.html")
		if err == nil {
			setContentType(w, "index.html")
			_, _ = w.Write(content)
			return
		}
	}
	h.serveFallback(w, "fallback/index.html")
}

func (h *Handler) serveAsset(w http.ResponseWriter, relativePath string) {
	if !fs.ValidPath(relativePath) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	content, err := fs.ReadFile(h.distFS, relativePath)
	if err != nil {
		if strings.HasPrefix(relativePath, "assets/") {
			h.serveFallback(w, "fallback/"+relativePath)
			return
		}
		w.WriteHeader(http.StatusNotFound)
		return
	}
	setContentType(w, relativePath)
	if strings.HasPrefix(relativePath, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}
	_, _ = w.Write(content)
}

func (h *Handler) serveFallback(w http.ResponseWriter, relativePath string) {
	if !fs.ValidPath(relativePath) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	content, err := fs.ReadFile(fallbackFS, relativePath)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	setContentType(w, relativePath)
	_, _ = w.Write(content)
}

func (h *Handler) authorized(r *http.Request) bool {
	if h.token == "" {
		return true
	}
	provided := strings.TrimSpace(r.Header.Get("X-Admin-Token"))
	if provided != "" {
		return provided == h.token
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return strings.TrimSpace(auth[7:]) == h.token
	}
	if cookie, err := r.Cookie(adminTokenCookieName); err == nil {
		return strings.TrimSpace(cookie.Value) == h.token
	}
	return false
}

func resolveDistFS(distDir string) (fs.FS, bool) {
	dir := strings.TrimSpace(distDir)
	if dir == "" {
		dir = "web/admin/dist"
	}
	candidates := []string{dir}
	if !filepath.IsAbs(dir) {
		candidates = append(candidates, filepath.Join("src-go", dir))
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && info.IsDir() {
			if _, err := os.Stat(filepath.Join(candidate, "index.html")); err == nil {
				return os.DirFS(candidate), true
			}
		}
	}
	return fallbackFS, false
}

func setContentType(w http.ResponseWriter, filePath string) {
	ext := path.Ext(filePath)
	if ext == "" {
		return
	}
	ct := mime.TypeByExtension(ext)
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	}
}
