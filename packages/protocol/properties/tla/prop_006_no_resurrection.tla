---- MODULE prop_006_no_resurrection ----
\* prop-006 no resurrection at any offline duration, the FUSION property
\* (cites P:mutations-and-column-masked-conflict-resolution, P:cursor-monotonicity-rebase-and-atomic-checkpoints, SQL:tombstone-reaping; fencing: shared).
\*
\* ── THE HAZARD THIS MODULE HUNTS (the resurrection, P:mutations-and-column-masked-conflict-resolution/P:cursor-monotonicity-rebase-and-atomic-checkpoints) ──────────────────
\* A row is deleted on the server, leaving a tombstone that lives for Ttl ticks
\* (tombstone_ttl_days=30) and is then REAPED (SQL:tombstone-reaping). A client that holds
\* the row goes offline, then reconnects after `offline` ticks and re-syncs from a
\* stale cursor. The deleted row must NOT reappear on the client. Whether it does
\* depends on what the re-sync can carry, which is governed by TWO boundaries:
\*
\*   Ttl            : how long the tombstone is retained before being reaped.
\*   ExpiryHorizon  : how far back the server retains checkpoints; a cursor older
\*                    than this is signalled CHECKPOINT_EXPIRED (P:cursor-monotonicity-rebase-and-atomic-checkpoints).
\*
\* The re-sync resolves to exactly ONE of THREE outcomes, by offline duration:
\*
\*   (A) offline <= Ttl           : the tombstone is still LIVE. The pull carries
\*                                  it, so the client deletes its local copy.
\*                                  The DELETE RIDES THE PULL.   → clientHasRow=FALSE
\*
\*   (B) offline >  ExpiryHorizon : the cursor is STALE. The server signals
\*                                  CHECKPOINT_EXPIRED; the client discards its
\*                                  checkpoint and RE-HYDRATES FRESH. The deleted
\*                                  row is absent from the snapshot.
\*                                  ROW OMITTED FROM SNAPSHOT.   → clientHasRow=FALSE
\*
\*   (C) otherwise, the GAP      : Ttl < offline <= ExpiryHorizon. The tombstone
\*                                  has been REAPED (so the pull carries NO delete)
\*                                  AND the cursor is NOT yet signalled stale (so no
\*                                  CHECKPOINT_EXPIRED, no re-hydration). The pull
\*                                  carries NEITHER the tombstone NOR the signal, so
\*                                  the client keeps the row.  → clientHasRow UNCHANGED
\*                                  (stays TRUE) → RESURRECTION.
\*
\* Outcome (C) is reachable ONLY when ExpiryHorizon > Ttl, i.e. only when the two
\* boundaries are NOT fused. This is the entire point of prop-006.
\*
\* ── THE FUSION (P:mutations-and-column-masked-conflict-resolution: checkpoint-expiry horizon == tombstone TTL) ──────────────
\* KizunaSync FUSES the two boundaries: ExpiryHorizon = Ttl. The gap (C) then has
\* width zero, its guard `Ttl < offline <= ExpiryHorizon` is unsatisfiable, so
\* the two SAFE regimes (A) and (B) are EXHAUSTIVE over every offline duration:
\* any offline long enough to reap the tombstone is also long enough to expire the
\* cursor, and vice versa. There is NO offline duration that reaps the tombstone
\* without also expiring the cursor. The two mechanisms hand off with no seam.
\*
\* ── PROVING TEETH (this module ACTIVELY hunts the resurrection) ───────────────
\* The hazard is real only if a BROKEN fusion makes TLC find the resurrection,
\* and it does. With the boundaries UN-fused: ExpiryHorizon = Ttl + 1 (the
\* committed cfg uses ExpiryHorizon = Ttl), TLC reports a `NoResurrection`
\* INVARIANT violation with this exact counter-trace (Ttl=2, MaxOffline=4, so the
\* gap is the single duration offline=3; verbatim from TLC):
\*
\*   State 1 (Init):  deleted=FALSE, offline=0, clientHasRow=TRUE,  resynced=FALSE
\*   State 2 Delete:  deleted=TRUE,  offline=0, clientHasRow=TRUE,  resynced=FALSE
\*   State 3 Tick:    deleted=TRUE,  offline=1, clientHasRow=TRUE,  resynced=FALSE
\*   State 4 Tick:    deleted=TRUE,  offline=2, clientHasRow=TRUE,  resynced=FALSE
\*   State 5 Tick:    deleted=TRUE,  offline=3, clientHasRow=TRUE,  resynced=FALSE
\*   State 6 Resync:  deleted=TRUE,  offline=3, clientHasRow=TRUE,  resynced=TRUE
\*     \* offline=3 is in the GAP: Ttl(2) < 3 <= ExpiryHorizon(3). The tombstone is
\*     \* reaped (offline > Ttl) so the pull carries no delete; the cursor is not yet
\*     \* signalled stale (offline <= ExpiryHorizon) so no CHECKPOINT_EXPIRED, no
\*     \* re-hydration. Resync leaves clientHasRow UNCHANGED at TRUE.
\*   => deleted /\ resynced /\ clientHasRow=TRUE  : NoResurrection VIOLATED.
\*   => TLC: "Error: Invariant NoResurrection is violated." (6-state trace).
\*
\* With the FUSION (this committed file, cfg ExpiryHorizon = Ttl), the gap
\* guard `Ttl < offline <= ExpiryHorizon` becomes `Ttl < offline <= Ttl`, which is
\* unsatisfiable, so outcome (C) is unreachable and every Resync lands in (A) or
\* (B), both of which clear the row. TLC reports "Model checking completed. No
\* error has been found." Reproducible with `tools/run-tlc.sh prop_006_no_resurrection`.
\* THIS is the difference between the fusion-as-invariant and a positive
\* abstraction: with the boundaries un-fused the resurrection is REACHABLE, and the
\* fusion (ExpiryHorizon = Ttl) is what rules it out.
EXTENDS Naturals

