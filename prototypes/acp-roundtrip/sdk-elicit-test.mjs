#!/usr/bin/env node
// Isolation test: does the Claude Agent SDK's onElicitation fire at all for an
// MCP-server elicitation, bypassing the ACP adapter entirely?
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const q = query({
  prompt: "Call the ask_freetext tool from the curia-ask MCP server, then tell me in one sentence exactly what my answer was.",
  options: {
    cwd: path.join(__dirname, "workspace"),
    mcpServers: {
      "curia-ask": { command: process.execPath, args: [path.join(__dirname, "mcp-ask-server.mjs")] },
    },
    allowedTools: ["mcp__curia-ask__ask_freetext"],
    onElicitation: async (req) => {
      console.log(`[test] onElicitation FIRED: ${JSON.stringify(req)}`);
      return { action: "accept", content: { answer: "sdk-direct periwinkle" } };
    },
  },
});

for await (const msg of q) {
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text") console.log(`[assistant] ${block.text}`);
    }
  }
  if (msg.type === "result") console.log(`[result] ${msg.subtype}`);
}
