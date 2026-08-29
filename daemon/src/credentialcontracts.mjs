// Names shared by credential validation and the Harness registry.
//
// This module stays free of credential readers and transcript consumers so
// both boundaries can validate their identities without an import cycle.

export const PROVIDER_NAMES = Object.freeze(['anthropic', 'openai'])
export const CONSUMER_NAMES = Object.freeze(['codex', 'claude', 'overseer'])
