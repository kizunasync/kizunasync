---- MODULE prop_002_no_lost_committed_change ----
\* prop-002 no lost committed change
\* (cites P:keyset-pagination-and-delivery-bound, SQL:visibility-horizon; D-visibility-horizon; fencing: visibility-horizon).
\*
\* ── THE HAZARD THIS MODULE HUNTS (the lost write, SQL:visibility-horizon) ──
\* Every change carries one number (seq) from one global sequence, and a pull
\* resumes from a cursor, the largest number it has delivered. When a number is
\* drawn BEFORE its transaction commits, a transaction can hold a low number
\* while another transaction draws a higher one and commits:
\*   1. Txn A draws seq 1 and stays open.
\*   2. Txn B draws seq 2 and commits.
\*   3. A pull sees 2 as the largest committed number and moves its cursor to 2.
\*   4. A commits: seq 1 becomes visible, below the cursor.
\*   5. The next pull asks for seq > 2. Seq 1 is never delivered.
\*
\* ── THE DESIGN THIS MODULE MODELS (D-visibility-horizon) ─────────────────────
\* The SQL pack draws a change's number when its transaction commits. The
\* deferred constraint trigger `kizunasync._stamp_transaction` takes one
\* transaction-scoped advisory lock and calls nextval on
\* `kizunasync._change_seq`. PostgreSQL makes a committing transaction visible
\* to new snapshots before it releases that transaction's locks, so a
\* transaction draws a number only after every earlier drawer is visible or
\* aborted. `Commit(t)` is therefore ONE atomic step: draw the next number and
\* make it committed. An open transaction has drawn nothing. An abort may
\* consume a number without committing it (the stamp ran, then the transaction
\* aborted); that number is a gap no pull ever delivers.
\*
\* `Pull` is one pull under one snapshot (`kizunasync._pull_horizon` plus its
\* page): it delivers every committed number above the cursor and moves the
\* cursor to the largest committed number.
\*
\* Transactions and numbers stay separate here. A model that sets
\* `Seq(t) == t` identifies the transaction order with the numbering order, so
\* it cannot express the inversion in which an older transaction draws a higher
\* number than a younger one. Transactions are 1..NTxns, and numbers come from
\* the separate counter `nextSeq`.
\*
\* ── PROVING TEETH (the write-time variant) ────────────────────────────────────
\* The model is adversarial only if a wrong numbering rule makes TLC find the
\* loss. The write-time variant replaces `Commit(t)` with two steps and keeps
\* every other operator, `Pull` included:
\*
\*   Draw(t) ==                         \* the number is drawn at the write
\*     /\ status[t] = "open"
\*     /\ drawn[t] = None
\*     /\ drawn' = [drawn EXCEPT ![t] = nextSeq]
\*     /\ nextSeq' = nextSeq + 1
\*     /\ UNCHANGED << status, delivered, cursor >>
\*
\*   Commit(t) ==                       \* and committed later, in any order
\*     /\ status[t] = "open"
\*     /\ drawn[t] # None
\*     /\ status' = [status EXCEPT ![t] = "committed"]
\*     /\ UNCHANGED << drawn, nextSeq, delivered, cursor >>
\*
\* The variant also adds `\E t \in Txns : Draw(t)` to `Next`. With the
\* committed cfg, TLC stops at State 6 with "Error: Invariant
\* CursorCoversDelivered is violated." With `INVARIANT TypeOK` and
\* `PROPERTY Delivered` alone, TLC prints this lasso (verbatim, TLC2 Version
\* 2026.09.09.213036 with `-fp 2`, NTxns = 3; the line and column numbers
\* point into the variant derived from this file):
\*
\*   Error: Temporal property Delivered was violated.
\*
\*   Error: The following behavior constitutes a counter-example:
\*
\*   State 1: <Initial predicate>
\*   /\ nextSeq = 1
\*   /\ status = <<"open", "open", "open">>
\*   /\ drawn = <<0, 0, 0>>
\*   /\ cursor = 0
\*   /\ delivered = {}
\*
\*   State 2: <Draw(1) line 160, col 3 to line 164, col 46 of module prop_002_no_lost_committed_change>
\*   /\ nextSeq = 2
\*   /\ status = <<"open", "open", "open">>
\*   /\ drawn = <<1, 0, 0>>
\*   /\ cursor = 0
\*   /\ delivered = {}
\*
\*   State 3: <Draw(2) line 160, col 3 to line 164, col 46 of module prop_002_no_lost_committed_change>
\*   /\ nextSeq = 3
\*   /\ status = <<"open", "open", "open">>
\*   /\ drawn = <<1, 2, 0>>
\*   /\ cursor = 0
\*   /\ delivered = {}
\*
\*   State 4: <Commit(2) line 167, col 3 to line 170, col 54 of module prop_002_no_lost_committed_change>
\*   /\ nextSeq = 3
\*   /\ status = <<"open", "committed", "open">>
\*   /\ drawn = <<1, 2, 0>>
\*   /\ cursor = 0
\*   /\ delivered = {}
\*
\*   State 5: <Pull line 186, col 3 to line 189, col 43 of module prop_002_no_lost_committed_change>
\*   /\ nextSeq = 3
\*   /\ status = <<"open", "committed", "open">>
\*   /\ drawn = <<1, 2, 0>>
\*   /\ cursor = 2
\*   /\ delivered = {2}
\*
\*   State 6: <Commit(1) line 167, col 3 to line 170, col 54 of module prop_002_no_lost_committed_change>
\*   /\ nextSeq = 3
\*   /\ status = <<"committed", "committed", "open">>
\*   /\ drawn = <<1, 2, 0>>
\*   /\ cursor = 2
\*   /\ delivered = {2}
\*
\*   State 7: <Abort(3) line 174, col 3 to line 180, col 38 of module prop_002_no_lost_committed_change>
\*   /\ nextSeq = 3
\*   /\ status = <<"committed", "committed", "aborted">>
\*   /\ drawn = <<1, 2, 0>>
\*   /\ cursor = 2
\*   /\ delivered = {2}
\*
\*   State 8: Stuttering
\*
\* Txn 1 draws 1 and stays open, txn 2 draws 2 and commits, and the pull moves
\* the cursor to 2. Txn 1 then commits 1 below the cursor, and no later pull
\* delivers it.
\*
\* With the commit-time `Commit(t)` of this file, TLC reports "Model checking
\* completed. No error has been found." A later commit always draws a number
\* above every visible one, so it lands above the cursor.
EXTENDS Naturals, FiniteSets

