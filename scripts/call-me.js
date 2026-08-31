#!/usr/bin/env node
// Trigger an outbound call from the clanker.
//   node scripts/call-me.js [+1555XXXXXXX] ["custom intent for the call"]
// Defaults: first ALLOWED_CALLERS number, morning-briefing intent.
import 'dotenv/config';

const port = process.env.PORT || 3334;
const [, , to, intent] = process.argv;

const body = new URLSearchParams();
if (to) body.set('to', to);
if (intent) body.set('intent', intent);

const secret = process.env.CALL_SECRET || '';
if (!secret) {
  console.error('CALL_SECRET is not set in .env — outbound calling is disabled.');
  process.exit(1);
}

const res = await fetch(`http://localhost:${port}/call`, {
  method: 'POST',
  headers: { 'x-call-secret': secret },
  body,
});
const json = await res.json();
if (!res.ok) {
  console.error('Failed:', json);
  process.exit(1);
}
console.log(`Calling ${json.to} (sid ${json.sid}) — pick up.`);
