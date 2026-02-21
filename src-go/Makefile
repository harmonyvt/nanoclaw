SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

REMOTE_HELPER := ./scripts/remote-firecracker.sh
CLI_SMOKE := ./scripts/cli-smoke.sh
ADMIN_DIR := ./web/admin

TASK ?= telegram-agent --runtime bun --source make
SERVICE ?= all
ACTION ?= show
SYNC_RESTART ?= 1
SYNC_BUILD ?= 1
SYNC_BUILD_GO ?= 1
SYNC_BUILD_FRONTEND ?= 1
SYNC_FRONTEND_INSTALL ?= 1

.PHONY: help \
	remote-quickstart remote-info remote-doctor remote-setup remote-sync remote-sync-only remote-up remote-down remote-restart remote-status remote-smoke remote-task remote-logs remote-test remote-shell remote-admin-token remote-dev-loop \
	local-up local-down local-restart local-status local-smoke local-task local-logs \
	go-test go-test-all admin-install admin-dev admin-build admin-typecheck admin-lint check-hookup

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*##"; printf "src-go Makefile targets:\n"} /^[a-zA-Z0-9_.-]+:.*##/ {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

remote-quickstart: ## Interactive setup for src-go/.env remote values
	@./scripts/remote-firecracker-quickstart.sh

remote-info: ## Print resolved remote helper configuration
	@$(REMOTE_HELPER) info

remote-doctor: ## Check remote host prerequisites and paths
	@$(REMOTE_HELPER) doctor

remote-setup: ## One-time remote dependency/install setup
	@$(REMOTE_HELPER) setup

remote-sync: ## Sync local src-go (build+restart by default; SYNC_RESTART=0/SYNC_BUILD=0 to skip)
	@NANOCLAW_REMOTE_SYNC_AUTO_RESTART=$(SYNC_RESTART) \
	 NANOCLAW_REMOTE_SYNC_BUILD=$(SYNC_BUILD) \
	 NANOCLAW_REMOTE_SYNC_BUILD_GO=$(SYNC_BUILD_GO) \
	 NANOCLAW_REMOTE_SYNC_BUILD_FRONTEND=$(SYNC_BUILD_FRONTEND) \
	 NANOCLAW_REMOTE_SYNC_FRONTEND_INSTALL=$(SYNC_FRONTEND_INSTALL) \
	 $(REMOTE_HELPER) sync

remote-sync-only: ## Sync local src-go without restart (build still on unless SYNC_BUILD=0)
	@NANOCLAW_REMOTE_SYNC_AUTO_RESTART=0 \
	 NANOCLAW_REMOTE_SYNC_BUILD=$(SYNC_BUILD) \
	 NANOCLAW_REMOTE_SYNC_BUILD_GO=$(SYNC_BUILD_GO) \
	 NANOCLAW_REMOTE_SYNC_BUILD_FRONTEND=$(SYNC_BUILD_FRONTEND) \
	 NANOCLAW_REMOTE_SYNC_FRONTEND_INSTALL=$(SYNC_FRONTEND_INSTALL) \
	 $(REMOTE_HELPER) sync

remote-up: ## Start remote services
	@$(REMOTE_HELPER) up

remote-down: ## Stop remote services
	@$(REMOTE_HELPER) down

remote-restart: ## Restart remote services
	@$(REMOTE_HELPER) restart

remote-status: ## Show remote process and health status
	@$(REMOTE_HELPER) status

remote-smoke: ## Run remote smoke validation
	@$(REMOTE_HELPER) smoke

remote-task: ## Run one remote task (TASK="telegram-agent --runtime bun --source make")
	@$(REMOTE_HELPER) task "$(TASK)"

remote-logs: ## Tail remote logs (SERVICE=all|nanoclawd|sessiond|vm-supervisor)
	@$(REMOTE_HELPER) logs "$(SERVICE)"

remote-test: ## Run go test ./... on remote src-go
	@$(REMOTE_HELPER) test

remote-shell: ## Open SSH shell to remote host
	@$(REMOTE_HELPER) shell

remote-admin-token: ## Manage remote admin token (ACTION=show|ensure|rotate|path)
	@$(REMOTE_HELPER) admin-token "$(ACTION)"

remote-dev-loop: ## Sync (build+auto-restart) + smoke on remote host
	@NANOCLAW_REMOTE_SYNC_AUTO_RESTART=1 \
	 NANOCLAW_REMOTE_SYNC_BUILD=$(SYNC_BUILD) \
	 NANOCLAW_REMOTE_SYNC_BUILD_GO=$(SYNC_BUILD_GO) \
	 NANOCLAW_REMOTE_SYNC_BUILD_FRONTEND=$(SYNC_BUILD_FRONTEND) \
	 NANOCLAW_REMOTE_SYNC_FRONTEND_INSTALL=$(SYNC_FRONTEND_INSTALL) \
	 $(REMOTE_HELPER) sync
	@$(REMOTE_HELPER) smoke

local-up: ## Start local cli-smoke services
	@$(CLI_SMOKE) up

local-down: ## Stop local cli-smoke services
	@$(CLI_SMOKE) down

local-restart: ## Restart local cli-smoke services
	@$(CLI_SMOKE) restart

local-status: ## Show local cli-smoke process and health status
	@$(CLI_SMOKE) status

local-smoke: ## Run local cli-smoke validation
	@$(CLI_SMOKE) smoke

local-task: ## Run one local task (TASK="telegram-agent --runtime bun --source make")
	@$(CLI_SMOKE) task "$(TASK)"

local-logs: ## Tail local logs (SERVICE=all|nanoclawd|sessiond|vm-supervisor)
	@$(CLI_SMOKE) logs "$(SERVICE)"

go-test: ## Run core Go tests for API and admin UI wiring
	@go test ./internal/api ./internal/adminui

go-test-all: ## Run all Go tests in src-go
	@go test ./...

admin-install: ## Install admin frontend dependencies
	@cd $(ADMIN_DIR) && bun install --frozen-lockfile

admin-dev: ## Run admin frontend Vite dev server
	@cd $(ADMIN_DIR) && bun run dev

admin-build: ## Build admin frontend bundle
	@cd $(ADMIN_DIR) && bun run build

admin-typecheck: ## Typecheck admin frontend
	@cd $(ADMIN_DIR) && bun run typecheck

admin-lint: ## Lint admin frontend
	@cd $(ADMIN_DIR) && bun run lint

check-hookup: admin-install ## Verify Go + admin frontend are wired correctly
	@go test ./internal/api ./internal/adminui
	@cd $(ADMIN_DIR) && bun run typecheck
	@cd $(ADMIN_DIR) && bun run build
