#!/usr/bin/env bash
# One-shot: put Call your Clanker on the permanent domain callyourclanker.com
# via a NAMED Cloudflare tunnel (fixed hostname — never changes, so Twilio's
# webhook stays valid forever and the "application error" churn ends).
#
# Run this AFTER you've:
#   1. Added callyourclanker.com to a Cloudflare account
#   2. Switched the GoDaddy nameservers to the ones Cloudflare gave you
#      (and the zone shows "Active" in the Cloudflare dashboard)
#   3. Run:  cloudflared tunnel login   (browser auth; pick callyourclanker.com)
#
# Then:  cd ~/call-your-clanker && npm run setup-domain
set -euo pipefail
cd "$(dirname "$0")/.."

TUNNEL_NAME="callyourclanker"
HOSTNAME="callyourclanker.com"
PORT="$(grep -E '^PORT=' .env | cut -d= -f2)"; PORT="${PORT:-3334}"
CF_DIR="$HOME/.cloudflared"
NUMBER_SID="${TWILIO_NUMBER_SID:-PN8d85fcbfe5cb3ec1a369f5ab02213a3b}"
TW_SID="$(grep -E '^TWILIO_ACCOUNT_SID=' .env | cut -d= -f2)"
TW_TOKEN="$(grep -E '^TWILIO_AUTH_TOKEN=' .env | cut -d= -f2)"

say() { echo "[setup-domain] $*"; }

# 0. Preconditions
if [ ! -f "$CF_DIR/cert.pem" ]; then
  echo "ERROR: not logged in to Cloudflare. Run:  cloudflared tunnel login"
  echo "       (then pick the callyourclanker.com zone in the browser)"
  exit 1
fi

# 1. Create the named tunnel (idempotent)
if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  say "tunnel '$TUNNEL_NAME' already exists"
else
  say "creating tunnel '$TUNNEL_NAME'"
  cloudflared tunnel create "$TUNNEL_NAME"
fi
UUID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n{print $1}')"
[ -z "$UUID" ] && { echo "ERROR: could not resolve tunnel UUID"; exit 1; }
say "tunnel UUID: $UUID"

# 2. Write the tunnel config (http2 — this network blocks QUIC)
cat > "$CF_DIR/config.yml" <<YML
tunnel: $UUID
credentials-file: $CF_DIR/$UUID.json
protocol: http2
ingress:
  - hostname: $HOSTNAME
    service: http://localhost:$PORT
  - service: http_status:404
YML
say "wrote $CF_DIR/config.yml"

# 3. Route the apex DNS at the tunnel (CNAME flattening handles the apex)
say "routing $HOSTNAME -> tunnel"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" || say "route may already exist (continuing)"

# 4. Swap PUBLIC_URL and restart the server on the permanent host
sed -i '' "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$HOSTNAME|" .env
say "PUBLIC_URL set to https://$HOSTNAME"

# 5. Stop the old quick tunnel + watchdog; bring up the named tunnel
pkill -f "cloudflared tunnel --url" 2>/dev/null || true
pkill -f "watchdog.sh" 2>/dev/null || true
lsof -ti ":$PORT" | xargs kill 2>/dev/null || true
sleep 1
(npm start > /tmp/clanker-server.log 2>&1 &)
sleep 3
(cloudflared tunnel run "$TUNNEL_NAME" > /tmp/clanker-cf.log 2>&1 &)
say "named tunnel + server started"

# 6. Point Twilio at the permanent URL (one time, forever)
curl -s -u "$TW_SID:$TW_TOKEN" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/$TW_SID/IncomingPhoneNumbers/$NUMBER_SID.json" \
  --data-urlencode "VoiceUrl=https://$HOSTNAME/voice" --data-urlencode "VoiceMethod=POST" \
  --data-urlencode "StatusCallback=https://$HOSTNAME/voice/status" --data-urlencode "StatusCallbackMethod=POST" \
  >/dev/null && say "Twilio number pointed at https://$HOSTNAME/voice"

# 7. Restart the watchdog (it auto-detects named-tunnel mode from config.yml)
(nohup bash scripts/watchdog.sh > /tmp/clanker-watchdog.log 2>&1 &) ; disown || true
say "watchdog restarted (named-tunnel mode)"

echo ""
say "DONE. Give DNS a minute, then check: https://$HOSTNAME/health"
say "Calls to your Twilio number now route through https://$HOSTNAME — permanently."
