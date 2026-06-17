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

const res = await fetch(`http://localhost:${port}/call`, { method: 'POST', body });
const json = await res.json();
if (!res.ok) {
  console.error('Failed:', json);
  process.exit(1);
}
console.log(`Calling ${json.to} (sid ${json.sid}) — pick up.`);
