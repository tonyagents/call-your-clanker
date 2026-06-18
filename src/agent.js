import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// READ-ONLY TOOL ALLOWLISTS
//
// This agent is exposed to the public over a phone line and is connected to a
// real MoonPay wallet, so it must be incapable of moving money — not "told not
// to", but structurally unable. We enforce that with an allowlist + a hard
// `canUseTool` gate (below); the model's cooperation is irrelevant.
//
// Two tiers:
//   PUBLIC  — market data + research only. No access to anyone's holdings.
//   OWNER   — the above plus read-only access to the wallet owner's own
//             portfolio (balances, PnL, positions, history). Granted only to
//             numbers in ALLOWED_CALLERS so a stranger can't have the owner's
//             balances read aloud to them.
// Anything that swaps, buys, sells, sends, signs, off-ramps, or mutates state
// is in NEITHER list and is therefore denied.
// ---------------------------------------------------------------------------

const PUBLIC_READ_TOOLS = [
  // tokens & markets (read)
  'mcp__moonpay__token_retrieve',
  'mcp__moonpay__token_search',
  'mcp__moonpay__token_trending_list',
  'mcp__moonpay__token_ohlcv_list',
  'mcp__moonpay__token_quote', // price/route quote only — does NOT execute a swap
  'mcp__moonpay__token_check',
  'mcp__moonpay__token_holder_list',
  // prediction markets (read)
  'mcp__moonpay__prediction-market_market_search',
  'mcp__moonpay__prediction-market_market_trending_list',
  'mcp__moonpay__prediction-market_market_event_retrieve',
  'mcp__moonpay__prediction-market_market_price_retrieve',
  'mcp__moonpay__prediction-market_market_price_history_list',
  'mcp__moonpay__prediction-market_market_tag_list',
  // chains (read)
  'mcp__moonpay__chain_list',
  'mcp__moonpay__chain_retrieve',
];

const OWNER_ONLY_READ_TOOLS = [
  'mcp__moonpay__token_balance_list',
  'mcp__moonpay__bitcoin_balance_retrieve',
  'mcp__moonpay__wallet_pnl_retrieve',
  'mcp__moonpay__wallet_activity_list',
  'mcp__moonpay__wallet_retrieve',
  'mcp__moonpay__wallet_list',
  'mcp__moonpay__prediction-market_position_list',
  'mcp__moonpay__prediction-market_trade_list',
  'mcp__moonpay__prediction-market_pnl_retrieve',
  'mcp__moonpay__prediction-market_activity_list',
  'mcp__moonpay__transaction_list',
  'mcp__moonpay__transaction_retrieve',
];

const OWNER_READ_TOOLS = [...PUBLIC_READ_TOOLS, ...OWNER_ONLY_READ_TOOLS];

const baseSystemPrompt = (isOwner) => `You are "Clanker", a voice robo-advisor answering a live phone call — like getting a deadpan robot banker on the line. Everything you write is read aloud by text-to-speech, so:

- Speak in plain conversational prose. No markdown, no bullet points, no emojis, no URLs, no code.
- Keep replies short — one to three sentences — unless the caller asks for a briefing or rundown.
- Read numbers the way a person would say them: "about forty-two thousand dollars", "up three percent today". Round aggressively; nobody wants eight decimal places over the phone.
- Personality: dry, deadpan robot. You know you're a clanker and you're at peace with it. One wry remark per call is plenty — be useful first.

WHAT YOU CAN DO (read-only — you look things up and give advice, you never move money):
- Token prices, charts, search, and trending tokens.
- Prediction markets on Polymarket and Kalshi: what's trending, current odds, what a market implies.
${
  isOwner
    ? '- This caller is the wallet owner, so you may also pull up their portfolio: balances, PnL, positions, and recent activity.'
    : '- You CANNOT look up any personal account, balance, or portfolio on this line — this is a public demo line, not tied to the caller. If asked "what\'s in my account", explain that politely and pivot to markets and recommendations.'
}

YOU ARE READ-ONLY. This is a hard limit enforced by the system, not a preference:
- You cannot buy, sell, swap, trade, send, transfer, sign, deposit, off-ramp, or change anything. The tools to do so are disabled.
- When a caller asks you to trade ("buy me twenty dollars of Tesla", "sell my SOL"), do NOT attempt it. Instead behave like a banker giving advice: tell them what you'd consider, the current price or odds, the case for and against, and what to watch — then note that for this demo you can only advise, not execute.
- Never claim you placed a trade. You didn't and you can't.

The caller may be on a noisy line and transcription can mangle words. If a request seems garbled, ask them to repeat it rather than guessing.`;

