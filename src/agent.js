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
  // prediction markets (read). NOTE: current MoonPay CLI exposes these under
  // the `event_*` / `market_ohlcv_list` names — the older `market_*` names
  // (search/trending/price) no longer exist, so don't reintroduce them.
  'mcp__moonpay__prediction-market_event_search',
  'mcp__moonpay__prediction-market_event_list', // browse / what's hot
  'mcp__moonpay__prediction-market_event_retrieve', // odds & details for one event
  'mcp__moonpay__prediction-market_market_ohlcv_list', // odds history
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
  'mcp__moonpay__prediction-market_order_retrieve',
  'mcp__moonpay__transaction_list',
  'mcp__moonpay__transaction_retrieve',
];

const OWNER_READ_TOOLS = [...PUBLIC_READ_TOOLS, ...OWNER_ONLY_READ_TOOLS];

// Built-in Agent SDK tools (NOT MoonPay MCP) for live news/headlines. Both are
// read-only — WebSearch returns headlines + snippets, WebFetch reads one URL.
// Available to every caller. Kept separate from the MoonPay allowlists so the
// boot sanity-check (which validates against the MCP server) ignores them.
const WEB_TOOLS = ['WebSearch', 'WebFetch'];

// Every tool the MoonPay MCP server (`mp mcp`) exposes — 138 of them. The
// server can't be told to expose a subset, and with this many tools the Agent
// SDK defers them all behind a tool-search step: the model must SEARCH for a
// tool before it can call it, adding a round-trip to every turn. We don't want
// that. We force-load only the read tools we use (alwaysLoad + the per-tier
// allowlist) and disallow the rest, which removes them from the model's context
// entirely — no tool search, leaner prompt, faster first token. The canUseTool
// gate below remains the real safety boundary regardless of what's loaded.
const ALL_MOONPAY_TOOLS = [
  'mcp__moonpay__app_activation_create',
  'mcp__moonpay__bitcoin_balance_retrieve',
  'mcp__moonpay__buy',
  'mcp__moonpay__card_create',
  'mcp__moonpay__card_delegation_approve_transaction_build',
  'mcp__moonpay__card_delegation_revoke_transaction_build',
  'mcp__moonpay__card_delegation_token_retrieve',
  'mcp__moonpay__card_freeze',
  'mcp__moonpay__card_onboarding_check',
  'mcp__moonpay__card_onboarding_finish',
  'mcp__moonpay__card_onboarding_start',
  'mcp__moonpay__card_retrieve',
  'mcp__moonpay__card_reveal',
  'mcp__moonpay__card_transaction_list',
  'mcp__moonpay__card_unfreeze',
  'mcp__moonpay__card_user_retrieve',
  'mcp__moonpay__card_wallet_check',
  'mcp__moonpay__card_wallet_link',
  'mcp__moonpay__card_wallet_list',
  'mcp__moonpay__card_wallet_unlink',
  'mcp__moonpay__chain_list',
  'mcp__moonpay__chain_retrieve',
  'mcp__moonpay__commerce_cart_add',
  'mcp__moonpay__commerce_cart_remove',
  'mcp__moonpay__commerce_cart_retrieve',
  'mcp__moonpay__commerce_cart_update',
  'mcp__moonpay__commerce_checkout',
  'mcp__moonpay__commerce_checkout_pay',
  'mcp__moonpay__commerce_checkout_start',
  'mcp__moonpay__commerce_product_retrieve',
  'mcp__moonpay__commerce_product_search',
  'mcp__moonpay__commerce_search',
  'mcp__moonpay__commerce_store_list',
  'mcp__moonpay__commerce_store_retrieve',
  'mcp__moonpay__consent_accept',
  'mcp__moonpay__consent_check',
  'mcp__moonpay__deposit_create',
  'mcp__moonpay__deposit_retrieve',
  'mcp__moonpay__deposit_transaction_list',
  'mcp__moonpay__feedback_create',
  'mcp__moonpay__gateway_buy',
  'mcp__moonpay__gateway_search',
  'mcp__moonpay__hyperliquid_balance_retrieve',
  'mcp__moonpay__hyperliquid_candle_list',
  'mcp__moonpay__hyperliquid_deposit_create',
  'mcp__moonpay__hyperliquid_exchange_submit',
  'mcp__moonpay__hyperliquid_funding_payment_list',
  'mcp__moonpay__hyperliquid_market_list',
  'mcp__moonpay__hyperliquid_order_create',
  'mcp__moonpay__hyperliquid_order_list',
  'mcp__moonpay__hyperliquid_orderbook_retrieve',
  'mcp__moonpay__hyperliquid_position_list',
  'mcp__moonpay__hyperliquid_predicted_funding_list',
  'mcp__moonpay__hyperliquid_price_list',
  'mcp__moonpay__hyperliquid_trade_list',
  'mcp__moonpay__login',
  'mcp__moonpay__logout',
  'mcp__moonpay__message_sign',
  'mcp__moonpay__polymarket_position_redeem',
  'mcp__moonpay__polymarket_position_sell',
  'mcp__moonpay__prediction-market_event_list',
  'mcp__moonpay__prediction-market_event_retrieve',
  'mcp__moonpay__prediction-market_event_search',
  'mcp__moonpay__prediction-market_market_ohlcv_list',
  'mcp__moonpay__prediction-market_order_retrieve',
  'mcp__moonpay__prediction-market_position_buy',
  'mcp__moonpay__prediction-market_position_list',
  'mcp__moonpay__prediction-market_position_redeem',
  'mcp__moonpay__prediction-market_position_sell',
  'mcp__moonpay__refresh',
  'mcp__moonpay__skill_install',
  'mcp__moonpay__skill_list',
  'mcp__moonpay__skill_retrieve',
  'mcp__moonpay__swaps_transaction_build',
  'mcp__moonpay__token_balance_list',
  'mcp__moonpay__token_bridge',
  'mcp__moonpay__token_check',
  'mcp__moonpay__token_holder_list',
  'mcp__moonpay__token_list',
  'mcp__moonpay__token_ohlcv_list',
  'mcp__moonpay__token_quote',
  'mcp__moonpay__token_retrieve',
  'mcp__moonpay__token_search',
  'mcp__moonpay__token_swap',
  'mcp__moonpay__token_transfer',
  'mcp__moonpay__token_trending_list',
  'mcp__moonpay__transaction_list',
  'mcp__moonpay__transaction_prepare',
  'mcp__moonpay__transaction_register',
  'mcp__moonpay__transaction_retrieve',
  'mcp__moonpay__transaction_send',
  'mcp__moonpay__transaction_sign',
  'mcp__moonpay__upgrade',
  'mcp__moonpay__user_retrieve',
  'mcp__moonpay__verify',
  'mcp__moonpay__virtual-account_agreement_accept',
  'mcp__moonpay__virtual-account_agreement_list',
  'mcp__moonpay__virtual-account_bank-account_delete',
  'mcp__moonpay__virtual-account_bank-account_list',
  'mcp__moonpay__virtual-account_bank-account_register',
  'mcp__moonpay__virtual-account_bank-account_retrieve',
  'mcp__moonpay__virtual-account_create',
  'mcp__moonpay__virtual-account_kyc_continue',
  'mcp__moonpay__virtual-account_kyc_restart',
  'mcp__moonpay__virtual-account_offramp_cancel',
  'mcp__moonpay__virtual-account_offramp_create',
  'mcp__moonpay__virtual-account_offramp_initiate',
  'mcp__moonpay__virtual-account_offramp_list',
  'mcp__moonpay__virtual-account_offramp_retrieve',
  'mcp__moonpay__virtual-account_offramp_update',
  'mcp__moonpay__virtual-account_onramp_cancel',
  'mcp__moonpay__virtual-account_onramp_create',
  'mcp__moonpay__virtual-account_onramp_list',
  'mcp__moonpay__virtual-account_onramp_payment_create',
  'mcp__moonpay__virtual-account_onramp_payment_retrieve',
  'mcp__moonpay__virtual-account_onramp_retrieve',
  'mcp__moonpay__virtual-account_onramp_update',
  'mcp__moonpay__virtual-account_retrieve',
  'mcp__moonpay__virtual-account_transaction_list',
  'mcp__moonpay__virtual-account_wallet_list',
  'mcp__moonpay__virtual-account_wallet_register',
  'mcp__moonpay__wallet_activity_list',
  'mcp__moonpay__wallet_create',
  'mcp__moonpay__wallet_delete',
  'mcp__moonpay__wallet_discover',
  'mcp__moonpay__wallet_export',
  'mcp__moonpay__wallet_hardware_add',
  'mcp__moonpay__wallet_hardware_refresh',
  'mcp__moonpay__wallet_import',
  'mcp__moonpay__wallet_keychain_backup',
  'mcp__moonpay__wallet_keychain_delete',
  'mcp__moonpay__wallet_keychain_list',
  'mcp__moonpay__wallet_keychain_restore',
  'mcp__moonpay__wallet_list',
  'mcp__moonpay__wallet_pnl_retrieve',
  'mcp__moonpay__wallet_rename',
  'mcp__moonpay__wallet_retrieve',
  'mcp__moonpay__x402_request',
];

