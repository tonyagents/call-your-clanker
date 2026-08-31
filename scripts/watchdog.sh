#!/usr/bin/env bash
# Self-healing supervisor for Call your Clanker.
#
# Why this exists: on networks that block QUIC (UDP/7844), trycloudflare quick
# tunnels drop, and each restart yields a NEW random URL that Twilio can no
# longer reach — the "application error" you hear on the phone. This watchdog
# keeps the server + tunnel alive, and whenever the tunnel URL changes it
# rewrites PUBLIC_URL, restarts the server, and re-points the Twilio number
# automatically. Run it and forget it.
#
#   cd ~/call-your-clanker && npm run watchdog   (or: bash scripts/watchdog.sh)
#
set -uo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".env"
PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)"; PORT="${PORT:-3334}"
TW_SID="$(grep -E '^TWILIO_ACCOUNT_SID=' "$ENV_FILE" | cut -d= -f2)"
TW_TOKEN="$(grep -E '^TWILIO_AUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2)"
NUMBER_SID="${TWILIO_NUMBER_SID:-PN8d85fcbfe5cb3ec1a369f5ab02213a3b}"
CHECK_EVERY=20
CF_LOG="/tmp/clanker-cf.log"
SRV_LOG="/tmp/clanker-server.log"

CF_CONFIG="$HOME/.cloudflared/config.yml"
TUNNEL_NAME="callyourclanker"
# Named-tunnel mode = the permanent callyourclanker.com setup exists. In that
# mode the URL is FIXED, so on failure we just restart `cloudflared tunnel run`
# — no new URL, no Twilio re-pointing. Quick-tunnel mode keeps the old behavior.
named_mode() { [ -f "$CF_CONFIG" ] && grep -q "$TUNNEL_NAME" "$CF_CONFIG" 2>/dev/null; }

log() { echo "[watchdog $(date '+%H:%M:%S')] $*"; }

start_named_tunnel() {
  pkill -f "cloudflared tunnel run" 2>/dev/null
  sleep 2
  (cloudflared tunnel run "$TUNNEL_NAME" > "$CF_LOG" 2>&1 &)
  sleep 5
  log "named tunnel '$TUNNEL_NAME' (re)started"
}

start_server() {
  lsof -ti ":$PORT" | xargs kill 2>/dev/null
  sleep 1
  (npm start > "$SRV_LOG" 2>&1 &)
  sleep 4
  log "server (re)started on :$PORT"
}

# Boot a cloudflared quick tunnel over HTTP2 (QUIC is unreliable here) and echo
# the assigned URL once the edge is actually serving.
start_tunnel() {
  pkill -f "cloudflared tunnel" 2>/dev/null
  sleep 2
  (cloudflared tunnel --url "http://localhost:$PORT" --protocol http2 > "$CF_LOG" 2>&1 &)
  local url=""
  for _ in $(seq 1 25); do
    sleep 2
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" | head -1)
    [ -n "$url" ] && break
  done
  [ -z "$url" ] && { log "tunnel failed to produce a URL"; return 1; }
  # Wait until the public edge actually SERVES our health JSON (not a Cloudflare
  # error page). Twilio uses public DNS, so resolve via 1.1.1.1.
  local host="${url#https://}" ip body
  for _ in $(seq 1 20); do
    ip=$(nslookup "$host" 1.1.1.1 2>/dev/null | awk '/^Address: /{print $2; exit}')
    if [ -n "$ip" ]; then
      body=$(curl -s -m 5 --resolve "$host:443:$ip" "$url/health" 2>/dev/null)
      healthy_body "$body" && { echo "$url"; return 0; }
    fi
    sleep 2
  done
  log "tunnel URL $url never came live at the edge"; return 1
}

repoint_twilio() {
  local url="$1"
  curl -s -u "$TW_SID:$TW_TOKEN" -X POST \
    "https://api.twilio.com/2010-04-01/Accounts/$TW_SID/IncomingPhoneNumbers/$NUMBER_SID.json" \
    --data-urlencode "VoiceUrl=$url/voice" --data-urlencode "VoiceMethod=POST" \
    --data-urlencode "StatusCallback=$url/voice/status" --data-urlencode "StatusCallbackMethod=POST" \
    >/dev/null && log "Twilio number re-pointed to $url"
}

apply_url() {
  local url="$1"
  sed -i '' "s|^PUBLIC_URL=.*|PUBLIC_URL=$url|" "$ENV_FILE"
  start_server          # pick up new PUBLIC_URL (signature validation depends on it)
  repoint_twilio "$url"
}

# Health is the server's /health JSON ({"ok":true,...}). We MUST inspect the
# body, not just curl's exit code: when the tunnel drops, Cloudflare serves a
# 530 / "error 1033" HTML page and curl still exits 0 — so a bare curl check
# reports "healthy" while the line is actually dead. (That bug let the tunnel
# stay down.) Require the real marker.
healthy_body() { grep -q '"ok":true' <<<"$1"; }

# How Twilio sees us: resolve via public DNS and hit /health through the edge.
edge_ok() {
  local url; url=$(grep -E '^PUBLIC_URL=' "$ENV_FILE" | cut -d= -f2)
  [ -z "$url" ] && return 1
  local host="${url#https://}" ip body
  ip=$(nslookup "$host" 1.1.1.1 2>/dev/null | awk '/^Address: /{print $2; exit}')
  [ -z "$ip" ] && return 1
  body=$(curl -s -m 8 --resolve "$host:443:$ip" "$url/health" 2>/dev/null)
  healthy_body "$body"
}

local_ok() { healthy_body "$(curl -s -m 5 "http://localhost:$PORT/health" 2>/dev/null)"; }

if named_mode; then
  log "starting in NAMED-tunnel mode ($TUNNEL_NAME -> fixed URL). port=$PORT interval=${CHECK_EVERY}s"
else
  log "starting in QUICK-tunnel mode. port=$PORT number=$NUMBER_SID interval=${CHECK_EVERY}s"
fi

local_ok || start_server
if ! edge_ok; then
  log "edge down at boot — bringing tunnel up"
  if named_mode; then start_named_tunnel; else u=$(start_tunnel) && apply_url "$u"; fi
fi
log "healthy — supervising."

# Anti-thrash: a fresh quick-tunnel hostname can take ~10-20s to become globally
# DNS-resolvable, and the edge occasionally blips. Rebuilding on a SINGLE miss
# churns a brand-new URL (and a Twilio re-point) needlessly. Only rebuild after
# several consecutive real failures.
EDGE_FAIL_THRESHOLD=3
edge_fails=0

while true; do
  sleep "$CHECK_EVERY"
  if ! local_ok; then
    log "LOCAL SERVER DOWN — restarting"
    start_server
  fi
  if edge_ok; then
    edge_fails=0
  else
    edge_fails=$((edge_fails + 1))
    log "edge check failed ($edge_fails/$EDGE_FAIL_THRESHOLD)"
    if [ "$edge_fails" -ge "$EDGE_FAIL_THRESHOLD" ]; then
      if named_mode; then
        log "PUBLIC EDGE DOWN — restarting named tunnel"
        start_named_tunnel
      else
        log "PUBLIC EDGE DOWN — rebuilding quick tunnel + re-pointing Twilio"
        if u=$(start_tunnel); then apply_url "$u"; log "recovered: $u"
        else log "tunnel rebuild failed; will retry next tick"; fi
      fi
      edge_fails=0
    fi
  fi
done
