/* PROTOTYPE — wayfinder #645. Injected BEFORE the real dashboard script.
   Throwaway. Canned state, no daemon, no network.

   This half does one thing: it replaces `fetch` so the real page's own poll
   draws a canned incident instead of a live box. Everything the page does
   after that — the shell, the nav, the tiles, the fleet table, the feed — is
   the real page's code, unmodified. That is the whole point of mounting the
   variants here rather than on a blank route: a credentials surface looks
   fine in a vacuum and has to survive the density it actually lands in.

   The wire shape below is `GET /overview` as `credentialsStatus()` really
   answers it (dispatch.mjs:1768), not an invention:

     credentials: {
       consumers: [{ consumer, state, expires_at, why, last_refresh_at, last_error }],
       reauth:    { consumer, session, state, url, code, started_at, expires_at, seconds_left } | null
     }

   states:  valid · expiring · expired · unreadable · absent · unowned
   reauth:  starting · waiting · done · timeout · abandoned · failed          */

/* The whole prototype's state, and it rides the URL so a variant is shareable
   and reload-stable: `?variant=B&step=3&phone=1`. */
const P_PARAMS = new URLSearchParams(location.search);
var PROTO = {
  step: Number(P_PARAMS.get('step') ?? 0) || 0,
  variant: (P_PARAMS.get('variant') ?? 'A').toUpperCase(),
  phone: P_PARAMS.get('phone') === '1',
  dismissed: false,      /* variant C only: the takeover the operator pushed away */
  stepStartedAt: Date.now(),
};

const P_NOW = Date.now();
const p_at = (s) => new Date(P_NOW - s * 1000).toISOString();
const p_ahead = (m) => new Date(P_NOW + m * 60_000).toISOString();

/* The tailnet dashboard, as `tailscale serve` publishes it. Fake host, real shape. */
const DASH_URL = 'https://coinmatica.taile1a2b.ts.net:8443';

/* ---- the two codex agents that died on 2026-08-23 -------------------------- */

const agent = (over) => ({
  session: 'curia-574', repo: 'alp82/curia', ticket: '574', title: 'The stall watchdog',
  model: 'gpt-5.6-sol', reviewer: false, state: 'ready', uptime_s: 26_400,
  result_received: false, tmux_live: true, waiting_on: [], ctx_pct: 62, ctx_over: false,
  last_contact_s: 30, ...over,
});

const LIVE = (contact) => [
  agent({ last_contact_s: contact }),
  agent({ session: 'curia-578', ticket: '578', title: 'A ticket that dies after it speaks', ctx_pct: 71, last_contact_s: contact }),
  agent({ session: 'curia-263', ticket: '263', title: 'The sidecar stands up', model: 'claude-opus-5', ctx_pct: 41, uptime_s: 900, last_contact_s: 12 }),
];

/* ---- the base payload ------------------------------------------------------
   Lifted from daemon/test/dashboardpage.test.mjs so the neighbours on this page
   are the ones the real page's own test draws. Each step overrides one slice. */

