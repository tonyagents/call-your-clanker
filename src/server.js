import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import twilio from 'twilio';
import { config } from './config.js';
import { ClankerSession } from './agent.js';
import { speak, synthesize } from './tts.js';

const VoiceResponse = twilio.twiml.VoiceResponse;
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/audio', express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'audio')));

/** Live call sessions, keyed by Twilio CallSid. */
const sessions = new Map();

const LINES = {
  greeting:
    "Clanker speaking. Prices, trending tokens, trades, prediction markets — what do you need?",
  briefingGreeting: 'Clanker here. You asked for a call, so I ran the numbers. One second.',
  ack: 'On it. Give me a moment.',
  still: 'Still working. The blockchain waits for no one, except right now.',
  reprompt: "I didn't catch that. Say it again?",
  goodbye: 'Powering down. Call me when the charts get interesting.',
  timeout: "That one's taking too long, so I'm cutting my losses. Ask me something else.",
};

const MAX_WAIT_LOOPS = 100; // ~2 minutes at 1s per loop + overhead
const FAST_PATH_MS = 4000; // wait this long inline before falling back to the hold loop

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a turn inline for up to FAST_PATH_MS; true if it finished. */
async function turnFinishesQuickly(session) {
  const deadline = Date.now() + FAST_PATH_MS;
  while (Date.now() < deadline) {
    if (session.turn && session.turn.status !== 'thinking') return true;
    await sleep(250);
  }
  return false;
}

function validateTwilio(req, res) {
  if (process.env.TWILIO_VALIDATE === 'false') return true;
  const signature = req.headers['x-twilio-signature'];
  const url = `${config.publicUrl}${req.originalUrl}`;
  const valid =
    signature && twilio.validateRequest(config.twilio.authToken, signature, url, req.body);
  if (!valid) {
    console.warn(`[server] rejected unsigned request to ${req.originalUrl}`);
    res.status(403).send('forbidden');
  }
  return valid;
}

function gatherInto(vr) {
  return vr.gather({
    input: 'speech',
    action: '/voice/turn',
    method: 'POST',
    speechTimeout: 'auto',
    speechModel: 'experimental_conversations',
    actionOnEmptyResult: true,
  });
}

function sendTwiml(res, vr) {
  res.type('text/xml').send(vr.toString());
}

// Entry point for both inbound calls and answered outbound calls.
app.post('/voice', async (req, res) => {
  if (!validateTwilio(req, res)) return;
  const { CallSid, From, To, Direction } = req.body;
  const caller = Direction === 'inbound' ? From : To;

  if (config.allowedCallers.length && !config.allowedCallers.includes(caller)) {
    console.warn(`[server] blocked caller ${caller}`);
    const vr = new VoiceResponse();
    vr.say({ voice: 'Polly.Matthew-Neural' }, 'This clanker does not know you. Goodbye.');
    vr.hangup();
    return sendTwiml(res, vr);
  }

  console.log(`[server] call ${CallSid} from ${caller} (${Direction})`);
  const session = new ClankerSession(CallSid, { callerNumber: caller });
  sessions.set(CallSid, session);

  const vr = new VoiceResponse();
  const intent = req.query.intent;
  if (intent) {
    // Outbound call with a mission (e.g. morning briefing): start the agent
    // turn immediately and drop into the wait loop.
    session.beginTurn(decodeURIComponent(intent));
    await speak(vr, LINES.briefingGreeting);
    vr.redirect({ method: 'POST' }, '/voice/wait?n=0');
  } else {
    await speak(gatherInto(vr), LINES.greeting);
    vr.redirect({ method: 'POST' }, '/voice/turn');
  }
  sendTwiml(res, vr);
});

