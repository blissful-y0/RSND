# RSND / RisuAI Runtime Notes

Last normalized: 2026-06-17 KST

## Canonical runtime directory

Use this directory for Docker Compose operations:

```bash
cd /Users/bliss/Documents/rsnd
```

`/Users/bliss/Documents/RSND` and `/Users/bliss/Documents/rsnd` may resolve to the same directory on this host. Treat the lowercase path as canonical because existing Docker Compose labels point there.

## Canonical image and volume

- App image: `ghcr.io/blissful-y0/rsnd:latest`
- App container: `risuai-nodeonly`
- App save volume: `risuai_risuai-save`
- Internal app port: `6001`
- Caddy upstream: `risuai:6001`

Do **not** switch back to:

- `ghcr.io/pocketrisu/pocketrisu:latest`
- `risuai-nodeonly_risuai-save`

Those were the stale compose settings that caused deployment drift risk.

## Backups made before cleanup

Manual rescue backup:

```text
/Users/bliss/.openclaw/workspace/backups/risuai/manual-rescue-20260617025741/
```

Contains:

- `database.database.bin`
- `risuai.sqlite.backup.db`
- `MANIFEST.json`

Runtime container rescue image before compose recreation:

```text
rsnd-runtime-rescue:20260617132022
```

Use that only for rollback if the clean `latest` container behaves worse.

## Current cleanup result

The `risuai-nodeonly` app container was recreated under Docker Compose project `risuai-nodeonly`, with compose labels pointing to:

```text
/Users/bliss/Documents/rsnd/docker-compose.yml
```

Caddy, Cloudflared, and Watchtower were not restarted during this cleanup.

## Safe operations

Pull/update app only:

```bash
cd /Users/bliss/Documents/rsnd
docker compose pull risuai
docker compose up -d --no-deps risuai
```

Do not run `docker compose up --remove-orphans` unless intentionally cleaning external containers such as `cloudflared-deploy`.

## Warning

As of cleanup, the clean latest container returns `/api/read` at about 17.5MB. Earlier emergency live patches reduced this further, but those were container-local patches and are not part of the clean latest image.
