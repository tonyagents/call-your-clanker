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

  // Only this number may talk to the clanker (your cell, E.164).
  // Comma-separate to allow several. Empty = allow anyone (NOT recommended:
  // the agent holds a real wallet).
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
};
