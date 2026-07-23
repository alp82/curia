#!/usr/bin/env node
// ACP round-trip verification spike (wayfinder #23).
// Drives @agentclientprotocol/claude-agent-acp standalone over stdio from a
// minimal ACP client built on @agentclientprotocol/sdk.
//
// Scenarios:
//   node spike.mjs basic       — initialize + session/new + one prompt turn
//   node spike.mjs permission  — session/request_permission round-trip (delayed answer)
//   node spike.mjs elicit      — unstable elicitation/create: choice answer
//   node spike.mjs elicit-free — unstable elicitation/create: free-text ("Other") answer
//   node spike.mjs image       — human→agent image in prompt; watch updates for agent→human images
//   node spike.mjs steer       — _session/steering mid-turn injection
//
// Full wire traffic is logged to logs/<scenario>.ndjson (>> = client→agent, << = agent→client).

import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import * as acp from "@agentclientprotocol/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenario = process.argv[2] ?? "basic";
const logsDir = path.join(__dirname, "logs");
const workspace = path.join(__dirname, "workspace");
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
const logPath = path.join(logsDir, `${scenario}.ndjson`);
fs.writeFileSync(logPath, "");

const say = (msg) => console.log(`[spike] ${msg}`);
const wire = (dir, line) => fs.appendFileSync(logPath, `${dir} ${line}\n`);

// --- tiny PNG encoder (solid-color RGB), no deps ---------------------------
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (const b of buf) c = (c >>> 8) ^ table[(c ^ b) & 0xff];
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- wire-logging stream wrappers ------------------------------------------
function logLines(dir) {
  let buf = "";
  return (chunkBytes) => {
    buf += Buffer.from(chunkBytes).toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) wire(dir, line);
    }
  };
}
function teeReadable(webReadable, dir) {
  const log = logLines(dir);
  return webReadable.pipeThrough(
    new TransformStream({
      transform(c, ctrl) { log(c); ctrl.enqueue(c); },
    }),
  );
}
function teeWritable(webWritable, dir) {
  const log = logLines(dir);
  const t = new TransformStream({
    transform(c, ctrl) { log(c); ctrl.enqueue(c); },
  });
  t.readable.pipeTo(webWritable).catch(() => {});
  return t.writable;
}

// --- spawn the adapter ------------------------------------------------------
const adapterBin = path.join(__dirname, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
const child = spawn("node", [adapterBin], {
  cwd: workspace,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});
child.stderr.on("data", (d) => fs.appendFileSync(logPath, `!! ${d.toString().trimEnd()}\n`));
const stream = acp.ndJsonStream(
  teeWritable(Writable.toWeb(child.stdin), ">>"),
  teeReadable(Readable.toWeb(child.stdout), "<<"),
);

// --- shared client behavior -------------------------------------------------
const results = { updates: [], imagesFromAgent: [], permissionRequests: [], elicitations: [] };
const HUMAN_DELAY_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function onPermission(params) {
  results.permissionRequests.push(params);
  say(`PERMISSION REQUESTED: tool="${params.toolCall?.title}" options=${JSON.stringify(params.options.map((o) => `${o.optionId}/${o.kind}`))}`);
  say(`  ... simulating a slow human (${HUMAN_DELAY_MS} ms) ...`);
  await sleep(HUMAN_DELAY_MS);
  const allow = params.options.find((o) => o.kind === "allow_once") ?? params.options[0];
  say(`  answering with optionId=${allow.optionId} (${allow.kind})`);
  return { outcome: { outcome: "selected", optionId: allow.optionId } };
}

async function onElicitation(params) {
  results.elicitations.push(params);
  say(`ELICITATION (mode=${params.mode}): "${params.message}"`);
  say(`  schema: ${JSON.stringify(params.requestedSchema)}`);
  await sleep(1000);
  const props = params.requestedSchema?.properties ?? {};
  const answer = {};
  for (const [key, prop] of Object.entries(props)) {
    const options = prop?.oneOf ?? prop?.items?.anyOf;
    if (scenario === "elicit-free" || !options) {
      if (prop?.type === "string" && !options) answer[key] = "a completely custom free-text answer: periwinkle";
    } else {
      const pick = options[1] ?? options[0];
      answer[key] = pick?.const;
      break;
    }
  }
  say(`  answering: ${JSON.stringify(answer)}`);
  return { action: "accept", content: answer };
}

function recordUpdate(params) {
  const u = params.update;
  results.updates.push(u);
  const contentBlocks = [];
  if (u.content) contentBlocks.push(u.content);
  if (Array.isArray(u.content)) contentBlocks.push(...u.content);
  for (const c of contentBlocks) {
    const inner = c?.content ?? c; // ToolCallContent wraps a ContentBlock
    if (inner?.type === "image") {
      results.imagesFromAgent.push({ via: u.sessionUpdate, mimeType: inner.mimeType, bytes: inner.data?.length });
      say(`AGENT→HUMAN IMAGE via ${u.sessionUpdate}: ${inner.mimeType}, base64 len ${inner.data?.length}`);
    }
  }
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      if (u.content?.type === "text") process.stdout.write(u.content.text);
      else say(`agent_message_chunk [${u.content?.type}]`);
      break;
    case "tool_call":
      say(`tool_call: ${u.title} (${u.status})`);
      break;
    case "tool_call_update":
      say(`tool_call_update: ${u.toolCallId} → ${u.status}`);
      break;
    default:
      break;
  }
}