CONSTANT NTxns             \* bound: number of transactions (e.g. 3)

Txns == 1..NTxns
Seqs == 1..NTxns           \* each transaction consumes at most one number
None == 0                  \* drawn[t] = None: t has drawn no number

VARIABLES
  status,                  \* status[t] \in {"open", "committed", "aborted"}
  drawn,                   \* drawn[t]: the number t drew, None until it draws
  nextSeq,                 \* the number the sequence hands out next
  delivered,               \* the numbers the client has received
  cursor                   \* the largest committed number the last pull saw

vars == << status, drawn, nextSeq, delivered, cursor >>

\* The committed-sequence set: numbers whose transaction committed.
Committed == { drawn[t] : t \in { u \in Txns : status[u] = "committed" } }

MaxCommitted ==
  IF Committed = {}
  THEN 0
  ELSE CHOOSE m \in Committed : \A s \in Committed : s <= m

Init ==
  /\ status = [t \in Txns |-> "open"]
  /\ drawn = [t \in Txns |-> None]
  /\ nextSeq = 1
  /\ delivered = {}
  /\ cursor = 0

\* Commit-time numbering: the stamp draws under the advisory lock, and the lock
\* outlives the commit's visibility, so drawing and committing are one step.
Commit(t) ==
  /\ status[t] = "open"
  /\ status' = [status EXCEPT ![t] = "committed"]
  /\ drawn' = [drawn EXCEPT ![t] = nextSeq]
  /\ nextSeq' = nextSeq + 1
  /\ UNCHANGED << delivered, cursor >>

\* An abort consumes no number, or consumes one it never commits (a gap).
Abort(t) ==
  /\ status[t] = "open"
  /\ status' = [status EXCEPT ![t] = "aborted"]
  /\ \/ UNCHANGED << drawn, nextSeq >>
     \/ /\ drawn[t] = None
        /\ drawn' = [drawn EXCEPT ![t] = nextSeq]
        /\ nextSeq' = nextSeq + 1
  /\ UNCHANGED << delivered, cursor >>

\* Deliver every committed number above the cursor, then move the cursor to the
\* largest committed number. Enabled only when it makes progress, so it adds no
\* stutter self-loops.
Pull ==
  /\ MaxCommitted > cursor
  /\ delivered' = delivered \cup { s \in Committed : s > cursor }
  /\ cursor' = MaxCommitted
  /\ UNCHANGED << status, drawn, nextSeq >>

\* Terminal stutter once no transaction is open, so TLC reports no deadlock at
\* the final state of a finite run.
Done ==
  /\ \A t \in Txns : status[t] # "open"
  /\ UNCHANGED vars

Next ==
  \/ \E t \in Txns : Commit(t)
  \/ \E t \in Txns : Abort(t)
  \/ Pull
  \/ Done

\* Fairness covers Pull only: the client keeps polling. Nothing forces an open
\* transaction to resolve, because an open transaction has drawn nothing and
\* holds back no committed number; `Delivered` holds even when one stays open
\* forever.
Spec == Init /\ [][Next]_vars /\ WF_vars(Pull)

TypeOK ==
  /\ status \in [Txns -> {"open", "committed", "aborted"}]
  /\ drawn \in [Txns -> {None} \cup Seqs]
  /\ nextSeq \in 1..(NTxns + 1)
  /\ delivered \subseteq Seqs
  /\ cursor \in 0..NTxns

\* ── SAFETY: every committed number at or below the cursor is delivered ────────
CursorCoversDelivered == \A s \in Committed : s <= cursor => s \in delivered

\* ── SAFETY: a number an aborted transaction consumed is never delivered ──────
AbortDeliversNothing ==
  \A t \in Txns : (status[t] = "aborted" /\ drawn[t] # None) => drawn[t] \notin delivered

\* ── LIVENESS: every committed transaction's number is eventually delivered ───
Delivered == \A t \in Txns : (status[t] = "committed") ~> (drawn[t] \in delivered)
====