const BASE = () => ({
  at: p_at(0),
  daemon: {
    port: 4271, uptime_s: 7200, auto_dispatch: true, max_concurrent: 3,
    config: {
      loaded_at: p_at(7200),
      dispatch: { auto_dispatch: true, max_concurrent: 3, poll_interval_s: 60 },
      watch: [{ repo: 'alp82/curia', mode: 'auto' }, { repo: 'alp82/aistack', mode: 'map' }],
      routing: {
        defaults: [{ type: 'grilling', model: 'opus' }, { type: 'research', model: 'gpt' }, { type: 'untyped', model: 'opus' }],
        models: [{ name: 'fable', active: false }, { name: 'opus', active: true }, { name: 'gpt', active: true }],
      },
    },
  },
  agents: LIVE(30),
  untracked: [],
  recent: [{ kind: 'finished', repo: 'alp82/curia', ticket: '261' }],
  fleet_error: null,
  escalations: [{
    id: 'esc-7', agent: 'curia-255', ticket: '255', kind: 'choice',
    prompt: 'Two notes race the same expiry line. Drop the older note, or post both with stamps?',
    options: ['Drop the older note', 'Post both with stamps'], preview_url: null,
    opened_at: p_at(720), agent_died: false, rendered: true, thread_id: '99',
  }],
  review_gate: [],
  bridge: 'up',
  bridge_health: { state: 'up', since: p_at(9000), unhealthy_for_s: 0, last_error: null },
  usage: [
    { provider: 'anthropic', from: 'account', session: null, windows: [
      { label: '5h', pct: 58, elapsed_pct: 48, resets_at: p_ahead(90), fresh: true },
      { label: '7d', pct: 22, elapsed_pct: 41, resets_at: p_ahead(4000), fresh: true },
    ] },
  ],
  token_warnings: [],
  pre_cooling: [],
  dispatch_holds: [],
  events: [
    { ts: p_at(600), type: 'agent_spawned', agent: 'curia-574', repo: 'alp82/curia', ticket: '574', model: 'gpt-5.6-sol', harness: 'codex' },
    { ts: p_at(400), type: 'esc_open', id: 'esc-7', agent: 'curia-255', ticket: '255', kind: 'choice', prompt: 'Two notes race the same expiry line.' },
  ],
  deploy: { in_flight: null, last: null, verdict_read_error: null },
  frontier: {
    computed_at: p_at(120),
    repos: [
      { repo: 'alp82/curia', lane: 'map', numbers: [645, 646], agentOnly: 2, items: [
        { number: 645, title: 'What the operator sees, from the alarm to a healed agent', labels: ['wayfinder:prototype'], model: 'claude-opus-5', map: 641, mapTitle: 'Model credentials', unblocks: [] },
        { number: 646, title: 'Classify a failed refresh, cool the lane', labels: ['wayfinder:task'], model: 'gpt-5.6-sol', map: 641, mapTitle: 'Model credentials', unblocks: [] },
      ] },
    ],
  },
});

/* Three consumers, always all three. `unowned` is the honest word for the two
   the daemon does not broker yet, and the page must not be able to imply
   otherwise (dispatch.mjs:1768). */
const CLAUDE_UNOWNED = { consumer: 'claude', state: 'unowned', expires_at: null, why: 'the container reads it from its environment at create (#648)' };
const OVERSEER_UNOWNED = { consumer: 'overseer', state: 'unowned', expires_at: null, why: 'the container reads it from .env.overseer at create (#648)' };

const codex = (over) => ({
  consumer: 'codex', file: '/home/alp/curia-work/home/.codex/auth.json',
  state: 'valid', expires_at: p_ahead(60 * 24 * 7.4), why: '', last_refresh_at: p_at(60 * 60 * 62), last_error: null, ...over,
});

/* ---- the incident, as steps ------------------------------------------------
   Six stops between a quiet box and a healed one. Every one of them is a state
   the daemon can really be in; four of them are states nobody has looked at on
   a screen yet. */

