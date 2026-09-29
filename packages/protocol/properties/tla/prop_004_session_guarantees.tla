---- MODULE prop_004_session_guarantees ----
\* prop-004 session guarantees per device (cites P:session-guarantees-and-exactly-once-effect; fencing: shared).
\*
\* ── WHAT THIS MODELS ─────────────────────────────────────────────────────────
\* One device's SESSION against a server that holds an ORDERED applied-log of the
\* writes it has accepted (`log`, a sequence of write-ids in apply order). The
\* session issues writes in order (`issued`), and observes the server through a
\* READ that may land on a STALE replica, a PREFIX of the log that is behind the
\* tip (`readPos` <= Len(log)). That staleness is the whole point: it is what makes
\* a session-guarantee VIOLATION expressible (a read that skips the session's own
\* writes, or that goes backwards), exactly like prop-002's documented broken
\* variant (numbers drawn at write time, independent of commit order) makes the
\* lost write expressible.
\*
\* Session guarantees constrain what a READ observes, so the session carries
\* watermarks updated AT READ TIME:
\*   readPos      : log prefix length the last read observed (0..Len(log)),
\*   lastReadPos  : the read before that (so MR can compare consecutive reads),
\*   seenApplied  : the session's own writes the last read CONFIRMED applied,
\*   readBefore   : per write, the readPos the session held when it issued it.
\* The four Terry et al. (1994) session guarantees are four DISTINCT conditions:
\*
\*   read-your-writes   : every write THIS session has CONFIRMED applied (seen in a
\*                        read) is present in the prefix it observed.
\*   monotonic-reads    : each read observes a prefix no shorter than the previous
\*                        read, the observed position never goes backwards.
\*   monotonic-writes   : this session's applied writes sit in the log in ISSUE
\*                        order, EXCEPT a dead-lettered write, which is the ONE
\*                        surfaced, accounted exception (P:session-guarantees-and-exactly-once-effect). A gap in issue order
\*                        is allowed IFF the skipped write is in `deadLettered`.
\*   writes-follow-reads: once applied, a write is ordered in the log strictly
\*                        AFTER the prefix the session had observed when it issued
\*                        the write (its `readBefore` watermark).
\*
\* Four genuinely different expressions, over different state:
\*   RYW  : set containment:  seenApplied \subseteq observed-prefix.
\*   MR   : scalar monotone:  lastReadPos <= readPos.
\*   MW   : sequence prefix:  log is a prefix of (issued minus deadLettered).
\*   WFR  : each applied write's LOG position vs the READ watermark it carried.
\* None is a relabel of another. All four stay distinct inequalities. (Note RYW checks the session's CONFIRMED
\* writes against the observed prefix, not the live `applied` set, which can grow
\* AFTER a read without violating anything: a write that lands but the session has
\* not read back yet is not yet read-your-own, which is correct Terry
\* semantics.)
\*
\* ── THE DEAD-LETTER IS LOAD-BEARING (not decorative) ─────────────────────────
\* MonotonicWrites is `log` is-a-prefix-of `ExpectedLog`, where ExpectedLog is the
\* issued sequence with every dead-lettered id FILTERED OUT. The dead-letter set is
\* the oracle's filter: it is the ONLY reason an issued id may be missing from the
\* log while a later-issued id is present. Drop the filter (ExpectedLog == issued)
\* and an honest, RECORDED dead-letter, abandoned id absent from the log, the
\* next id applied, makes `log` diverge from the unfiltered expected sequence and
\* MW FAILS (teeth (DL) below, a REACHABLE state of the unmodified honest dynamics).
\* That is the exact sense in which the surfaced exception is load-bearing.
\*
\* ── PROVING TEETH (this model can express a violation) ───────────────────────
\* Three independent teeth, each a real reachable counterexample (reproducible
\* with `tools/run-tlc.sh prop_004_session_guarantees`):
\*
\* (A) BROKEN READ vs ReadYourWrites / MonotonicReads. The honest `Read` requires
\*     the new prefix to be no shorter than the last read (MR floor) and to already
\*     contain every applied session write (RYW precondition). Replace it with a
\*     read that snaps `readPos` to ANY prefix and still records seenApplied, and
\*     TLC finds: issue w1, apply it (log=<<1>>), then a stale read with readPos=0
\*     sets seenApplied={1} while Observed={} => ReadYourWrites violated; and a read
\*     to readPos=1 then back to readPos=0 (lastReadPos=1) => MonotonicReads violated.
\*
\* (B) SILENT REORDER vs MonotonicWrites. The honest server applies only the
\*     FRONT-MOST pending write (issue order). Add a SilentSkipApply that applies
\*     ANY pending write without recording a dead-letter, and TLC finds: issue w1,
\*     w2, then apply w2 first => log=<<2>>, ExpectedLog=<<1,2>> (nothing
\*     dead-lettered), and <<2>> is not a prefix of <<1,2>> => MW violated.
\*
\* (DL) DEAD-LETTER FILTER REMOVED vs MonotonicWrites (proves the exception is
\*     load-bearing). Keep the honest dynamics; only change ExpectedLog to `issued`
\*     (unfiltered). TLC finds: issue w1, w2; dead-letter w1 (deadLettered={1},
\*     recorded); apply w2 => log=<<2>>; unfiltered ExpectedLog=<<1,2>>; <<2>> is
\*     not a prefix of <<1,2>> => MW violated. With the filter (committed file)
\*     ExpectedLog=<<2>> and log=<<2>> is a prefix => green.
\*
\* With the honest `Read`, single-ApplyNext server, and FILTERED ExpectedLog
\* (this committed file), TLC reports "Model checking completed. No error has been
\* found." Every reachable state stays inside all four guarantees.
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT MaxIssue          \* bound: number of writes the session may issue (e.g. 3)