// Caller finished speaking: kick off the agent turn, hold the line.
app.post('/voice/turn', async (req, res) => {
  if (!validateTwilio(req, res)) return;
  const session = sessions.get(req.body.CallSid);
  const vr = new VoiceResponse();
  if (!session || session.ended) {
    vr.hangup();
    return sendTwiml(res, vr);
  }

  const speech = (req.body.SpeechResult || '').trim();
  console.log(`[server] ${req.body.CallSid} heard: "${speech}"`);

  if (!speech) {
    await speak(gatherInto(vr), LINES.reprompt);
    vr.redirect({ method: 'POST' }, '/voice/turn');
    return sendTwiml(res, vr);
  }

  if (/\b(goodbye|bye|hang up|that's all|that is all)\b/i.test(speech)) {
    await speak(vr, LINES.goodbye);
    vr.hangup();
    return sendTwiml(res, vr);
  }

  session.beginTurn(speech);
  if (await turnFinishesQuickly(session)) {
    // Fast path: answer directly, no ack line, no hold loop.
    await speak(gatherInto(vr), session.turn.answer);
    vr.redirect({ method: 'POST' }, '/voice/turn');
  } else {
    await speak(vr, LINES.ack);
    vr.redirect({ method: 'POST' }, '/voice/wait?n=0');
  }
  sendTwiml(res, vr);
});

// Poll loop while the agent thinks (tool calls can take a while).
app.post('/voice/wait', async (req, res) => {
  if (!validateTwilio(req, res)) return;
  const session = sessions.get(req.body.CallSid);
  const vr = new VoiceResponse();
  if (!session || session.ended) {
    vr.hangup();
    return sendTwiml(res, vr);
  }

  const n = Number(req.query.n || 0);
  const turn = session.turn;

  if (turn && turn.status !== 'thinking') {
    console.log(`[server] ${req.body.CallSid} answer: "${turn.answer.slice(0, 120)}..."`);
    await speak(gatherInto(vr), turn.answer);
    vr.redirect({ method: 'POST' }, '/voice/turn');
  } else if (n >= MAX_WAIT_LOOPS) {
    await speak(gatherInto(vr), LINES.timeout);
    vr.redirect({ method: 'POST' }, '/voice/turn');
  } else {
    vr.pause({ length: 1 });
    if (n > 0 && n % 15 === 0) await speak(vr, LINES.still);
    vr.redirect({ method: 'POST' }, `/voice/wait?n=${n + 1}`);
  }
  sendTwiml(res, vr);
});

// Call lifecycle callback: tear down the agent when the call ends.
app.post('/voice/status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
    const session = sessions.get(CallSid);
    if (session) {
      console.log(`[server] call ${CallSid} ${CallStatus}, closing session`);
      session.end();
      sessions.delete(CallSid);
    }
  }
  res.sendStatus(204);
});

// Trigger an outbound call: curl -X POST localhost:3334/call -d 'to=+1555...&intent=...'
app.post('/call', async (req, res) => {
  const to = req.body.to || config.allowedCallers[0];
  if (!to) return res.status(400).json({ error: 'no "to" number and no ALLOWED_CALLERS set' });
  if (!config.publicUrl) return res.status(400).json({ error: 'PUBLIC_URL not set' });

  const intent =
    req.body.intent ||
    'Give me a quick spoken market briefing: my portfolio balance, the top two or three trending tokens right now, and one interesting trending prediction market. Keep it under forty-five seconds of speech.';

  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  const call = await client.calls.create({
    to,
    from: config.twilio.phoneNumber,
    url: `${config.publicUrl}/voice?intent=${encodeURIComponent(intent)}`,
    statusCallback: `${config.publicUrl}/voice/status`,
    statusCallbackEvent: ['completed'],
  });
  console.log(`[server] outbound call ${call.sid} -> ${to}`);
  res.json({ sid: call.sid, to });
});

app.get('/health', (_req, res) =>
  res.json({ ok: true, activeCalls: sessions.size, publicUrl: config.publicUrl || null }),
);

app.listen(config.port, async () => {
  console.log(`Call your Clanker listening on :${config.port}`);
  console.log(`Public URL: ${config.publicUrl || '(not set — run npm run tunnel)'}`);
  // Pre-warm the TTS cache for canned lines so calls start snappy.
  // Sequential: ElevenLabs plans cap concurrent requests.
  for (const line of Object.values(LINES)) await synthesize(line).catch(() => {});
});