var STEPS = [
  {
    key: 'quiet',
    name: 'Quiet',
    blurb: 'Nothing is wrong. The credential has 7.4 days left and the daemon refreshes it at 2.5 days without saying a word. The question here is whether the operator can find out when it expires WITHOUT an incident — and today they cannot: `valid` and `expiring` are silent on every surface.',
    credentials: { consumers: [codex(), CLAUDE_UNOWNED, OVERSEER_UNOWNED], reauth: null },
  },
  {
    key: 'dead',
    name: 'The alarm',
    blurb: 'The refresh was refused with `refresh_token_reused` — the real code #644 measured, in OpenAI\'s own error envelope. Terminal: no retry recovers it. The openai lane is cooled, two live codex agents are frozen mid-ticket holding their worktrees, and the operator is asleep.',
    overview: {
      agents: LIVE(17_400),
      dispatch_holds: [
        { ticket: '574', repo: 'alp82/curia', kind: 'stall-watchdog' },
        { ticket: '578', repo: 'alp82/curia', kind: 'stall-watchdog' },
      ],
      events: [
        { ts: p_at(90), type: 'credential_refresh_failed', consumer: 'codex', code: 'refresh_token_reused', status: 401, why: 'the refresh token was already spent' },
        { ts: p_at(600), type: 'agent_spawned', agent: 'curia-574', repo: 'alp82/curia', ticket: '574', model: 'gpt-5.6-sol', harness: 'codex' },
      ],
    },
    credentials: {
      consumers: [codex({
        state: 'expired', expires_at: p_at(60 * 60 * 5),
        why: 'the access token expired',
        last_error: 'the refresh was refused: refresh_token_reused (HTTP 401)',
      }), CLAUDE_UNOWNED, OVERSEER_UNOWNED],
      reauth: null,
    },
    discord: [{
      who: 'curia', ts: '06:38',
      body: '🔑 the `openai` model credential is **dead**. Its refresh was refused — `refresh_token_reused`, HTTP 401 — and that code is terminal, so nothing here retries.\n\nThe `openai` lane is cooled: no new codex agent is dispatched. **2 live codex agents are frozen** mid-ticket and keep their worktrees: `curia-574`, `curia-578`.\n\nSign it back in — no ssh: ' + DASH_URL + '/#credentials\nThe one-time code never appears in this channel.',
    }],
  },
  {
    key: 'waiting',
    name: 'Signing in',
    blurb: 'The operator pressed one button. A `curia-auth-openai` tmux session is running `codex login --device-auth` in a throwaway container, and curia scraped the link and the code off the pane. The code lives 15 minutes. Nothing is pasted back for codex.',
    overview: { agents: LIVE(17_700) },
    credentials: {
      consumers: [codex({ state: 'expired', expires_at: p_at(60 * 60 * 5), why: 'the access token expired', last_error: 'the refresh was refused: refresh_token_reused (HTTP 401)' }), CLAUDE_UNOWNED, OVERSEER_UNOWNED],
      reauth: {
        consumer: 'openai', session: 'curia-auth-openai', state: 'waiting',
        url: 'https://auth.openai.com/codex/device', code: 'F4KE-9QX2',
        started_at: p_at(70), expires_at: p_ahead(13.8), seconds_left: 828,
      },
    },
    discord: [{
      who: 'curia', ts: '06:41',
      body: '🔑 signing `openai` back in. Open the session and follow the two lines codex prints: a link, then a one-time code that lives fifteen minutes. Nothing is pasted back.\nThe code is on the dashboard too, and never in this channel.\nTerminal: ' + DASH_URL.replace(':8443', ':7681') + '/?arg=curia-auth-openai',
    }],
  },
  {
    key: 'blind',
    name: 'The scrape missed',
    blurb: 'Same flow, but codex changed its wording and the two regexes found nothing. This is the case the card exists to degrade into, and it must never dead-end: the terminal always works. Compare how loudly each variant admits it.',
    overview: { agents: LIVE(17_700) },
    credentials: {
      consumers: [codex({ state: 'expired', expires_at: p_at(60 * 60 * 5), why: 'the access token expired', last_error: 'the refresh was refused: refresh_token_reused (HTTP 401)' }), CLAUDE_UNOWNED, OVERSEER_UNOWNED],
      reauth: {
        consumer: 'openai', session: 'curia-auth-openai', state: 'waiting',
        url: null, code: null,
        started_at: p_at(70), expires_at: p_ahead(13.8), seconds_left: 828,
      },
    },
  },
  {
    key: 'healed',
    name: 'Healed',
    blurb: 'The login completed, the host store was written, and the same tick fanned the credential out to both frozen agents. #644 measured that a running codex process picks up a replaced auth.json with no restart — but it needs a nudge, because the turn that died left it idle at the composer.',
    overview: {
      agents: LIVE(20),
      events: [
        { ts: p_at(8), type: 'credential_adopted', consumer: 'codex', expires_at: p_ahead(60 * 24 * 10) },
        { ts: p_at(6), type: 'reauth_completed', consumer: 'openai', session: 'curia-auth-openai' },
      ],
    },
    credentials: {
      consumers: [codex({ state: 'valid', expires_at: p_ahead(60 * 24 * 10), last_refresh_at: p_at(8) }), CLAUDE_UNOWNED, OVERSEER_UNOWNED],
      reauth: null,
    },
    discord: [{
      who: 'curia', ts: '06:44',
      body: '✅ `openai` is authenticated again, and 2 live agent(s) hold the fresh credential: `curia-574`, `curia-578`.\nThe `openai` lane is uncooled. 2 tickets return to the frontier on the next tick.',
    }],
  },
  {
    key: 'timeout',
    name: 'Timed out',
    blurb: 'The operator fell back asleep. Thirty minutes passed, the device code died at fifteen, and the session was torn down and journalled. Nothing changed, and the box is exactly as broken as it was — which the page has to say without pretending anything happened.',
    overview: {
      agents: LIVE(19_800),
      dispatch_holds: [
        { ticket: '574', repo: 'alp82/curia', kind: 'stall-watchdog' },
        { ticket: '578', repo: 'alp82/curia', kind: 'stall-watchdog' },
      ],
      events: [{ ts: p_at(30), type: 'reauth_timeout', consumer: 'openai', session: 'curia-auth-openai' }],
    },
    credentials: {
      consumers: [codex({ state: 'expired', expires_at: p_at(60 * 60 * 5), why: 'the access token expired', last_error: 'the refresh was refused: refresh_token_reused (HTTP 401)' }), CLAUDE_UNOWNED, OVERSEER_UNOWNED],
      reauth: null,
    },
    discord: [{
      who: 'curia', ts: '07:14',
      body: '⚠️ the `openai` re-authentication ended as **timeout**. Nothing was changed. Type `reauth` to start another one.',
    }],
  },
];

