# D-wakeup-channel: Wake-up channel and payload

<!-- kizunasync:decision
id: D-wakeup-channel
status: open
-->

**Cites:** P:wake-up-and-poll-fallback, A:wake-up-and-realtime-a-hint-never-a-source-of-truth

## Question

Wake-ups are optional scheduling hints and pull remains authoritative. What portable channel name, event name, and payload bytes does a conformant server emit?

## What is not settled

The wire spelling. `wakeup/002-wakeup-payload` has no transcript and stays `file: null` with `blocked_on: ["D-wakeup-channel"]`.

## What is already safe to rely on

A missed hint changes only when the next pull starts. `wakeup/001-missed-wakeup-poll-converges` pins that correctness rule and contains no wake-up bytes.

The deployed SQL and the Supabase adapter use private `kizunasync:<table>` topics and event `changed`; the adapter discards the payload. That is current implementation behavior, not frozen compatibility bytes, so the deployed spelling does not unblock the manifest case.
