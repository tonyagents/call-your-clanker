# Call your Clanker 🤖📞

A voice robo-advisor you can phone — or get phone calls from. Ask for prices,
trending tokens, your portfolio, prediction markets; trade tokens, xStocks,
and prediction-market positions, all by voice.

```
You ──phone──> Twilio ──webhook──> this server ──> Claude (Fable) + MoonPay MCP
                 ▲                      │
                 └── ElevenLabs TTS <───┘
```

- **Twilio** answers/places calls and transcribes your speech (`<Gather>`).
- **Claude Agent SDK** runs one persistent Fable session per call, with the
  MoonPay MCP server (`mp mcp`) as its only toolset.
- **ElevenLabs** gives the clanker its voice (falls back to Twilio Polly
  if no key is set).

## Prerequisites

- `mp` CLI installed and logged in (`mp login`) — the agent uses your wallet
- `claude` CLI logged in (the Agent SDK uses its credentials)
- A Twilio account with a voice-capable phone number
- (Optional) An ElevenLabs API key
- `ngrok` for local development

## Setup

```bash
cp .env.example .env   # fill in Twilio creds + your cell in ALLOWED_CALLERS
npm install
npm run tunnel         # prints the PUBLIC_URL; put it in .env
npm start
```

In the Twilio console, point your number's **Voice webhook** (POST) at
`<PUBLIC_URL>/voice` and the **status callback** at `<PUBLIC_URL>/voice/status`.

## Use it

**Call the clanker**: dial your Twilio number. Talk naturally:

- "What's bitcoin at?"
- "What's trending today?"
- "Buy twenty dollars of Tesla" → finds TSLAx (xStock), quotes it, asks you to
  confirm before trading
- "Any interesting prediction markets on the Fed?"
- "What's my portfolio worth?"

**Get a call from the clanker**:

```bash
npm run call-me                       # calls ALLOWED_CALLERS[0] with a market briefing
node scripts/call-me.js +1555… "tell me how my SOL position did today"
```

Schedule a morning briefing with cron:

```cron
0 8 * * 1-5 cd ~/call-your-clanker && node scripts/call-me.js
```

## Safety rails

- **Caller allowlist** — unknown numbers get hung up on (`ALLOWED_CALLERS`)
- **Twilio signature validation** on every webhook
- **Verbal trade confirmation** — the agent must read back asset/amount/cost
  and hear an explicit "yes" before executing anything
- **`MAX_TRADE_USD`** hard cap (default $100)
- **No built-in tools** — the agent has MoonPay tools only; wallet export,
  wallet delete, bank-account, and off-ramp tools are disallowed

## How a turn flows

1. You speak → Twilio transcribes → `POST /voice/turn`
2. Server fires the agent turn and immediately returns "On it" + a redirect
   into `POST /voice/wait`
3. `/voice/wait` polls every 2s (tool calls — quotes, swaps, market searches —
   can take a while) and speaks the answer when ready, then listens again
4. Hang up → `/voice/status` → agent session and MCP server shut down
