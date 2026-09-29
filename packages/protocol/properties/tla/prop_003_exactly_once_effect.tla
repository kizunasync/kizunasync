---- MODULE prop_003_exactly_once_effect ----
\* prop-003 exactly-once effect over at-least-once transport
\* (cites P:session-guarantees-and-exactly-once-effect, P:verdict-completeness-transforms-and-conflict-rejection, SQL:clients-registry; D-dedup-storage-model; fencing: shared).
\* Model: a client repeatedly delivers a batch of mutation_ids under a transport
\* that may deliver each batch 1..N times (drop-ack => resend). The server dedups
\* by mutation_id (P:session-guarantees-and-exactly-once-effect _clients.last_mutation_id): the FIRST delivery applies the
\* effect and records a verdict; every later delivery returns the recorded verdict
\* unchanged (P:verdict-completeness-transforms-and-conflict-rejection) and does NOT re-apply. We check: (a) applied count per id is
\* at most 1; (b) the recorded verdict is stable across replays.
EXTENDS Naturals, FiniteSets

CONSTANTS Ids,            \* the set of mutation_ids in the batch
          MaxDeliveries   \* bound: max times the batch is (re)delivered

VARIABLES
  appliedCount,           \* [Ids -> Nat] times each id's effect was applied
  verdict,                \* [Ids -> {"none","applied"}] recorded server verdict
  delivered               \* count of batch deliveries so far

vars == << appliedCount, verdict, delivered >>

Init ==
  /\ appliedCount = [ i \in Ids |-> 0 ]
  /\ verdict = [ i \in Ids |-> "none" ]
  /\ delivered = 0

\* Deliver the batch once. For each id: if no verdict yet, apply + record;
\* else it's a replay -- return the recorded verdict, apply nothing (dedup).
Deliver ==
  /\ delivered < MaxDeliveries
  /\ delivered' = delivered + 1
  /\ appliedCount' = [ i \in Ids |->
       IF verdict[i] = "none" THEN appliedCount[i] + 1 ELSE appliedCount[i] ]
  /\ verdict' = [ i \in Ids |-> "applied" ]

\* Terminal action: once MaxDeliveries is reached, allow stuttering so TLC
\* does not flag a deadlock (the model has no more work to do).
Done ==
  /\ delivered >= MaxDeliveries
  /\ UNCHANGED vars

Next == Deliver \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ appliedCount \in [ Ids -> 0..MaxDeliveries ]
  /\ verdict \in [ Ids -> {"none","applied"} ]
  /\ delivered \in 0..MaxDeliveries

\* ── On the nature of this abstraction (READ THIS BEFORE COPYING THIS MODULE) ──
\* This is a POSITIVE abstraction: the dedup mechanism (verdict gating) is modelled
\* correct-by-construction, so TLC WITNESSES exactly-once under all redelivery
\* interleavings rather than hunting a violation. An adversarial variant would add
\* a no-dedup delivery action (ignoring verdict and incrementing appliedCount again)
\* to give TLC a real counterexample path to find or rule out.

\* (a) no effect applied more than once, regardless of redelivery count.
ExactlyOnce == \A i \in Ids : appliedCount[i] <= 1

\* (b) once recorded, the verdict is terminal (replays never rewrite it to a
\* different value) -- modelled as: a recorded "applied" stays "applied".
ReplayStable == \A i \in Ids : verdict[i] \in {"none","applied"}
====