/* The canned answer to `GET /api/overview`. `seconds_left` is recomputed on
   every read from the step's own start, so the countdown moves at the page's
   REAL cadence — one poll behind the pane, which is what #642 measured. */
function protoOverview() {
  const step = STEPS[PROTO.step];
  const o = { ...BASE(), ...(step.overview ?? {}) };
  o.credentials = JSON.parse(JSON.stringify(step.credentials));
  const r = o.credentials.reauth;
  if (r && r.state === 'waiting') {
    const elapsed = Math.floor((Date.now() - PROTO.stepStartedAt) / 1000);
    r.seconds_left = Math.max(0, 828 - elapsed);
  }
  return {
    poll_interval_s: 5,
    read_at: new Date().toISOString(),
    daemon_up: true,
    daemon_port: 4271,
    error: null,
    error_since: null,
    overview: o,
  };
}

/* Read-only prototype: every write answers plausibly and changes nothing but
   the step, which is the operator's own hand on the timeline. */
const PROTO_ROUTES = {
  '/api/overview': () => protoOverview(),
  /* The settings read must AGREE with `daemon.config` above, or the page draws
     its stale-daemon marker on every screen and the prototype ships a warning
     nobody asked about. `runningDiff` compares exactly these keys. */
  '/api/settings': () => {
    const c = BASE().daemon.config;
    return { dispatch: c.dispatch, watch: c.watch, routing: c.routing };
  },
  '/api/repos': () => ({ login: 'alp82', repos: [], error: null }),
  '/api/console': () => ({ conversations: [], error: null }),
  '/api/reauth': () => ({ ok: true, reply: 'Signing `openai` back in — the card below carries the link and the code.' }),
};

window.fetch = async (path, init) => {
  const key = String(path).split('?')[0];
  const body = PROTO_ROUTES[key] ? PROTO_ROUTES[key]() : { ok: true };
  return {
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};