CONSTANTS Ttl,            \* tombstone TTL in ticks (models tombstone_ttl_days=30)
          ExpiryHorizon,  \* checkpoint-retention horizon in ticks; cursor older
                          \* than this is signalled CHECKPOINT_EXPIRED. FUSED in
                          \* the committed cfg: ExpiryHorizon = Ttl.
          MaxOffline      \* bound: max offline duration to check (>= ExpiryHorizon)

VARIABLES
  deleted,                \* TRUE once the server has deleted the row
  offline,                \* ticks the client has been offline
  clientHasRow,           \* TRUE if the client still holds the (deleted) row
  resynced                \* TRUE once the client has reconnected + re-synced

vars == << deleted, offline, clientHasRow, resynced >>

Init ==
  /\ deleted = FALSE
  /\ offline = 0
  /\ clientHasRow = TRUE       \* client had the row before going offline
  /\ resynced = FALSE

\* Server deletes the row (writes the tombstone).
Delete ==
  /\ deleted = FALSE
  /\ deleted' = TRUE
  /\ UNCHANGED << offline, clientHasRow, resynced >>

\* Time passes while the client is offline (any duration up to the bound).
Tick ==
  /\ ~resynced
  /\ offline < MaxOffline
  /\ offline' = offline + 1
  /\ UNCHANGED << deleted, clientHasRow, resynced >>

\* ── Predicates over the offline duration vs the two boundaries ────────────────
\* TombstoneLive  : the tombstone has NOT yet been reaped (offline <= Ttl), so a
\*                  pull still carries the delete.
\* CursorExpired  : the cursor predates the retained horizon (offline >
\*                  ExpiryHorizon), so the server signals CHECKPOINT_EXPIRED and
\*                  the client re-hydrates fresh.
TombstoneLive == offline <= Ttl
CursorExpired == offline > ExpiryHorizon

\* Reconnect + re-sync. The local copy survives the re-sync ONLY in the GAP, where
\* the tombstone is reaped (~TombstoneLive) AND the cursor is not yet expired
\* (~CursorExpired): the pull carries neither the delete nor the CHECKPOINT_EXPIRED
\* signal, so nothing tells the client to drop the row. In every other case at
\* least one mechanism fires and the row is cleared. Only meaningful once deleted.
Resync ==
  /\ deleted = TRUE
  /\ ~resynced
  /\ clientHasRow' = IF (~TombstoneLive /\ ~CursorExpired)
                     THEN clientHasRow      \* GAP: row survives → resurrection
                     ELSE FALSE             \* (A) delete rides pull, or (B) re-hydrate
  /\ resynced' = TRUE
  /\ UNCHANGED << deleted, offline >>

\* Terminal stutter: once re-synced no action makes progress (Delete needs
\* ~deleted, Tick and Resync need ~resynced). Allow an explicit stutter so TLC does
\* not flag a deadlock at the (legitimately) final state of a finite run.
Done ==
  /\ resynced
  /\ UNCHANGED vars

Next == Delete \/ Tick \/ Resync \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ deleted \in BOOLEAN
  /\ offline \in 0..MaxOffline
  /\ clientHasRow \in BOOLEAN
  /\ resynced \in BOOLEAN

\* No resurrection: once the row is deleted AND the client has re-synced, the
\* client must NOT hold the row, at ANY offline duration (Tick explores all in
\* 0..MaxOffline, which spans both regimes and the gap when un-fused).
NoResurrection == (deleted /\ resynced) => (clientHasRow = FALSE)
====
