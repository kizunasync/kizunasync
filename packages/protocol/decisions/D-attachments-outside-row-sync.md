# D-attachments-outside-row-sync: Attachment bytes stay outside row-sync

<!-- kizunasync:decision
id: D-attachments-outside-row-sync
status: decided
-->

**Cites:** P:attachments-are-out-of-protocol-scope

## Question

Do attachment object bytes ride pull or push?

## Decision

No. Attachment object bytes never ride pull or push. The SQL pack includes `attachment_confirm` and `attachment_vacuum`. The client transfer port uses those metadata operations around Storage objects. A row may carry an attachment reference as an ordinary column value.

The current Supabase adapter uses single-shot upload at or below 6 MiB and TUS above 6 MiB, with 6 MiB chunks. That adapter policy is not a protocol byte.

## Rejected

- **Inlining object bytes in a mutation or a pull page.** The corpus, the page cap, and the fencing horizon are defined on rows. Object transfer is a different queue.
