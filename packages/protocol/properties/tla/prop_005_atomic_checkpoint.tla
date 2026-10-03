---- MODULE prop_005_atomic_checkpoint ----
\* prop-005 atomic checkpoint application
\* (cites P:session-guarantees-and-exactly-once-effect, P:cursor-monotonicity-rebase-and-atomic-checkpoints; D-page-cap-and-checkpoint-boundary; fencing: shared).
\* Model: a multi-page pull (Pages pages). The client STAGES each page into a
\* shadow area; the observable state and the persisted cursor advance ONLY at
\* the durable atomic apply on the has_more:false boundary. A fault (transport
\* error / process-kill) may abort at any page: staging is discarded, observable
\* state and cursor are untouched. Invariants: observable state is always a
\* fully-applied checkpoint (== a multiple of Pages, never a partial stage), and
\* the persisted cursor only ever equals an applied checkpoint.
EXTENDS Naturals

CONSTANTS Pages,          \* pages per checkpoint hydration
          MaxCheckpoints  \* bound: how many checkpoints we model applying

VARIABLES
  staged,                 \* pages staged so far in the in-flight hydration (0..Pages)
  applied,                \* count of fully-applied checkpoints (observable)
  persistedCursor         \* durable cursor (in units of applied checkpoints)

vars == << staged, applied, persistedCursor >>

Init ==
  /\ staged = 0
  /\ applied = 0
  /\ persistedCursor = 0

\* Receive and stage the next page (not yet observable).
StagePage ==
  /\ applied < MaxCheckpoints
  /\ staged < Pages
  /\ staged' = staged + 1
  /\ UNCHANGED << applied, persistedCursor >>

\* Durable atomic apply at has_more:false (all pages staged): commit + persist.
Apply ==
  /\ staged = Pages
  /\ applied' = applied + 1
  /\ persistedCursor' = applied + 1
  /\ staged' = 0
  /\ UNCHANGED << >>

\* Fault at any boundary: discard the partial stage; observable + cursor intact.
Fault ==
  /\ staged > 0
  /\ staged' = 0
  /\ UNCHANGED << applied, persistedCursor >>

\* Terminal action: once MaxCheckpoints is reached and no stage is in flight,
\* allow stuttering so TLC does not flag a deadlock (no more work to do).
Done ==
  /\ applied = MaxCheckpoints
  /\ staged = 0
  /\ UNCHANGED vars

Next == StagePage \/ Apply \/ Fault \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ staged \in 0..Pages
  /\ applied \in 0..MaxCheckpoints
  /\ persistedCursor \in 0..MaxCheckpoints

\* ── On the nature of this abstraction (READ THIS BEFORE COPYING THIS MODULE) ──
\* This is a POSITIVE abstraction: Apply keeps persistedCursor == applied by
\* construction, so TLC WITNESSES both invariants under all stage/apply/fault
\* interleavings rather than hunting a violation. An adversarial variant would
\* let a Fault or StagePage action move persistedCursor to give TLC a real
\* counterexample path to find or rule out.

\* Observable state is always a fully-applied checkpoint: the durable cursor
\* equals the count of applied checkpoints: never a partial (staged) value.
ObservableIsApplied == persistedCursor = applied

\* The cursor persists only at/after a durable apply: it never runs ahead of
\* the applied checkpoint count, and a mid-hydration stage cannot move it.
CursorAfterDurable == persistedCursor <= applied
====