VARIABLES
  issued,                  \* Seq of write-ids the session has ISSUED, in issue order
  log,                     \* Seq of write-ids the SERVER has applied, in apply order
  applied,                 \* set of issued write-ids that reached the log
  deadLettered,            \* set of issued write-ids surfaced + abandoned (the exception)
  readPos,                 \* log prefix length the last read observed (0..Len(log))
  lastReadPos,             \* the previous read's observed prefix length (MR watermark)
  seenApplied,             \* session writes the last read CONFIRMED applied (RYW watermark)
  readBefore               \* [id |-> readPos when that id was issued] (WFR watermark)

vars == << issued, log, applied, deadLettered,
           readPos, lastReadPos, seenApplied, readBefore >>

\* write-ids are 1..MaxIssue; issue order is ascending id. The next id to issue is
\* Len(issued)+1, so `issued` is always <<1, 2, ..., Len(issued)>>.
Ids == 1..MaxIssue

\* Position of write-id w in the log (1-based), or 0 if not yet applied. Each id is
\* applied at most once, so this is well defined.
LogPos(w) ==
  IF \E i \in 1..Len(log) : log[i] = w
  THEN CHOOSE i \in 1..Len(log) : log[i] = w
  ELSE 0

\* The set of write-ids visible in the prefix of `log` the session last observed.
Observed == { log[i] : i \in 1..readPos }

Init ==
  /\ issued = << >>
  /\ log = << >>
  /\ applied = {}
  /\ deadLettered = {}
  /\ readPos = 0
  /\ lastReadPos = 0
  /\ seenApplied = {}
  /\ readBefore = [ id \in Ids |-> 0 ]

\* Issue the next write in issue order (id = Len(issued)+1), stamping the read
\* watermark it carries (the prefix this session had observed at issue time). Not
\* yet applied.
Issue ==
  /\ Len(issued) < MaxIssue
  /\ LET id == Len(issued) + 1 IN
       /\ issued' = Append(issued, id)
       /\ readBefore' = [ readBefore EXCEPT ![id] = readPos ]
  /\ UNCHANGED << log, applied, deadLettered, readPos, lastReadPos, seenApplied >>

\* The issued-but-undecided write-ids (neither applied nor dead-lettered). The
\* server may apply / dead-letter the FRONT-MOST such id only, so it processes the
\* session's writes in issue order (the monotonic-writes precondition); a skipped
\* id must be explicitly dead-lettered, never silently jumped.
Pending == { issued[i] : i \in 1..Len(issued) } \ (applied \cup deadLettered)
NextPending == CHOOSE w \in Pending : \A v \in Pending : w <= v

\* Server applies the next pending write to the tip of the log (in issue order).
ApplyNext ==
  /\ Pending # {}
  /\ log' = Append(log, NextPending)
  /\ applied' = applied \cup { NextPending }
  /\ UNCHANGED << issued, deadLettered, readPos, lastReadPos, seenApplied, readBefore >>

\* Dead-letter the next pending write: surfaced + abandoned (the ONE exception,
\* P:session-guarantees-and-exactly-once-effect). RECORDED in `deadLettered`; never enters the log, leaving a gap in this
\* session's issue order that MonotonicWrites tolerates ONLY because it is
\* accounted for here.
DeadLetterNext ==
  /\ Pending # {}
  /\ deadLettered' = deadLettered \cup { NextPending }
  /\ UNCHANGED << issued, log, applied, readPos, lastReadPos, seenApplied, readBefore >>

