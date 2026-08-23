/* PROTOTYPE — wayfinder #645. Appended INSIDE the real dashboard's own script,
   after its boot, so it can read `SCREENS`, `NAMES`, `UI`, `esc`, `clock` and
   `head` and reassign the page's own functions. Throwaway.

   THREE VARIANTS, and they disagree about structure, not about colour:

     A  Attention list   — no new surface. Cards at the top of Needs-you, the
                           way slice A1 shipped it, plus the two repairs it
                           left behind.
     B  Credentials tab  — a seventh screen, one row per consumer, one action
                           each. Needs-you keeps a one-line pointer into it.
     C  Takeover         — while a credential is dead or a login is running,
                           one full-bleed phone-first flow replaces the page.

   Everything else on this page is the real dashboard, drawing canned state. */

(function () {
  "use strict";

  const DASH = "https://coinmatica.taile1a2b.ts.net:8443";
  const TTYD = "https://coinmatica.taile1a2b.ts.net:7681";
  const termUrl = (session) => `${TTYD}/?arg=${session}`;

  const VARIANTS = {
    A: "Attention list — no new surface",
    B: "Credentials tab — a row per consumer",
    C: "Takeover — one flow, phone first",
  };
  const VKEYS = Object.keys(VARIANTS);

  /* ---- words ------------------------------------------------------------- */

  const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

  /* How long until a token dies, said the way an operator asks it. */
  function until(iso) {
    if (!iso) return "no stated expiry";
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms)) return "no stated expiry";
    if (ms <= 0) return "expired";
    const d = ms / 86_400_000;
    if (d >= 1) return `${d.toFixed(1)} days`;
    const h = ms / 3_600_000;
    if (h >= 1) return `${h.toFixed(1)} hours`;
    return `${Math.round(ms / 60_000)} min`;
  }

  /* The five states, and what each one means for the box. One vocabulary, used
     by all three variants, so a variant cannot win on wording alone. */
  const STATE = {
    valid: { tone: "ok", says: "healthy", act: null },
    expiring: { tone: "ok", says: "inside the last quarter of its life — the daemon refreshes it on a tick", act: null },
    expired: { tone: "bad", says: "dead: no agent on this lane can take a turn", act: "reauth" },
    unreadable: { tone: "bad", says: "on disk but unparseable — curia cannot judge its life", act: "reauth" },
    absent: { tone: "bad", says: "there is no credential file at all", act: "reauth" },
    unowned: { tone: "idle", says: "not brokered by the daemon — the container reads it at create", act: null },
  };
  const stateOf = (c) => STATE[c.state] ?? { tone: "idle", says: c.why ?? "", act: null };

  /* ---- the two repairs every variant needs ------------------------------- */

  /* THE COUNT IS WRONG TODAY (finding, #645). `needsYou` is the nav badge, the
     tab title and the Home tile, and it counts escalations, gates, GitHub token
     warnings and dispatch holds — and NOT a dead model credential. By its own
     stated test ("whether an operator act ends it") a dead model credential is
     the strongest member of that set: nothing rolls it on a clock, and it takes
     every agent on the lane with it. So the badge stays cold at 3am on the one
     failure that most needs it hot. All three variants count it. */
  const baseNeedsYou = needsYou;
  needsYou = function (o) {
    const creds = (o?.credentials?.consumers ?? []).filter((c) => stateOf(c).act || c.last_error).length;
    const flow = o?.credentials?.reauth?.state === "waiting" ? 1 : 0;
    return baseNeedsYou(o) + creds + flow;
  };

  /* ---- variant A — the attention list ------------------------------------ */

  /* Today's shape with its two gaps closed: the card carries the TERMINAL LINK
     (the path that always works, which the shipped card names but does not
     link), and a dead credential says which agents are frozen behind it. */
  function attCredential(c, o) {
    const s = stateOf(c);
    if (!s.act && !c.last_error) return [];
    const why = c.last_error ?? c.why ?? s.says;
    return [`<div class="att-item token">
      <span class="who">${esc(c.consumer)}</span>the model credential is ${esc(c.state)} — ${esc(s.says)}
      <div class="dim">${esc(why)}</div>
      <div class="dim">${esc(blast(c, o))}</div>
      <div style="margin-top:6px"><button class="p-btn p-go" onclick="PROTO_reauth()">Sign in from a browser</button></div>
    </div>`];
  }

  /* WHAT IS BROKEN BEHIND IT (finding, #645). A dead credential is not a fact
     about a file, it is a fact about the box: one lane stops dispatching and
     every live agent on it freezes mid-ticket. Nothing on the page says that
     today, and `pre_cooling` cannot: it is usage-shaped — a window, a percent
     and a reset instant — and a credential cool has none of the three. All
     three variants say it in their own voice; the wire needs a field. */
  function blast(c, o) {
    const lane = c.consumer === "codex" ? "openai" : c.consumer;
    const frozen = (o?.agents ?? []).filter((a) => (a.last_contact_s ?? 0) > 3600).map((a) => a.session);
    return `the ${lane} lane is cooled — no new agent is dispatched to it`
      + (frozen.length ? `, and ${frozen.length} live agents are frozen mid-ticket: ${frozen.join(", ")}` : "");
  }

  function attReauth(r) {
    if (!r || r.state !== "waiting") return [];
    const left = mmss(r.seconds_left ?? 0);
    const link = r.url
      ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>`
      : `<span class="dim">curia could not read the link off the pane</span>`;
    const code = r.code
      ? `<code class="p-code">${esc(r.code)}</code> <button class="p-btn" onclick="PROTO_copy('${esc(r.code)}')">copy</button>`
      : `<span class="dim">curia could not read the code off the pane</span>`;
    return [`<div class="att-item token">
      <span class="who">${esc(r.consumer)}</span>is signing in — open the link, then enter the code
      <div style="margin-top:6px">${link}</div>
      <div style="margin-top:4px">${code}</div>
      <div class="dim" style="margin-top:6px">${left} left on the code · session <code>${esc(r.session)}</code> ·
        <a href="${esc(termUrl(r.session))}" target="_blank" rel="noopener">open the terminal</a></div>
    </div>`];
  }

  /* ---- variant B — the Credentials screen -------------------------------- */

  function credRow(c) {
    const s = stateOf(c);
    const act = s.act
      ? `<button class="p-btn p-go" onclick="PROTO_reauth()">Sign in</button>`
      : c.state === "unowned"
        ? `<span class="p-dim">nothing to press until #648</span>`
        : `<span class="p-dim">nothing to do</span>`;
    /* The data-labels are what let the row restack as a card on a phone. A
       six-column table at 390px pushes the ACTION off the screen — the one
       press, on the one device, in the one state where it matters. */
    return `<tr>
      <td class="mono p-name"><b>${esc(c.consumer)}</b></td>
      <td data-label="state"><span class="p-chip p-${s.tone}">${esc(c.state)}</span></td>
      <td class="num" data-label="expires">${c.expires_at ? `${esc(until(c.expires_at))}<div class="p-dim">${esc(clock(c.expires_at))}</div>` : `<span class="p-dim">—</span>`}</td>
      <td class="num" data-label="last refresh">${c.last_refresh_at ? esc(clock(c.last_refresh_at)) : `<span class="p-dim">never</span>`}</td>
      <td data-label="why">${esc(c.last_error ?? c.why ?? s.says)}</td>
      <td class="p-act">${act}</td>
    </tr>`;
  }

  /* The live login, as a panel above the table rather than a row inside it: it
     is a FLOW with a clock on it, and a table row cannot carry a countdown, a
     copyable code and a fallback without becoming a panel anyway. */
  function credFlow(r) {
    if (!r || r.state !== "waiting") return "";
    const blind = !r.url || !r.code;
    return `<div class="p-flow ${blind ? "p-blind" : ""}">
      <div class="eyebrow">${esc(r.consumer)} · signing in · ${mmss(r.seconds_left ?? 0)} left on the code</div>
      ${blind
        ? `<h3 style="margin:8px 0">curia could not read the login off the pane</h3>
           <p class="p-dim" style="margin:0 0 10px">The wording changed, or the pane has not printed yet. The terminal always works.</p>`
        : `<div class="p-step"><span class="p-num">1</span><div>
             <div>Open the link</div>
             <a class="p-link" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>
           </div></div>
           <div class="p-step"><span class="p-num">2</span><div>
             <div>Enter this code</div>
             <div class="p-codewrap"><code class="p-code p-big">${esc(r.code)}</code>
               <button class="p-btn" onclick="PROTO_copy('${esc(r.code)}')">copy</button></div>
           </div></div>
           <div class="p-step"><span class="p-num">3</span><div>
             <div>Nothing is pasted back</div>
             <div class="p-dim">curia watches the scratch config dir and adopts the credential the moment it lands.</div>
           </div></div>`}
      <div class="p-fall">
        <a href="${esc(termUrl(r.session))}" target="_blank" rel="noopener">Open the terminal instead →</a>
        <span class="p-dim">session <code>${esc(r.session)}</code>, torn down after 30 min</span>
      </div>
    </div>`;
  }

  function screenCredentials(p) {
    const o = p?.overview;
    if (!o) return noSnapshot(p, "Credentials");
    const c = o.credentials ?? { consumers: [], reauth: null };
    const dead = (c.consumers ?? []).filter((x) => stateOf(x).act);
    return `${head(p, "Credentials")}
      ${dead.map((x) => `<div class="unread">${esc(blast(x, o))}</div>`).join("")}
      ${credFlow(c.reauth)}
      <div class="h-sect"><h3>Model credentials (${(c.consumers ?? []).length})</h3>
      <table class="p-table"><thead><tr>
        <th>consumer</th><th>state</th><th>expires</th><th>last refresh</th><th>why</th><th></th>
      </tr></thead><tbody>${(c.consumers ?? []).map(credRow).join("")}</tbody></table>
      <p class="p-dim" style="margin-top:10px">Subscription credentials only. Curia holds no API key and this page offers no field for one.</p>
      </div>`;
  }

  /* ---- variant C — the takeover ------------------------------------------ */

  /* The page's own comment says it: while a login is up, nothing else on the
     box matters as much. C takes that literally. It is sized for a phone at 3am
     first and a desktop second, and it is always dismissible — a takeover that
     traps the operator is worse than the card it replaced. */
  function takeover(o) {
    if (PROTO.dismissed) return "";
    const c = o?.credentials ?? {};
    const r = c.reauth;
    const dead = (c.consumers ?? []).find((x) => stateOf(x).act);
    if (!r && !dead) return "";
    const body = r && r.state === "waiting" ? takeWaiting(r) : takeDead(dead, o);
    return `<div class="p-over"><div class="p-sheet">
      <button class="p-x" onclick="PROTO_dismiss()" title="not now">✕</button>
      ${body}
    </div></div>`;
  }

  function takeDead(c, o) {
    const frozen = (o?.dispatch_holds ?? []).map((h) => h.ticket);
    return `<div class="p-kicker p-bad">${esc(c.consumer)} · the model credential is ${esc(c.state)}</div>
      <h2 class="p-h">Curia cannot take a turn on this lane.</h2>
      <p class="p-lead">${esc(c.last_error ?? c.why ?? "")}</p>
      <ul class="p-facts">
        <li>The <code>${esc(c.consumer === "codex" ? "openai" : c.consumer)}</code> lane is cooled — no new agent is dispatched to it.</li>
        <li>${frozen.length
          ? `<b>${frozen.length} live agents are frozen</b> mid-ticket and keep their worktrees: ${frozen.map((t) => `<code>#${esc(t)}</code>`).join(", ")}.`
          : "No live agent is waiting on it."}</li>
        <li>Signing in heals them in place. Nothing is lost and nothing restarts.</li>
      </ul>
      <button class="p-huge" onclick="PROTO_reauth()">Sign in from this phone</button>
      <div class="p-fall"><a href="${esc(termUrl("curia-auth-openai"))}" target="_blank" rel="noopener">Open a terminal instead →</a></div>`;
  }

  function takeWaiting(r) {
    const blind = !r.url || !r.code;
    return `<div class="p-kicker">${esc(r.consumer)} · signing in</div>
      <div class="p-clock ${(r.seconds_left ?? 0) < 180 ? "p-bad" : ""}">${mmss(r.seconds_left ?? 0)}<span> left on the code</span></div>
      ${blind
        ? `<h2 class="p-h">curia could not read the login off the pane.</h2>
           <p class="p-lead">The link and the code are a guess about somebody else's wording, and this time the guess missed. The terminal always works.</p>
           <a class="p-huge p-huge-a" href="${esc(termUrl(r.session))}" target="_blank" rel="noopener">Open the terminal</a>`
        : `<h2 class="p-h">Two taps.</h2>
           <a class="p-huge p-huge-a" href="${esc(r.url)}" target="_blank" rel="noopener">1 · Open ${esc(r.url.replace("https://", ""))}</a>
           <div class="p-codebox" onclick="PROTO_copy('${esc(r.code)}')">
             <div class="p-dim">2 · enter this code — tap to copy</div>
             <div class="p-codehuge">${esc(r.code)}</div>
           </div>
           <p class="p-lead">Nothing is pasted back here. Curia adopts the credential the moment it lands and heals every frozen agent on the same tick.</p>
           <div class="p-fall"><a href="${esc(termUrl(r.session))}" target="_blank" rel="noopener">Open the terminal instead →</a></div>`}`;
  }

  /* ---- installing a variant ---------------------------------------------- */

  const TAB = "credentials";

  function install(v) {
    /* the tab, added and removed rather than hidden — a nav item is structure */
    const i = NAMES.indexOf(TAB);
    if (v === "B" && i < 0) {
      SCREENS[TAB] = ["Credentials", screenCredentials];
      NAMES.splice(NAMES.indexOf("feed") + 1, 0, TAB);
    } else if (v !== "B" && i >= 0) {
      NAMES.splice(i, 1);
      delete SCREENS[TAB];
      if (UI.screen === TAB) UI.screen = "home";
    }

    attentionList = function (o) {
      const c = o?.credentials ?? {};
      let cred = [];
      if (v === "A") {
        cred = [...attReauth(c.reauth), ...(c.consumers ?? []).flatMap((x) => attCredential(x, o))];
      } else if (v === "B") {
        /* One line, not a card: the detail lives on the screen that owns it, and
           saying it twice is how two surfaces drift apart. */
        const bad = (c.consumers ?? []).filter((x) => stateOf(x).act);
        const flow = c.reauth?.state === "waiting";
        if (flow) {
          cred = [`<div class="att-item token"><span class="who">${esc(c.reauth.consumer)}</span>is signing in — the link and the code are on
            <a href="#credentials" onclick="goto('credentials')">Credentials</a> (${mmss(c.reauth.seconds_left ?? 0)} left)</div>`];
        } else if (bad.length) {
          cred = [`<div class="att-item token"><span class="who">${esc(bad.map((x) => x.consumer).join(", "))}</span>the model credential is ${esc(bad[0].state)} —
            <a href="#credentials" onclick="goto('credentials')">open Credentials</a> to sign in</div>`];
        }
      } else {
        /* C: the takeover carries it. What stays here is the trail back, for the
           operator who dismissed the sheet and now has to find it again. */
        const bad = (c.consumers ?? []).filter((x) => stateOf(x).act);
        const flow = c.reauth?.state === "waiting";
        if (flow || bad.length) {
          cred = [`<div class="att-item token"><span class="who">${esc(flow ? c.reauth.consumer : bad[0].consumer)}</span>${
            flow ? "is signing in" : `the model credential is ${esc(bad[0].state)}`} —
            <a href="#" onclick="PROTO_undismiss();return false">reopen</a></div>`];
        }
      }
      const rest = [
        ...(o.escalations ?? []).map(escCard),
        ...(o.review_gate ?? []).map(gateCard),
        ...(o.token_warnings ?? []).map(tokenCard),
        ...spentWindows(o.usage).map((w) => `<div class="att-item limit">
          <span class="who">${esc(w.provider)}</span>the ${esc(w.label)} window is spent at ${esc(w.pct)}%
          <div class="dim">${w.at ? `it rolls at ${esc(clock(w.at))}` : "no reset instant is stated"}</div></div>`),
        ...(o.dispatch_holds ?? []).map(dispatchHoldCard),
      ];
      const items = [...cred, ...rest];
      return { count: items.length, html: items.length ? items.join("") : `<div class="empty">Nothing wants you.</div>` };
    };
  }

  /* ---- the prototype's own chrome ---------------------------------------- */

  function chrome() {
    const step = STEPS[PROTO.step];
    const o = payload?.overview;
    const msgs = STEPS.slice(0, PROTO.step + 1).flatMap((s) => s.discord ?? []);
    return `
      <div class="p-banner">
        <b>PROTOTYPE</b> · wayfinder #645 · canned state, no daemon ·
        variant <b>${PROTO.variant}</b> — ${esc(VARIANTS[PROTO.variant])}
      </div>
      <div class="p-rail">
        <div class="p-railsec">
          <div class="eyebrow">The incident</div>
          <div class="p-steps">${STEPS.map((s, i) => `<button class="p-btn ${i === PROTO.step ? "on" : ""}" onclick="PROTO_go(${i})">${i + 1}. ${esc(s.name)}</button>`).join("")}</div>
          <p class="p-blurb">${esc(step.blurb)}</p>
        </div>
        <div class="p-railsec">
          <div class="eyebrow">Discord — #curia</div>
          ${msgs.length
            ? msgs.map((m) => `<div class="p-msg"><div class="p-msghead"><b>${esc(m.who)}</b> <span class="p-dim">${esc(m.ts)}</span></div>
                <div class="p-msgbody">${discordish(m.body)}</div></div>`).join("")
            : `<div class="p-dim">Nothing has been said. A healthy credential is silent everywhere.</div>`}
        </div>
      </div>
      <div class="p-bar">
        <button class="p-btn" onclick="PROTO_v(-1)" title="previous variant">◀</button>
        <span class="p-vlabel"><b>${PROTO.variant}</b> — ${esc(VARIANTS[PROTO.variant])}</span>
        <button class="p-btn" onclick="PROTO_v(1)" title="next variant">▶</button>
        <span class="p-sep"></span>
        <button class="p-btn ${PROTO.phone ? "on" : ""}" onclick="PROTO_phone()">📱 phone</button>
        <span class="p-sep"></span>
        <button class="p-btn" onclick="PROTO_go(${Math.max(0, PROTO.step - 1)})">, prev</button>
        <span class="p-vlabel p-dim">step ${PROTO.step + 1}/${STEPS.length}</span>
        <button class="p-btn" onclick="PROTO_go(${Math.min(STEPS.length - 1, PROTO.step + 1)})">next .</button>
      </div>
      ${PROTO.variant === "C" ? takeover(o) : ""}`;
  }

  /* Discord renders a small subset of markdown. Enough of it to judge the copy. */
  function discordish(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>')
      .replace(/\n/g, "<br>");
  }

  /* ---- wiring ------------------------------------------------------------ */

  const baseRender = render;
  render = function () {
    baseRender();
    let host = document.getElementById("p-chrome");
    if (!host) {
      host = document.createElement("div");
      host.id = "p-chrome";
      document.body.appendChild(host);
    }
    host.innerHTML = chrome();
    document.documentElement.dataset.phone = PROTO.phone ? "1" : "";
  };

  /* The variant, the step and the phone frame all ride the URL — replaceState
     rather than pushState, so flipping through variants does not bury the back
     button under twenty entries. */
  function stamp() {
    const q = new URLSearchParams(location.search);
    q.set("variant", PROTO.variant);
    q.set("step", String(PROTO.step));
    if (PROTO.phone) q.set("phone", "1"); else q.delete("phone");
    history.replaceState(null, "", `${location.pathname}?${q}${location.hash}`);
  }

  window.PROTO_go = (i) => {
    PROTO.step = Math.max(0, Math.min(STEPS.length - 1, i));
    PROTO.stepStartedAt = Date.now();
    PROTO.dismissed = false;
    stamp();
    tick();
  };
  window.PROTO_v = (d) => {
    PROTO.variant = VKEYS[(VKEYS.indexOf(PROTO.variant) + d + VKEYS.length) % VKEYS.length];
    PROTO.dismissed = false;
    install(PROTO.variant);
    stamp();
    render();
  };
  window.PROTO_phone = () => { PROTO.phone = !PROTO.phone; stamp(); render(); };
  window.PROTO_dismiss = () => { PROTO.dismissed = true; render(); };
  window.PROTO_undismiss = () => { PROTO.dismissed = false; render(); };
  window.PROTO_copy = (code) => {
    navigator.clipboard?.writeText(code);
    UI.act.said = { key: "proto-copy", text: `copied ${code}`, ok: true };
    render();
  };
  /* The one write in the whole prototype, and it writes nothing: it walks the
     story forward, which is what the operator's press would really do. */
  window.PROTO_reauth = () => PROTO_go(2);

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); PROTO_v(-1); }
    if (e.key === "ArrowRight") { e.preventDefault(); PROTO_v(1); }
    if (e.key === ",") PROTO_go(PROTO.step - 1);
    if (e.key === ".") PROTO_go(PROTO.step + 1);
  });

  if (!VKEYS.includes(PROTO.variant)) PROTO.variant = "A";
  PROTO.step = Math.max(0, Math.min(STEPS.length - 1, PROTO.step));
  install(PROTO.variant);
  /* The page booted before this script added the Credentials tab, so a
     `#credentials` hash — which is exactly what the Discord alarm links to —
     fell back to Home. Re-apply it now that the tab exists. */
  const hash = location.hash.slice(1);
  if (NAMES.includes(hash) && hash !== UI.screen) enter(hash);
  render();
})();
