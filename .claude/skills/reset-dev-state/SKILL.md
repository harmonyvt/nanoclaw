---
name: reset-dev-state
description: Reset NanoClaw local development state by deleting the SQLite DB and removing NanoClaw Docker containers/volumes. Use when the user asks to reset the dev machine, wipe local runtime state, clean container state, or start fresh.
---

# Reset NanoClaw Dev State

Use this skill to perform a repeatable local reset without touching source code.

## 1. Run the reset script

From the NanoClaw project root:

```bash
.claude/skills/reset-dev-state/scripts/reset_dev_state.sh --project-root "$(pwd)" --wipe-volumes
```

If you want to keep Docker volumes:

```bash
.claude/skills/reset-dev-state/scripts/reset_dev_state.sh --project-root "$(pwd)" --keep-volumes
```

## 2. What gets reset

- SQLite DB files:
  - `store/messages.db`
  - `store/messages.db-wal`
  - `store/messages.db-shm`
- Docker containers matching NanoClaw runtime patterns:
  - names matching `nanoclaw*`
  - containers with label `com.nanoclaw.role=agent`
  - containers using image `nanoclaw-agent:latest`
- Docker volumes matching `nanoclaw*` (only when `--wipe-volumes` is used)

## 3. Verify reset

```bash
ls -la store
docker ps -a --format '{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}' | rg -i 'nanoclaw|cua|agent' || echo 'No matching containers'
docker volume ls --format '{{.Name}}' | rg -i '^nanoclaw' || echo 'No matching volumes'
```

## 4. Report back

Report:

- Which DB files were removed
- Which containers were removed
- Whether volumes were wiped or kept
- Final verification output summary
