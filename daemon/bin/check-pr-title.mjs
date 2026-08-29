#!/usr/bin/env node

import { releaseTitleHelp, validReleasePullRequestTitle } from '../src/pullrequesttitle.mjs'

const title = process.env.PR_TITLE ?? process.argv[2] ?? ''
if (validReleasePullRequestTitle(title)) {
  console.log(`valid release title: ${title}`)
} else {
  console.error(`invalid pull request title: ${title || '(empty)'}`)
  console.error(releaseTitleHelp())
  process.exitCode = 1
}
