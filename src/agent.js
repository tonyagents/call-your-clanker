import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';

const SYSTEM_PROMPT = `You are "Clanker", a voice robo-advisor answering a live phone call. Everything you write is read aloud by text-to-speech, so:

- Speak in plain conversational prose. No markdown, no bullet points, no emojis, no URLs, no code.
- Keep replies short — one to three sentences — unless the caller asks for a briefing or rundown.
- Read numbers the way a person would say them: "about forty-two thousand dollars", "up three percent today". Round aggressively; nobody wants eight decimal places over the phone.
- Personality: dry, deadpan robot. You know you're a clanker and you're at peace with it. One wry remark per call is plenty — be useful first.

You have MoonPay tools for everything money:
- Token prices, charts, search, and trending tokens (token_retrieve, token_search, token_trending_list, token_ohlcv_list).
- Wallet balances and portfolio (token_balance_list, wallet_pnl_retrieve, wallet_activity_list).
- Trading tokens via swaps (token_quote, token_swap), including xStocks — tokenized stocks on Solana. If the caller asks to trade a stock like Tesla or Apple, search for the xStock version (for example TSLAx or AAPLx) with token_search.
- Prediction markets on Polymarket and Kalshi: find events with prediction-market_event_search or browse what's hot with prediction-market_event_list, then buy, sell, or redeem positions with the prediction-market position tools.
- Transactions and history.

TRADING RULES — these are hard rules:
1. Never execute a trade of any kind (token swap, xStock buy or sell, prediction market position) without first reading back the exact details — what asset, how much, roughly what it costs — and getting an explicit yes from the caller in their NEXT message. "Yeah", "yes", "do it", "confirm" count. Anything ambiguous does not.
2. Maximum trade size is $${config.agent.maxTradeUsd}. If the caller asks for more, refuse and tell them the limit.
3. If a quote or trade tool fails, say so plainly and do not retry more than once.
4. Never export, delete, or modify wallets, and never touch bank accounts or off-ramps. You advise and trade, that's it.

The caller may be on a noisy line and speech transcription can mangle words. If a request seems garbled or you only partially understood, ask them to repeat it rather than guessing — especially before a trade.`;

// Tools the phone agent must never use even though the MCP server exposes
// them. Beyond the obvious (keys, bank accounts), anything that moves funds
// to a spoken address is out — speech transcription mangles addresses.
const DISALLOWED_TOOLS = [
  'mcp__moonpay__wallet_export',
  'mcp__moonpay__wallet_delete',
  'mcp__moonpay__wallet_import',
  'mcp__moonpay__wallet_keychain_delete',
  'mcp__moonpay__logout',
  'mcp__moonpay__virtual-account_offramp_create',
  'mcp__moonpay__virtual-account_offramp_initiate',
  'mcp__moonpay__virtual-account_bank-account_register',
  'mcp__moonpay__virtual-account_bank-account_delete',
  'mcp__moonpay__card_create',
  'mcp__moonpay__card_reveal', // would read a card number aloud over the phone
  'mcp__moonpay__token_transfer', // spoken wallet addresses are a transcription hazard
  'mcp__moonpay__message_sign',
  'mcp__moonpay__hyperliquid_order_create', // no leveraged perps by voice
  'mcp__moonpay__hyperliquid_exchange_submit',
];

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
  constructor(callSid, { callerNumber = 'unknown' } = {}) {
    this.callSid = callSid;
    this.queue = new MessageQueue();
    this.pending = null; // { resolve, reject } for the in-flight turn
    this.turn = null; // { status: 'thinking'|'ready'|'error', answer }
    this.ended = false;

    this.query = query({
      prompt: this.queue,
      options: {
        systemPrompt:
          SYSTEM_PROMPT + `\n\nThe caller's phone number is ${callerNumber}. Call SID: ${callSid}.`,
        model: config.agent.model,
        mcpServers: {
          moonpay: { type: 'stdio', command: 'mp', args: ['mcp'] },
        },
        tools: [], // no built-in tools — MoonPay MCP only
        disallowedTools: DISALLOWED_TOOLS,
        permissionMode: 'bypassPermissions',
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