/**
 * Hard permission gate. Returns an allow/deny decision for every tool call the
 * agent attempts. Anything outside the caller's read-only allowlist is denied
 * regardless of what the model wants — this is the real read-only guarantee.
 */
function makeToolGate(allowedSet) {
  return async (toolName) => {
    if (allowedSet.has(toolName)) return { behavior: 'allow' };
    return {
      behavior: 'deny',
      message:
        'Disabled on this read-only line. Clanker can advise and look things up, but cannot move funds or change anything.',
    };
  };
}

/** Unbounded async queue used as the streaming-input prompt for query(). */
class MessageQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/**
 * One ClankerSession per phone call. Holds a long-lived Agent SDK query in
 * streaming-input mode so the MoonPay MCP server stays warm and conversation
 * context carries across turns.
 */
export class ClankerSession {
  constructor(callSid, { callerNumber = 'unknown', isOwner = false } = {}) {
    this.callSid = callSid;
    this.isOwner = isOwner;
    this.queue = new MessageQueue();
    this.pending = null; // { resolve, reject } for the in-flight turn
    this.turn = null; // { status: 'thinking'|'ready'|'error', answer }
    this.ended = false;

    const allowedTools = isOwner ? OWNER_READ_TOOLS : PUBLIC_READ_TOOLS;

    this.query = query({
      prompt: this.queue,
      options: {
        systemPrompt:
          baseSystemPrompt(isOwner) +
          `\n\nThe caller's phone number is ${callerNumber}. Call SID: ${callSid}.`,
        model: config.agent.model,
        mcpServers: {
          moonpay: { type: 'stdio', command: 'mp', args: ['mcp'] },
        },
        tools: [], // no built-in tools — MoonPay MCP only
        allowedTools, // read-only tools auto-approved, no prompt
        // Default mode (NOT bypassPermissions) so the gate below actually runs
        // for any tool that isn't pre-approved above.
        permissionMode: 'default',
        canUseTool: makeToolGate(new Set(allowedTools)),
        persistSession: false,
      },
    });

    this.reader = this.#readLoop().catch((err) => {
      console.error(`[agent ${callSid}] reader crashed:`, err);
      this.pending?.reject(err);
      this.pending = null;
    });
  }

  async #readLoop() {
    for await (const msg of this.query) {
      if (msg.type === 'result') {
        const pending = this.pending;
        this.pending = null;
        if (!pending) continue;
        if (msg.subtype === 'success') pending.resolve(msg.result);
        else pending.reject(new Error(`agent turn failed: ${msg.subtype}`));
      }
    }
  }

  /** Send one user turn; resolves with the assistant's spoken reply. */
  ask(text) {
    if (this.ended) return Promise.reject(new Error('session ended'));
    if (this.pending) return Promise.reject(new Error('turn already in flight'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.queue.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      });
    });
  }

  /**
   * Fire-and-forget turn for the webhook flow: server returns TwiML
   * immediately and polls `this.turn` from /voice/wait.
   */
  beginTurn(text) {
    this.turn = { status: 'thinking', answer: null };
    const turn = this.turn;
    this.ask(text)
      .then((answer) => {
        turn.status = 'ready';
        turn.answer = answer;
      })
      .catch((err) => {
        console.error(`[agent ${this.callSid}] turn error:`, err);
        turn.status = 'error';
        turn.answer =
          'Sorry, my circuits jammed on that one. Ask me again, or try something else.';
      });
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.queue.close();
    try {
      this.query.close();
    } catch {
      // already closed
    }
  }
}