// --- scenarios --------------------------------------------------------------
const prompts = {
  basic: "Reply with exactly: ACP_ROUNDTRIP_OK",
  permission: "Use the Bash tool to run this exact command: sha256sum perm-proof.txt > perm-hash.txt — then confirm what you did in one sentence.",
  elicit: "Call the ask_choice tool from the curia-ask MCP server, then tell me in one sentence which color I picked.",
  "elicit-free": "Call the ask_freetext tool from the curia-ask MCP server, then tell me in one sentence exactly what my answer was.",
  image: null, // built below
  tools: "List the names of every tool you have available in this session, one per line, nothing else.",
  askuser: "Use your AskUserQuestion tool to ask me which color I prefer, with the options red, green, and blue. Then tell me which one I picked in one sentence.",
  steer: "Write one short haiku about each month of the year, January through December, in order. Number each one.",
};

const run = async () => {
  const t0 = Date.now();
  return acp
    .client({ name: "curia-acp-spike" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => onPermission(ctx.params))
    .onRequest(acp.methods.client.elicitation.create, (ctx) => onElicitation(ctx.params))
    .connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          // Unstable feature opt-in: adapter only sends elicitation/create if this is set.
          // NOTE: form/url are OBJECT capabilities ({}), not booleans — a boolean fails
          // the SDK's lenient zod parse and silently degrades to "unsupported".
          elicitation: { form: {} },
        },
      });
      say(`initialized: protocol v${init.protocolVersion}, steering=${JSON.stringify(init._meta?.steering)}`);
      say(`agentCapabilities: ${JSON.stringify(init.agentCapabilities)}`);

      const sessionRequest = scenario.startsWith("elicit")
        ? {
            cwd: workspace,
            mcpServers: [{ name: "curia-ask", command: process.execPath, args: [path.join(__dirname, "mcp-ask-server.mjs")], env: [] }],
          }
        : workspace;
      return ctx.buildSession(sessionRequest).withSession(async (session) => {
        say(`session: ${session.sessionId} (cwd=${workspace})  [+${Date.now() - t0} ms]`);

        if (scenario === "permission" || scenario.startsWith("elicit")) {
          // The adapter inherits the host's saved permission mode (acceptEdits here);
          // force Manual so dangerous tools actually prompt.
          await ctx.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId: "default" });
          say(`session mode forced to "default"`);
        }

        let promptContent;
        if (scenario === "image") {
          const png = solidPng(64, 64, [255, 0, 0]);
          fs.writeFileSync(path.join(workspace, "mystery.png"), png);
          promptContent = [
            { type: "text", text: "Here is an image. What solid color is it? Answer with just the color name. Then, to test the return path, use your Read tool to read the file mystery.png in your working directory." },
            { type: "image", mimeType: "image/png", data: png.toString("base64") },
          ];
        } else {
          promptContent = prompts[scenario];
          if (!promptContent) throw new Error(`unknown scenario: ${scenario}`);
        }

        say(`prompting...`);
        session.prompt(promptContent);

        let steered = false;
        for (;;) {
          const msg = await session.nextUpdate();
          if (msg.kind === "stop") {
            say(`\nturn finished: stopReason=${msg.response.stopReason}  [+${Date.now() - t0} ms]`);
            if (scenario === "steer") {
              // The steered message's own output streams via session/update after
              // the interrupted turn's PromptResponse — keep listening briefly.
              say(`listening 20 s for post-turn steered output...`);
              const deadline = Date.now() + 20000;
              while (Date.now() < deadline) {
                const extra = await Promise.race([session.nextUpdate().catch(() => null), sleep(deadline - Date.now()).then(() => null)]);
                if (!extra || extra.kind === "stop") continue;
                recordUpdate(extra.notification.params ?? extra.notification);
              }
            }
            return msg.response;
          }
          recordUpdate(msg.notification.params ?? msg.notification);
          if (scenario === "steer" && !steered && results.updates.filter((u) => u.sessionUpdate === "agent_message_chunk").length > 5) {
            steered = true;
            say(`\n--- sending _session/steering mid-turn ---`);
            const out = await ctx.request("_session/steering", {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "STOP writing haikus immediately. Instead reply with exactly: STEERED_OK and end your turn." }],
            });
            say(`steering outcome: ${JSON.stringify(out)}`);
          }
        }
      });
    });
};

try {
  const resp = await run();
  say(`--- SUMMARY (${scenario}) ---`);
  say(`stopReason: ${resp.stopReason}`);
  say(`permission requests: ${results.permissionRequests.length}`);
  say(`elicitations: ${results.elicitations.length}`);
  say(`agent→human images: ${JSON.stringify(results.imagesFromAgent)}`);
  if (scenario === "permission") {
    const proof = path.join(workspace, "perm-proof.txt");
    say(`perm-proof.txt exists: ${fs.existsSync(proof)}${fs.existsSync(proof) ? ` content=${JSON.stringify(fs.readFileSync(proof, "utf8"))}` : ""}`);
  }
} catch (e) {
  say(`ERROR: ${e?.stack ?? e}`);
  process.exitCode = 1;
} finally {
  child.kill();
}
