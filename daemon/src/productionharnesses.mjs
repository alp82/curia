// The Harnesses Curia ships as selectable production runtimes.
//
// Code that builds or validates the agent image derives its pins from this
// contract. Surfaces that can't import JavaScript, such as the Dockerfile and
// landing page, have consistency tests against the same names.

export const PRODUCTION_HARNESSES = Object.freeze({
  claude: Object.freeze({
    versionKey: 'claude_version',
    buildArg: 'CLAUDE_VERSION',
    package: '@anthropic-ai/claude-code',
  }),
  codex: Object.freeze({
    versionKey: 'codex_version',
    buildArg: 'CODEX_VERSION',
    package: '@openai/codex',
  }),
})

export const PRODUCTION_HARNESS_NAMES = Object.freeze(Object.keys(PRODUCTION_HARNESSES))
