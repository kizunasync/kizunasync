---- MODULE prop_001_cursor_monotonic ----
\* prop-001 cursor monotonicity (cites P:keyset-pagination-and-delivery-bound, P:cursor-monotonicity-rebase-and-atomic-checkpoints; D-cursor-opaque-token; fencing: shared).
\* Model: one client polling a monotonically-growing server log. The server
\* assigns strictly increasing seq values (P:keyset-pagination-and-delivery-bound). A pull returns a cursor =
\* the highest seq it has served so far. The client persists the cursor only
\* AFTER a durable apply (P:cursor-monotonicity-rebase-and-atomic-checkpoints token-after-durable-apply): persistedCursor
\* moves to lastCursor at a has_more:false boundary, modelled by the Persist
\* action. Abstraction: seq is an integer (D-cursor-opaque-token decimal-string BigInt
\* compare collapses to integer order); pages are abstracted to single pulls.
EXTENDS Naturals

CONSTANT MaxSeq            \* bound: highest seq the server ever commits

VARIABLES
  serverHigh,             \* highest seq committed on the server so far
  lastCursor,             \* cursor returned by the most recent pull
  persistedCursor         \* durably checkpointed cursor on the client

vars == << serverHigh, lastCursor, persistedCursor >>

Init ==
  /\ serverHigh = 0
  /\ lastCursor = 0
  /\ persistedCursor = 0

\* Server commits the next change (P:keyset-pagination-and-delivery-bound: seq strictly increases).
Commit ==
  /\ serverHigh < MaxSeq
  /\ serverHigh' = serverHigh + 1
  /\ UNCHANGED << lastCursor, persistedCursor >>

\* A pull serves up to serverHigh; its returned cursor is serverHigh
\* (never below the previous cursor, the property under test).
Pull ==
  /\ lastCursor' = serverHigh
  /\ UNCHANGED << serverHigh, persistedCursor >>

\* Durable apply at has_more:false: persist the cursor we just pulled (P:cursor-monotonicity-rebase-and-atomic-checkpoints).
\* Enabling guard persistedCursor < lastCursor models the real has_more:false
\* trigger: Persist only fires when there is something new to persist, which
\* also stops it from generating self-loop stutter states.
Persist ==
  /\ persistedCursor < lastCursor
  /\ persistedCursor' = lastCursor
  /\ UNCHANGED << serverHigh, lastCursor >>

Next == Commit \/ Pull \/ Persist

Spec == Init /\ [][Next]_vars

\* TypeOK keeps the state space finite and documents the bound.
TypeOK ==
  /\ serverHigh \in 0..MaxSeq
  /\ lastCursor \in 0..MaxSeq
  /\ persistedCursor \in 0..MaxSeq

\* The invariant: the durable cursor never exceeds what was pulled, and the
\* pulled cursor never exceeds the committed high-water mark. Because Pull
\* sets lastCursor := serverHigh and serverHigh only grows, lastCursor and
\* persistedCursor are monotone non-decreasing across the trace. We encode
\* monotonicity as the ordering guard that no action can ever invert:
\*
\* ── On the nature of this abstraction (READ THIS BEFORE COPYING THIS MODULE) ──
\* This is a POSITIVE abstraction. Pull always assigns lastCursor := serverHigh,
\* and serverHigh only ever grows (Commit increments, no decrement action), so
\* BY CONSTRUCTION no action in Next can decrease a cursor. The transition
\* relation makes a violating state UNREACHABLE rather than merely unobserved.
\* TLC's role here is therefore to WITNESS that the modelled protocol is monotone
\* under every interleaving of Commit/Pull/Persist, it confirms the construction,
\* it does not hunt for an expressible counterexample (none can exist in this
\* model). Equivalently: passing this check tells you the *model* is monotone;
\* it tells you nothing about a bug the model cannot express.
\*
\* WARNING for authors copying this module's shape: a positive abstraction is the
\* RIGHT shape only for a property the protocol upholds by construction. For
\* ADVERSARIAL / safety-under-fault properties: retry with a stale checkpoint,
\* out-of-order or duplicated apply, resurrection of a deleted row, and for the
\* liveness props 002 (no-lost-committed-change), 004 (session-guarantees), and
\* 006 (no-resurrection), the module MUST include a nondeterministic action that
\* COULD drive the system into a violating state (e.g. a Persist that writes a
\* stale cursor, or a Pull that can return below lastCursor). Only then does TLC
\* actively search for and either rule out or surface a real violation. If you
\* copy this positive shape into an adversarial prop, TLC will report green
\* having checked nothing, a false sense of safety.
Monotonic ==
  /\ persistedCursor <= lastCursor
  /\ lastCursor <= serverHigh
====
