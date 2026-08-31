import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import twilio from 'twilio';
import { config } from './config.js';
import { ClankerSession } from './agent.js';
import { speak, synthesize } from './tts.js';
import { landingPage } from './landing.js';

const VoiceResponse = twilio.twiml.VoiceResponse;
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/audio', express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'audio')));

// Public marketing site: the phone number + a scannable QR that dials it.
app.get('/', async (_req, res) => {
  res.type('html').send(await landingPage());
});

/** Live call sessions, keyed by Twilio CallSid. */
const sessions = new Map();

// --- Abuse / cost guardrails (public number) -------------------------------
// Per-caller call timestamps for a sliding-window rate limit. In-memory only,
// which is fine for a single-process demo.
const callerHistory = new Map(); // E.164 -> number[] (ms timestamps)

function callerRateLimited(caller) {
  const windowMs = config.limits.callerWindowMinutes * 60_000;
  const now = Date.now();
  const recent = (callerHistory.get(caller) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  callerHistory.set(caller, recent);
  return recent.length > config.limits.callsPerCallerWindow;
}

// Occasionally drop stale caller history so the map can't grow unbounded.
function sweepCallerHistory() {
  const windowMs = config.limits.callerWindowMinutes * 60_000;
  const now = Date.now();
  for (const [caller, times] of callerHistory) {
    const recent = times.filter((t) => now - t < windowMs);
    if (recent.length) callerHistory.set(caller, recent);
    else callerHistory.delete(caller);
  }
}
setInterval(sweepCallerHistory, 10 * 60_000).unref?.();

const LINES = {
  greeting:
    "Clanker here, your advisor on call. Ask me about any token, stock, or market, the latest headlines, and I'll tell you what I'd do. What's on your mind?",
  ownerGreeting:
    "Clanker here. I've got your portfolio, the markets, and the latest news in front of me. What do you want to dig into?",
  briefingGreeting: "Clanker here. You asked me to call, so I pulled the numbers. Here's where things stand.",
  still: "Still digging — want to get this right.",
  nudge: "Take your time. What can I look into for you?",
  goodbye: "Anytime. Call back when you want a read on the market.",
  timeout: "That one's fighting me — let me come at it differently. Ask me again, or point me somewhere else.",
};

// Spoken while a slow turn is still working. Varied + advisor-toned so it never
// feels like a robotic "got it, on it". Only plays when a turn runs long.
const THINKING = [
  'Let me pull the latest on that.',
  'Checking the numbers now.',
  'Getting the live read for you.',
  'One sec while I dig into that.',
];
const pickThinking = () => THINKING[Math.floor(Math.random() * THINKING.length)];

const MAX_WAIT_LOOPS = 100; // ~2 minutes at 1s per loop + overhead
const FAST_PATH_MS = 5000; // wait this long inline before falling back to the hold loop

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

// Open the mic for the caller's next turn. Deliberately a BARE gather with no
// prompt nested inside it: we always speak the answer/greeting with a separate
// <Say>/<Play> FIRST, so Twilio is not listening while we talk. That stops
// background noise (or the caller's "mm-hm") from barging in and cutting the
// answer off — the #1 reason it used to feel like it "restarted at any noise".
// `timeout` is the patience for speech to START; speechTimeout 'auto' detects
// the natural end once they're talking.
function listen(vr) {
  return vr.gather({
    input: 'speech',
    action: '/voice/turn',
    method: 'POST',
    timeout: 8,
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
  const isOwner = config.allowedCallers.includes(caller);

  // Locked-down mode: only the owner's numbers may call.
  if (!config.publicMode && !isOwner) {
    console.warn(`[server] blocked caller ${caller} (PUBLIC_MODE=false)`);
    const vr = new VoiceResponse();
    vr.say({ voice: 'Polly.Matthew-Neural' }, 'This clanker does not know you. Goodbye.');
    vr.hangup();
    return sendTwiml(res, vr);
  }

  // Guardrails (owners are exempt). Too many calls at once: stay under the
  // ElevenLabs concurrency cap and bound cost during a spike.
  if (!isOwner && sessions.size >= config.limits.maxConcurrentCalls) {
    console.warn(`[server] at capacity (${sessions.size}) — turning away ${caller}`);
    const vr = new VoiceResponse();
    vr.say({ voice: 'Polly.Matthew-Neural' }, 'A lot of people are calling right now. Try me again in a few minutes.');
    vr.hangup();
    return sendTwiml(res, vr);
  }
  // One caller dialing over and over.
  if (!isOwner && callerRateLimited(caller)) {
    console.warn(`[server] rate-limited caller ${caller}`);
    const vr = new VoiceResponse();
    vr.say({ voice: 'Polly.Matthew-Neural' }, "That's a lot of calls. Give it a little while and ring me back.");
    vr.hangup();
    return sendTwiml(res, vr);
  }

  console.log(`[server] call ${CallSid} from ${caller} (${Direction}, ${isOwner ? 'owner' : 'public'})`);
  const session = new ClankerSession(CallSid, { callerNumber: caller, isOwner });
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
    await speak(vr, isOwner ? LINES.ownerGreeting : LINES.greeting);
    listen(vr);
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

  // Empty result = silence or unrecognized noise. Don't nag or make them feel
  // like they're starting over — just keep the line open. Only after a few
  // empties in a row do we give a soft nudge, then eventually bow out.
  if (!speech) {
    session.emptyTurns = (session.emptyTurns || 0) + 1;
    if (session.emptyTurns >= 4) {
      await speak(vr, LINES.goodbye);
      vr.hangup();
      return sendTwiml(res, vr);
    }
    if (session.emptyTurns === 2) await speak(vr, LINES.nudge);
    listen(vr);
    vr.redirect({ method: 'POST' }, '/voice/turn');
    return sendTwiml(res, vr);
  }
  session.emptyTurns = 0;

  if (/\b(goodbye|bye|hang up|that's all|that is all)\b/i.test(speech)) {
    await speak(vr, LINES.goodbye);
    vr.hangup();
    return sendTwiml(res, vr);
  }

  // Cap conversation length per call to bound cost/abuse (owners exempt).
  session.turnCount = (session.turnCount || 0) + 1;
  if (!session.isOwner && session.turnCount > config.limits.maxTurnsPerCall) {
    console.log(`[server] ${req.body.CallSid} hit turn cap (${session.turnCount})`);
    await speak(vr, "That's a good run — I've got to free up the line. Call back anytime.");
    vr.hangup();
    return sendTwiml(res, vr);
  }

  session.beginTurn(speech);
  if (await turnFinishesQuickly(session)) {
    // Fast path: speak the answer, THEN open the mic (no barge-in on the answer).
    await speak(vr, session.turn.answer);
    listen(vr);
    vr.redirect({ method: 'POST' }, '/voice/turn');
  } else {
    await speak(vr, pickThinking());
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
    await speak(vr, turn.answer);
    listen(vr);
    vr.redirect({ method: 'POST' }, '/voice/turn');
  } else if (n >= MAX_WAIT_LOOPS) {
    await speak(vr, LINES.timeout);
    listen(vr);
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
// Requires the CALL_SECRET (header x-call-secret or body `secret`). This route
// can dial arbitrary numbers from the Twilio account, so on a public URL it
// MUST be gated — and is disabled entirely if no secret is configured.
app.post('/call', async (req, res) => {
  const provided = req.headers['x-call-secret'] || req.body.secret;
  if (!config.callSecret || provided !== config.callSecret) {
    console.warn('[server] rejected /call (bad or missing CALL_SECRET)');
    return res.status(403).json({ error: 'forbidden' });
  }
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
  for (const line of [...Object.values(LINES), ...THINKING]) await synthesize(line).catch(() => {});
});
