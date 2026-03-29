# Torrent Trucker

A self-hosted torrent manager with a web UI, built with Bun, BullMQ, Redis, and WebTorrent.

## Requirements

- [Bun](https://bun.sh) >= 1.0
- Redis

## Setup

```bash
# Install dependencies
bun install

# Copy and fill in env vars
cp .env.example .env
```

**.env options:**

| Variable                  | Description                          | Default               |
|---------------------------|--------------------------------------|-----------------------|
| `REDIS_URL`               | Redis connection URL                 | `redis://localhost:6379` |
| `DOWNLOAD_DIR`            | Where torrents are saved             | —                     |
| `PORT`                    | HTTP server port                     | `3000`                |
| `MAX_CONCURRENT_DOWNLOADS`| Max simultaneous downloads           | `3`                   |

## Running

```bash
# Production
bun src/index.ts

# Development (auto-reload)
bun --watch src/index.ts
```

## Run as a systemd service (Linux)

This keeps the server running permanently and restarts it automatically on crash or reboot.

**1. Edit the service file** — set your username and the absolute path to this repo:

```bash
nano torrent-trucker.service
```

Replace `YOUR_USERNAME` and `/path/to/torrent-trucker` with real values.

**2. Install and enable the service:**

```bash
sudo cp torrent-trucker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable torrent-trucker
sudo systemctl start torrent-trucker
```

**3. Useful commands:**

```bash
# Check status
sudo systemctl status torrent-trucker

# Live logs
journalctl -u torrent-trucker -f

# Restart / stop
sudo systemctl restart torrent-trucker
sudo systemctl stop torrent-trucker
```
