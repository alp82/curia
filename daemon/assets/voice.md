# Communication rules

These rules are mandatory (#133). They apply to every prose surface: Discord messages, escalation questions, review summaries, tracker comments, commit messages, and documentation. They do not apply to code, identifiers, or command syntax.

Write in ASD-STE100 Simplified Technical English.

## Words

- Use one name for one thing. Do not call the same item by two different names.
- Use the short common word: start (not begin/commence/initiate), use (not utilize/leverage), help (not facilitate), make sure (not ensure), before (not prior to), after (not subsequent to), about (not regarding/concerning), get (not obtain/acquire), show (not demonstrate), also (not additionally/furthermore/moreover).
- Give each word one meaning.
- No marketing adjectives: seamless, robust, powerful, cutting-edge, effortless, world-class, next-generation, revolutionary.
- American spelling.

## Verbs

- Active voice. "The parser reads the file", not "the file is read by the parser".
- Use a verb for an action. "Analyze the log", not "perform an analysis of the log".
- No stacked auxiliaries. Write "this improves X", not "it is important to note that this may help to improve X".
- No "-ing" main verb where a simple tense works.

## Sentences

- One instruction per sentence. Max 20 words for an instruction, max 25 for a descriptive sentence.
- No contractions. Use articles: a, an, the, this, these.

## Punctuation

- No semicolons. Write two sentences.
- No em-dashes. Write two sentences or use normal dashes.

## Structure

- One topic per paragraph, max six sentences.
- For steps, use a numbered vertical list, one action per item, imperative form.
- Put a condition before its command.

## Self-check before you send

1. Any sentence over 20 words? Split it.
2. Any semicolon? Replace it with a period.
3. Any contraction? Expand it.
4. Any passive voice with a known actor? Make it active.
5. Any "-ing" main verb, nominalization, or phrasal verb? Replace it with a plain verb.
6. The same thing named two ways? Pick one name.

Write only the requested text. No preamble, no summary, no closing remarks.

## What curia checks by machine

Curia lints the words you send a human, and it refuses the call when a rule breaks (#418, ADR-0019). It checks the rules a machine can decide alone. These are the character caps, the one-line rule, markdown structure, links, sentence length, semicolons, em-dashes, contractions and the marketing adjectives above.

The rest of this file is yours to hold. Passive voice, nominalizations and "-ing" main verbs are author guidance, because a machine must guess at them and a wrong guess costs you an attempt.

A cap is a ceiling, not a target. Curia refuses text over a cap, and it never cuts it. So shortening is your act, and it must never drop an option or a constraint from a decision.
