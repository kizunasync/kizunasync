# D-verdict-correlation: Verdicts correlate by request order and by mutation_id

<!-- kizunasync:decision
id: D-verdict-correlation
status: decided
-->

**Cites:** P:verdict-completeness-transforms-and-conflict-rejection

## Question

How does a client match each push verdict to the mutation it sent?

## Decision

A non-atomic success response contains one verdict per request mutation, in request order, each carrying that mutation's `mutation_id`. The client may index by either position or id. Unknown verdict kinds fail loudly.

## Rejected

- **Order only, with no `mutation_id`.** A client that retried a subset could not tell which verdict belonged to which retry.
- **Id only, in arbitrary order.** The request-order rule is what lets a test, and a simple client, walk the two arrays together.