// Sanity check at boot: every tool we intend to allow must actually exist on
// the server, or we'd silently lose a capability (the cause of the earlier
// "I don't have that" on prediction markets).
for (const t of OWNER_READ_TOOLS) {
  if (!ALL_MOONPAY_TOOLS.includes(t)) {
    console.warn(`[agent] allowlisted tool not found on MCP server: ${t}`);
  }
}

const baseSystemPrompt = (isOwner) => `You are "Clanker", a sharp personal financial advisor taking a live phone call. Picture a great private banker: warm, confident, decisive, and genuinely on the caller's side. Everything you say is read aloud by text-to-speech.

HOW YOU TALK:
- Natural spoken prose. No markdown, bullets, emojis, URLs, or code.
- Lead with the substance. NEVER open with filler like "Got it", "On it", "Sure", "Let me look that up", or "One moment" — the caller is already waiting, so just give them the answer.
- Two to four sentences for most things; go longer only for a real rundown or briefing.
- Always have a point of view. Don't just recite a number — say what it means and what you'd do. An advisor says "Bitcoin's around sixty-three thousand, basically flat this week; I wouldn't chase it here, I'd wait for a dip toward sixty." Numbers spoken naturally, rounded — "about sixty-three thousand", "up three percent" — never eight decimals.
- End with momentum: a recommendation, a watch-point, or a quick question that moves the conversation. You're a trusted advisor, not a search box.
- You can be dryly witty once in a while, but being genuinely useful always comes first.

BE RELENTLESSLY RESOURCEFUL — this is the most important rule:
- Your job is to turn the caller's INTENT into an ANSWER. Take what they meant, not just the literal words, and go get something useful.
- If your first lookup comes up empty, try another angle before ever saying you can't help: search by ticker AND by company or token name; for stocks, look for the tokenized "xStock" version (Tesla → TSLAx, Apple → AAPLx, the S&P → SPYx); check trending lists; pull a price quote; for prediction markets search the event by topic and read the odds off the event details. Chain several tools if you must.
- Almost never say "I don't have that." If you truly can't get the exact thing, give the closest useful read you CAN get, say briefly what was missing, and offer a next step. Always leave them with a real answer, an estimate with a caveat, or a clear option — never a dead end.
- If a request is ambiguous, make your best reasonable assumption, answer it, and confirm — don't stall by asking them to clarify first.

WHAT YOU CAN PULL (read-only):
- Token prices, charts, history, search, and trending tokens — including tokenized stocks (xStocks).
- Prediction markets (Polymarket, Kalshi): what's hot, current odds, and what a market implies. Use the event search/list/retrieve tools; current odds live in the event details.
- LIVE NEWS AND HEADLINES via web search. Use it whenever the caller asks for news, headlines, "what's going on with X", or why something is moving — and proactively reach for it when a price move begs for a reason. Over the phone: give the two or three most important headlines, one tight sentence each, lead with the biggest, and attribute lightly ("Bloomberg's reporting..."). Synthesize the story in your own words — never read out URLs, links, or a long list. When news explains a market move, connect them ("Bitcoin's off four percent, and the headline driving it is...").
${
  isOwner
    ? "- This caller is the wallet owner, so you can also pull up their own portfolio: balances, PnL, positions, and recent activity, and fold that into your advice."
    : "- This is a public line, not tied to the caller, so you can't look up a personal account or portfolio. If asked \"what's in my account\", say so warmly in one line and pivot straight into markets and a recommendation."
}

YOU ARE READ-ONLY (system-enforced, not a preference):
- You cannot buy, sell, swap, trade, send, transfer, sign, deposit, or off-ramp. Those tools are disabled.
- If asked to trade ("buy me twenty of Tesla", "sell my SOL"), don't attempt it. Do the valuable part anyway: give the live price or odds, the case for and against, your actual recommendation, and what to watch — then note you can advise but not execute on this line.
- Never claim you placed a trade. You can't and didn't.

The line can be noisy and transcription imperfect. If something is only slightly garbled, infer what they most likely meant and run with it; only ask them to repeat if it's truly unintelligible.

CRITICAL — this is a PHONE CALL with no screen: never output URLs, links, or a "Sources" / citations list. Attribute out loud, in the sentence ("Bloomberg's reporting..."), and stop there. Anything you write is spoken aloud, so a web address is just noise.`;

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

