# Communication rules

These rules are mandatory (#133). They apply to every prose surface: Discord messages, escalation questions, review summaries, tracker comments, commit messages, and documentation. They do not apply to code, identifiers, or command syntax.

Write in the style of the Google developer documentation style guide (https://developers.google.com/style). The rules are strong defaults, not laws. Break one when following it would produce something awkward or unclear.

## Voice and tone

- Be conversational, friendly, and respectful, like a knowledgeable colleague. Don't be frivolous, cute, or wacky.
- Use contractions (don't, can't, it's). They read as a natural voice.
- Be direct. The operator is in a hurry. Cut filler like "please note", "at this time", or "it is important to note that".
- Don't say "simply", "easy", or "just" in instructions.
- Don't overuse "please". Skip exclamation marks.
- No buzzwords, marketing language, internet slang, or pop-culture references. These marketing adjectives are banned outright: seamless, robust, powerful, cutting-edge, effortless, world-class, next-generation, revolutionary.

## Person and voice

- Address the operator as "you". Use the imperative for instructions.
- Use third person for what the software does.
- Prefer active voice, and say who performs each action. Passive is fine when the actor is unknown or irrelevant.
- Use present tense.

## Sentences

- Put the condition, circumstance, or goal before the instruction. "To cancel the run, press the button."
- Keep sentences under 25 words. Keep the subject and verb near the start, in subject-verb-object order.
- Put the key information in the first sentence of a paragraph or list item.
- Avoid double negatives and nested exceptions.

## Words

- Use the simple word: start (not commence), use (not utilize or leverage), some (not a number of).
- Use one exact term for one concept, with the same capitalization, everywhere.
- Define an acronym on first use.
- Avoid idioms, metaphors, and humor.
- Repeat a noun rather than leave an ambiguous pronoun. Write "the `config.yaml` file", not "it".
- At most two nouns modifying another noun. Keep a modifier next to what it modifies.
- Use American spelling. Write an unambiguous date: August 19, 2026, not 8/19/26.

## Punctuation and structure

- No semicolons. Write two sentences.
- No em-dashes. Write two sentences, use a comma, or use a spaced hyphen.
- Use serial commas. Don't write "&" for "and".
- One topic per paragraph, max six sentences.
- For steps, use a numbered list, one action per item, imperative form. Use parallel structure across items.
- Put code, filenames, commands, and API names in code font.
- Write link text that describes the target. Never write "click here".
- Avoid directional language ("above", "below"). Write "preceding", "following", or name the thing.

## Self-check before you send

1. Any sentence over 25 words? Split it.
2. Any semicolon? Replace it with a period.
3. Any em-dash? Write two sentences.
4. Any marketing adjective or buzzword? Cut it.
5. Any passive voice with a known actor? Make it active.
6. The same thing named two ways? Pick one name.

Write only the requested text. No preamble, no summary, no closing remarks.

## What curia checks by machine

Curia lints the words you send a human, and it refuses the call when a rule breaks (#418, ADR-0019). It checks the rules a machine can decide alone. These are the character caps, the one-line rule, markdown structure, links, sentence length, semicolons, em-dashes and the marketing adjectives above.

The rest of this file is yours to hold. Passive voice, nominalizations, and word choice are author guidance, because a machine must guess at them and a wrong guess costs you an attempt.

A cap is a ceiling, not a target. Curia refuses text over a cap, and it never cuts it. So shortening is your act, and it must never drop an option or a constraint from a decision.
