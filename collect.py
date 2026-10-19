#!/usr/bin/env python3
"""
Project Rebirth — player-count history collector.

Polls the game's server-browser endpoint every 60s, sums the live player
count across all online deployments, and appends a sample to history.json.
Run it wherever you like and the chart fills with REAL data for every
visitor.

The endpoint itself is configuration, never source: it comes from the
GAME_API_URL environment variable (a repository secret in CI), or from a
gitignored .dev.vars / .env file when running by hand.

Usage:
    export GAME_API_URL="..."     # or: put it in .dev.vars / .env
    python collect.py             # poll forever, write history.json here
    python collect.py --once      # single sample then exit (for cron)
    python collect.py --port 8080 # also serve the site on :8080

history.json shape:  { "samples": [ {"t": 1760000000000, "v": 34}, ... ] }
  t = epoch ms, v = total players online. Older than 30 days are pruned.
"""

import json
import os
import ssl
import sys
import time
import urllib.request
from datetime import datetime, timezone

API = os.environ.get("GAME_API_URL", "").strip()
HERE = os.path.dirname(os.path.abspath(__file__))
HIST = os.path.join(HERE, "history.json")
INTERVAL = 60          # seconds between samples
MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000   # keep 30 days


def _read_local_secret():
    """
    Fall back to a gitignored .dev.vars / .env (KEY=VALUE, optional quotes)
    so the endpoint never has to live in a committed file.
    """
    for name in (".dev.vars", ".env"):
        path = os.path.join(HERE, name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("GAME_API_URL") and "=" in line:
                        _, _, value = line.partition("=")
                        value = value.strip().strip('"').strip("'")
                        if value:
                            return value
        except OSError:
            continue
    return ""


if not API:
    API = _read_local_secret()


def _ssl_context():
    """
    Windows Python often ships without a CA bundle, which makes urlopen raise
    CERTIFICATE_VERIFY_FAILED. Prefer certifi if installed, else load the OS
    root store. Verification stays ON either way.
    """
    ctx = ssl.create_default_context()
    try:
        import certifi  # type: ignore
        ctx.load_verify_locations(certifi.where())
        return ctx
    except Exception:
        pass
    try:
        ctx.load_default_certs()
    except Exception:
        pass
    return ctx


SSL_CTX = _ssl_context()


def load():
    try:
        with open(HIST, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("samples"), list):
            return data["samples"]
    except (OSError, ValueError):
        pass
    return []


def save(samples):
    tmp = HIST + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"samples": samples}, f)
    os.replace(tmp, HIST)  # atomic, so the site never reads a half-written file


def total_online():
    """Sum player_count over every deployment that is currently online."""
    req = urllib.request.Request(API, headers={"User-Agent": "pr-tracker/1.0"})
    with urllib.request.urlopen(req, timeout=20, context=SSL_CTX) as r:
        payload = json.load(r)

    total = 0
    for station in payload.get("items", []):
        for dep in station.get("deployments") or []:
            if dep.get("online"):
                try:
                    total += int(dep.get("player_count") or 0)
                except (TypeError, ValueError):
                    pass
    return total


def sample(samples):
    now_ms = int(time.time() * 1000)
    try:
        value = total_online()
    except Exception as e:  # network blip — skip this tick, keep old data
        print(f"[{ts()}] fetch failed: {e}", flush=True)
        return

    last = samples[-1] if samples else None
    if last and now_ms - last["t"] < INTERVAL * 1000 * 0.5:
        # merged into the previous point if we somehow ran twice fast
        last["t"], last["v"] = now_ms, value
    else:
        samples.append({"t": now_ms, "v": value})

    cutoff = now_ms - MAX_AGE_MS
    samples[:] = [s for s in samples if s["t"] >= cutoff]
    save(samples)
    print(f"[{ts()}] players online: {value}  (samples: {len(samples)})", flush=True)


def ts():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def serve(port):
    """Optional: serve this folder so history.json is same-origin (no CORS)."""
    import http.server
    import functools

    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=HERE
    )
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)
    print(f"serving {HERE} on http://localhost:{port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    if not API:
        print(
            "GAME_API_URL is not set — export it (in CI: repository secret) or "
            "put it in a gitignored .dev.vars / .env file next to this script.",
            file=sys.stderr,
        )
        sys.exit(2)

    if "--port" in sys.argv:
        try:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        except (ValueError, IndexError):
            port = 8080
        import threading

        threading.Thread(target=serve, args=(port,), daemon=True).start()

    samples = load()
    print(f"loaded {len(samples)} existing samples", flush=True)

    if "--once" in sys.argv:
        sample(samples)
        sys.exit(0)

    while True:
        sample(samples)
        time.sleep(INTERVAL)
