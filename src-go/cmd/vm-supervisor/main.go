package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/config"
	"github.com/harmony/nanoclaw/src-go/internal/contracts"
	"github.com/harmony/nanoclaw/src-go/internal/vm"
)

func main() {
	cfg := config.Load()
	backend, err := vm.NewBackendFromConfig(cfg)
	if err != nil {
		log.Fatalf("vm backend init failed: %v", err)
	}
	sup := vm.NewSupervisorWithBackend(backend)

	createSandboxHandler := newSandboxCreateHandler(sup)
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "summary": sup.Summary()})
	})
	mux.HandleFunc("/v1/supervisor/sandboxes", func(w http.ResponseWriter, r *http.Request) {
		createSandboxHandler(w, r)
	})
	mux.HandleFunc("/v1/supervisor/sandboxes/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/v1/supervisor/sandboxes/")
		if path == "" {
			createSandboxHandler(w, r)
			return
		}

		if !strings.Contains(path, ":") {
			if r.Method != http.MethodGet {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			status, err := sup.GetStatus(path)
			if err != nil {
				if errors.Is(err, vm.ErrSandboxNotFound) {
					w.WriteHeader(http.StatusNotFound)
				} else {
					w.WriteHeader(http.StatusInternalServerError)
				}
				_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
				return
			}
			_ = json.NewEncoder(w).Encode(status)
			return
		}

		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		parts := strings.SplitN(path, ":", 2)
		if len(parts) != 2 {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "expected /v1/supervisor/sandboxes/{id}:{action}"})
			return
		}
		id, action := parts[0], parts[1]
		ctx := context.Background()
		var status contracts.SandboxStatus
		var actionErr error
		switch action {
		case "start":
			status, actionErr = sup.StartSandbox(ctx, id)
		case "stop":
			status, actionErr = sup.StopSandbox(ctx, id)
		case "snapshot":
			status, actionErr = sup.SnapshotSandbox(ctx, id)
		case "destroy":
			status, actionErr = sup.DestroySandbox(ctx, id)
		case "killswitch":
			status, actionErr = sup.KillSwitch(ctx, id, "manual supervisor kill-switch")
		default:
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "unsupported action"})
			return
		}
		if actionErr != nil {
			if errors.Is(actionErr, vm.ErrSandboxNotFound) {
				w.WriteHeader(http.StatusNotFound)
			} else {
				w.WriteHeader(http.StatusInternalServerError)
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"error": actionErr.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(status)
	})

	httpServer := &http.Server{Addr: cfg.SupervisorAddr, Handler: mux}
	go func() {
		log.Printf("vm-supervisor listening on %s", cfg.SupervisorAddr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("vm-supervisor failed: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		fmt.Printf("shutdown error: %v\n", err)
	}
}

func newSandboxCreateHandler(sup *vm.Supervisor) http.HandlerFunc {
	var sandboxCreateMu sync.Mutex

	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var spec contracts.SandboxSpec
		if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		if spec.SandboxID == "" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "sandbox_id is required"})
			return
		}

		sandboxCreateMu.Lock()
		defer sandboxCreateMu.Unlock()

		spec.CredentialRefs = contracts.NormalizeCredentialRefs(spec.CredentialRefs)
		if err := validateSandboxCredentialRefs(sup, spec); err != nil {
			status := http.StatusConflict
			if validationErr := contracts.ValidateCredentialRefs(spec.CredentialRefs); validationErr != nil {
				status = http.StatusBadRequest
			}
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		status := sup.CreateSandbox(spec)
		_ = json.NewEncoder(w).Encode(map[string]any{"spec": spec, "status": status})
	}
}

func validateSandboxCredentialRefs(sup *vm.Supervisor, incoming contracts.SandboxSpec) error {
	incoming.CredentialRefs = contracts.NormalizeCredentialRefs(incoming.CredentialRefs)
	if err := contracts.ValidateCredentialRefs(incoming.CredentialRefs); err != nil {
		return err
	}

	for _, existingSpec := range sup.ListSandboxSpecs() {
		existingRefs := contracts.NormalizeCredentialRefs(existingSpec.CredentialRefs)
		if existingSpec.SandboxID == incoming.SandboxID {
			if existingRefs.TelegramBotTokenRef == "" && existingRefs.OpenAIAPIKeyRef == "" {
				continue
			}
			if existingRefs.TelegramBotTokenRef != incoming.CredentialRefs.TelegramBotTokenRef ||
				existingRefs.OpenAIAPIKeyRef != incoming.CredentialRefs.OpenAIAPIKeyRef {
				return fmt.Errorf("sandbox %s is already bound to different credential_refs", incoming.SandboxID)
			}
			continue
		}

		status, err := sup.GetStatus(existingSpec.SandboxID)
		if err == nil && !contracts.CredentialLockApplies(status.ObservedState) {
			continue
		}

		if existingRefs.TelegramBotTokenRef == incoming.CredentialRefs.TelegramBotTokenRef {
			return fmt.Errorf("credential_refs.telegram_bot_token_ref is already allocated to sandbox %s", existingSpec.SandboxID)
		}
		if existingRefs.OpenAIAPIKeyRef == incoming.CredentialRefs.OpenAIAPIKeyRef {
			return fmt.Errorf("credential_refs.openai_api_key_ref is already allocated to sandbox %s", existingSpec.SandboxID)
		}
	}
	return nil
}
