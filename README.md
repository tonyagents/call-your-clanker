# Call your Clanker 🤖📞

A voice robo-advisor you can phone — or get phone calls from. Ask for prices,
trending tokens, prediction-market odds, and your portfolio, and get
banker-style recommendations, all by voice. **Read-only**: it advises, it never
moves money (see [Read-only by design](#read-only-by-design)).

```
You ──phone──> Twilio ──webhook──> this server ──> Claude (Fable) + Nova MCP
                 ▲                      │
                 └── ElevenLabs TTS <───┘
```

- **Twilio** answers/places calls and transcribes your speech (`<Gather>`).
- **Claude Agent SDK** runs one persistent Fable session per call, with the
  Nova MCP server (`mp mcp`) as its only toolset.
- **ElevenLabs** gives the clanker its voice (falls back to Twilio Polly
  if no key is set).

> **Note on "Nova":** this is a generic placeholder standing in for the real
> financial-data CLI/MCP this project talks to (prices, trending tokens,
> prediction-market odds, wallet reads). The actual CLI command (`mp`) and
> MCP tool wiring in `src/agent.js` are left intact and functional — a public
> fork should swap in its own financial-data API/MCP and CLI in their place.

## Prerequisites

- A financial-data CLI installed and logged in (here, the `mp` CLI —
  `mp login`) — the agent uses your wallet
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

**Call the clanker**: dial the Twilio number (it's on the landing page at `/`).
Talk naturally:

- "What's bitcoin at?"
- "What's trending today?"
- "If you were me, would you buy Tesla here?" → talks you through the case like a
  banker, but won't (and can't) place the trade
- "Any interesting prediction markets on the Fed?"
- "What's my portfolio worth?" → owner numbers only; public callers get a polite no

**Get a call from the clanker**:

```bash
npm run call-me                       # calls ALLOWED_CALLERS[0] with a market briefing
node scripts/call-me.js +1555… "tell me how my SOL position did today"
```

Schedule a morning briefing with cron:

```cron
0 8 * * 1-5 cd ~/call-your-clanker && node scripts/call-me.js
```

## Read-only by design

This line is public and wired to a real wallet, so it is structurally incapable
of moving money — enforced in code, not by asking the model nicely:

- **Read-only allowlist + hard gate** — the agent may only call a fixed set of
  read tools (prices, charts, trending, prediction-market odds, and — for the
  owner — portfolio reads). A `canUseTool` gate (`src/agent.js`) denies *every*
  other tool, so swap/buy/sell/send/sign/off-ramp simply cannot run.
- **Two tiers** — strangers get market data + recommendations only; only
  `ALLOWED_CALLERS` get read access to the owner's own portfolio, so a random
  caller can't have your balances read aloud to them.
- **`PUBLIC_MODE=false`** locks the whole line back down to `ALLOWED_CALLERS`.
- **Twilio signature validation** on every webhook.
- **No built-in tools** — Nova MCP read tools only.

Asked to trade, Clanker behaves like a banker: it gives you the price/odds, the
case for and against, and what to watch — then reminds you it can only advise.

## How a turn flows

1. You speak → Twilio transcribes → `POST /voice/turn`
2. Server fires the agent turn and immediately returns "On it" + a redirect
   into `POST /voice/wait`
3. `/voice/wait` polls every 2s (tool calls — prices, market searches, portfolio
   reads — can take a while) and speaks the answer when ready, then listens again
4. Hang up → `/voice/status` → agent session and MCP server shut down
