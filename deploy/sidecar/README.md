# Sidecar Updater

[中文文档](README.zh-CN.md)

A lightweight sidecar that keeps your backend's WebUI directory in sync with the latest release. It periodically fetches `latest.json`, downloads `dist.zip`, verifies the SHA-256 checksum, and extracts it into the target directory.

The target directory is replaced only when the release contract is valid:

- `latest.json` exposes `release.distZip`
- `release.distZipSha256` matches when provided
- the extracted archive contains `index.html` at its root

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LATEST_URL` | ✅ | — | URL pointing to `latest.json` |
| `TARGET_DIR` | | `/target` | Directory to extract the WebUI into |
| `CHECK_INTERVAL_SEC` | | `3600` | Polling interval in seconds; set to `0` to run once and exit |

## Usage

**Build:**

```bash
docker build -t torrentmix-sidecar -f deploy/sidecar/Dockerfile .
```

**Run:**

```bash
docker run --rm \
  -e LATEST_URL="https://your.domain/latest.json" \
  -e CHECK_INTERVAL_SEC=3600 \
  -v /path/to/webui:/target \
  torrentmix-sidecar
```

If checksum validation fails or the archive layout is invalid, Sidecar logs the failure and leaves the existing `/target` contents untouched.

## Wiring to the Backend

Point your backend at the shared volume:

- **qBittorrent** — Enable *Alternative WebUI* in settings and set the path to the shared volume (exact method varies by distribution; a shared Docker volume is the cleanest option).
- **Transmission** — Pass `--web-home` (or the equivalent config key) pointing to the shared volume.