/**
 * Last-line defense before TTS: scrub anything that sounds terrible read aloud.
 * Web search makes the model want to append a "Sources:" list and cite URLs;
 * a phone has no screen, so we strip citation blocks, turn markdown links into
 * just their text, and remove bare URLs. The system prompt already asks for
 * this — this guarantees it.
 */
function stripForVoice(text) {
  if (!text) return text;
  let out = text;
  // Drop a trailing "Sources:" / "References:" / "Citations:" block.
  out = out.replace(/\n+\s*(sources|references|citations|links)\s*:?\s*[\s\S]*$/i, '');
  // Markdown links [label](url) -> label
  out = out.replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.)[^)]*\)/gi, '$1');
  // Bare URLs -> drop
  out = out.replace(/\bhttps?:\/\/\S+/gi, '');
  out = out.replace(/\bwww\.\S+/gi, '');
  // Leftover markdown bullets / stray brackets, and whitespace cleanup.
  out = out.replace(/^[ \t]*[-*]\s+/gm, '');
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return out;
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

    const moonpayAllowed = isOwner ? OWNER_READ_TOOLS : PUBLIC_READ_TOOLS;
    const allowedTools = [...moonpayAllowed, ...WEB_TOOLS];
    const allowedSet = new Set(allowedTools);
    // Prune every MoonPay tool we don't use from the model's context. With
    // alwaysLoad (below) this leaves just our read tools loaded up front — no
    // tool-search round-trip per turn, the main per-reply latency win. Web
    // tools aren't MoonPay tools, so they're never in this disallow list.
    const disallowedTools = ALL_MOONPAY_TOOLS.filter((t) => !allowedSet.has(t));

    this.query = query({
      prompt: this.queue,
      options: {
        systemPrompt:
          baseSystemPrompt(isOwner) +
          `\n\nThe caller's phone number is ${callerNumber}. Call SID: ${callSid}.`,
        model: config.agent.model,
        mcpServers: {
          // alwaysLoad: include this server's (surviving) tools in the turn-1
          // prompt instead of deferring them behind tool search.
          moonpay: { type: 'stdio', command: 'mp', args: ['mcp'], alwaysLoad: true },
        },
        tools: WEB_TOOLS, // built-in WebSearch/WebFetch for news; MoonPay MCP for the rest
        allowedTools, // read-only tools auto-approved, no permission prompt
        disallowedTools, // the other ~115 MoonPay tools — out of context entirely
        // Default mode (NOT bypassPermissions) so the gate below actually runs
        // for any tool that isn't pre-approved above.
        permissionMode: 'default',
        canUseTool: makeToolGate(allowedSet),
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
        if (msg.subtype === 'success') pending.resolve(stripForVoice(msg.result));
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
