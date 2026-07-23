#!/usr/bin/env node
// Minimal MCP stdio server exposing two "ask the human" tools that use MCP
// elicitation — the same shape curia's daemon-hosted ask_human tools (#11)
// would take. The adapter forwards these as ACP `elicitation/create`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "curia-ask", version: "0.0.1" });

server.registerTool(
  "ask_choice",
  { description: "Ask the human to pick a color (choice elicitation). Returns their pick.", inputSchema: {} },
  async () => {
    const result = await server.server.elicitInput({
      message: "Which color do you prefer?",
      requestedSchema: {
        type: "object",
        properties: {
          color: { type: "string", title: "Color", oneOf: [
            { const: "red", title: "Red" },
            { const: "green", title: "Green" },
            { const: "blue", title: "Blue" },
          ] },
        },
        required: ["color"],
      },
    });
    return { content: [{ type: "text", text: `elicit result: ${JSON.stringify(result)}` }] };
  },
);

server.registerTool(
  "ask_freetext",
  { description: "Ask the human an open question (free-text elicitation). Returns their answer.", inputSchema: {} },
  async () => {
    const result = await server.server.elicitInput({
      message: "What is your favorite word?",
      requestedSchema: {
        type: "object",
        properties: { answer: { type: "string", title: "Your answer" } },
        required: ["answer"],
      },
    });
    return { content: [{ type: "text", text: `elicit result: ${JSON.stringify(result)}` }] };
  },
);

await server.connect(new StdioServerTransport());
