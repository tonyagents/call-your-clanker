import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) console.warn(`[config] WARNING: ${name} is not set`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3334),

  // Public base URL Twilio can reach (ngrok/cloudflared tunnel or deployed host)
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),

  twilio: {
    accountSid: required('TWILIO_ACCOUNT_SID'),
    authToken: required('TWILIO_AUTH_TOKEN'),
    // The Twilio number the clanker answers on / calls from, E.164 e.g. +15551234567
    phoneNumber: required('TWILIO_PHONE_NUMBER'),
  },

  // Public demo mode. When true (default), ANYONE may call — but the agent is
  // read-only and strangers get market data + recommendations only, never the
  // owner's portfolio. Set PUBLIC_MODE=false to lock the line to ALLOWED_CALLERS.
  publicMode: (process.env.PUBLIC_MODE || 'true').toLowerCase() !== 'false',

  // The wallet owner's number(s), E.164, comma-separated. These callers are
  // treated as the owner and additionally get read-only access to the owner's
  // own portfolio (balances, PnL, positions, history). Everyone else is public.
  allowedCallers: (process.env.ALLOWED_CALLERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb', // "George"
    modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5',
  },

  agent: {
    model: process.env.CLANKER_MODEL || 'claude-fable-5',
    // Hard ceiling read into the system prompt; the agent refuses bigger trades.
    maxTradeUsd: Number(process.env.MAX_TRADE_USD || 100),
  },

  // Shared secret required to trigger outbound calls via POST /call. This
  // endpoint can make the Twilio account dial ANY number, so it must never be
  // open on a public URL. Fail closed: if unset, /call is disabled entirely.
  callSecret: process.env.CALL_SECRET || '',

  // Abuse / cost guardrails for a publicly-listed number.
  limits: {
    maxConcurrentCalls: Number(process.env.MAX_CONCURRENT_CALLS || 4), // also keeps us under ElevenLabs' concurrency cap
    maxTurnsPerCall: Number(process.env.MAX_TURNS_PER_CALL || 25),
    callsPerCallerWindow: Number(process.env.CALLS_PER_CALLER_WINDOW || 6), // per caller number...
    callerWindowMinutes: Number(process.env.CALLER_WINDOW_MINUTES || 30), // ...in this many minutes
  },
};
