package adminui

import (
	"embed"
	"encoding/json"
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
	if !h.authorized(r) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="nanoclaw-admin"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
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
		h.serveAsset(w, "index.html")
		return
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