\* Honest read: observe a NEWER-OR-EQUAL prefix of the log (monotonic-reads) that
\* already contains every write THIS session has had applied (read-your-writes).
\* readPos may still lag the tip (a stale-but-session-consistent replica), so this
\* is not a trivial "always read the tip" abstraction. It explores every prefix
\* that keeps the session's own guarantees. The read CONFIRMS the session's
\* applied writes (records them in seenApplied), and the precondition guarantees
\* the observed prefix already contains them.
Read ==
  /\ \E p \in lastReadPos..Len(log) :
       /\ applied \subseteq { log[i] : i \in 1..p }
       /\ readPos' = p
  /\ lastReadPos' = readPos
  /\ seenApplied' = applied
  /\ UNCHANGED << issued, log, applied, deadLettered, readBefore >>

\* Terminal stutter: every issued write decided (applied or dead-lettered),
\* nothing left to issue, and the read has caught up to the tip. No action makes
\* progress. Allow an explicit stutter so TLC does not flag a deadlock at the
\* (legitimately) final state of a finite run.
Done ==
  /\ Len(issued) = MaxIssue
  /\ Pending = {}
  /\ readPos = Len(log)
  /\ UNCHANGED vars

Next == Issue \/ ApplyNext \/ DeadLetterNext \/ Read \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ issued \in Seq(Ids)
  /\ log \in Seq(Ids)
  /\ applied \subseteq Ids
  /\ deadLettered \subseteq Ids
  /\ applied \cap deadLettered = {}
  /\ readPos \in 0..Len(log)
  /\ lastReadPos \in 0..Len(log)
  /\ seenApplied \subseteq Ids
  /\ readBefore \in [ Ids -> 0..MaxIssue ]

\* ── G1 read-your-writes ──────────────────────────────────────────────────────
\* Every write THIS session has confirmed applied (in a read) is present in the
\* prefix it observed. (set containment: confirmed session writes ⊆ observed prefix)
ReadYourWrites == seenApplied \subseteq Observed

\* ── G2 monotonic-reads ───────────────────────────────────────────────────────
\* The observed prefix never goes backwards from one read to the next.
\* (scalar monotonicity of the read watermark)
MonotonicReads == lastReadPos <= readPos

\* ── G3 monotonic-writes (dead-letter is the ONE surfaced exception) ──────────
\* The server's applied log must be exactly the session's issued writes, IN ISSUE
\* ORDER, with the dead-lettered ones FILTERED OUT, up to the writes not yet
\* decided. Formally: `log` is a prefix of `issued` after dropping every
\* dead-lettered id (`ExpectedLog`). This is one expression that captures BOTH
\* order (no reorder: a later-issued write may not overtake an earlier one) AND the
\* dead-letter exception (the ONLY id that may be absent from the log while a
\* later-issued id is present is one recorded in `deadLettered`).
\*
\* The dead-letter is LOAD-BEARING here, not decorative: `ExpectedLog` is built by
\* FILTERING OUT `deadLettered`. Remove that filter (keep dead-lettered ids in the
\* expected sequence) and a real dead-letter, where the abandoned id is absent
\* from `log` but the next-issued id IS applied, makes `log` differ from the
\* (now unfiltered) expected sequence, so the invariant FAILS. The exception is the
\* sole reason the filtered sequence is the right oracle, and only because every
\* abandonment is RECORDED in `deadLettered`. A SILENT reorder (a later write
\* applied over an undecided earlier one, with no dead-letter) likewise makes `log`
\* not a prefix of `ExpectedLog`: TLC finds it (teeth (B), module header).
NotDeadLettered(w) == w \notin deadLettered
ExpectedLog == SelectSeq(issued, NotDeadLettered)
IsPrefix(s, t) ==                       \* s is a prefix of t
  /\ Len(s) <= Len(t)
  /\ \A i \in 1..Len(s) : s[i] = t[i]
MonotonicWrites == IsPrefix(log, ExpectedLog)

\* ── G4 writes-follow-reads ───────────────────────────────────────────────────
\* Once applied, a write is ordered in the log strictly after the prefix the
\* session had observed when it issued the write: LogPos(w) > readBefore[w].
\* Distinct from RYW (reads covering writes) and MW (issue order among writes):
\* this ties each WRITE's log position to the READ that preceded it.
WritesFollowReads ==
  \A w \in applied : LogPos(w) > readBefore[w]
====
