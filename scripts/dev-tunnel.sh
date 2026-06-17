#!/usr/bin/env bash
# Start an ngrok tunnel to the local server and print the PUBLIC_URL to use.
set -euo pipefail
PORT="${PORT:-3334}"

echo "Starting ngrok tunnel to :$PORT ..."
ngrok http "$PORT" --log=stdout >/tmp/clanker-ngrok.log &
NGROK_PID=$!
trap 'kill $NGROK_PID 2>/dev/null' EXIT

sleep 3
URL=$(curl -s localhost:4040/api/tunnels | python3 -c "import sys,json; print(json.load(sys.stdin)['tunnels'][0]['public_url'])")

echo ""
echo "Tunnel up: $URL"
echo ""
echo "1. Put this in .env:            PUBLIC_URL=$URL"
echo "2. Twilio Console -> your number -> Voice webhook (POST): $URL/voice"
echo "   Status callback:                                       $URL/voice/status"
echo ""
echo "Ctrl-C to stop the tunnel."
wait $NGROK_PID
