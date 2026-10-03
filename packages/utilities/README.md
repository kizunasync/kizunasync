<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">@kizunasync/utilities</span>
</h1>

Devtools shared by the three JavaScript examples, React, Vue, and Expo. The package holds the query log, the live-sync gate with the connectivity and wakeup wrappers it drives, the demo account catalog, and the todo-board predicates.

Private. Never published.

## What this is

Example apps need the same lab controls without copying them three times. This package holds those helpers. Application schema stays in each example; they declare their own `todos` types inline.

## Exports

- `createQueryLog`: bounded in-memory log of explicit reads and writes (`IQueryLog`, `IQueryLogEntry`, `TQueryOp`)
- `createLiveSyncGate`: live-sync on/off and simulated offline (`ILiveSyncGate`). Offline always wins over live sync
- `createConnectivityGate`: wraps platform `IConnectivity` so simulated offline looks like a real transition to the engine
- `createGatedWakeup`: wraps platform `IWakeup` so the doorbell unsubscribes when the gate is off
- `createDemoAccounts`: account-pill list (anonymous first, then the three registered users), plus `DEMO_PASSWORD`, `REGISTERED_UIDS`, and helpers
- `isTodoMine` / `isTodoEditable` / `matchesTodoFilter` / `sortTodosMineFirst`: board predicates over already-loaded rows, plus `TITLE_MAX_LENGTH`
- `createEngineEventLog`: bounded engine-event ring for the Cache tab, with `summarizeEngineEvent`
- `formatClockTime` / `formatRelativeTime`: 24h stamp and coarse relative labels
- `forceServerConflict`: conflict-lab edit that bypasses the client so a later sync can show last-write-wins
- `performAccountSwitch` / `recoverSession`: account-pill flow and boot-time session recovery through one `IAccountSwitchPorts` shape
- `messageOf`: extracts a human-readable message from a caught unknown value
- `decideAccountSwitch`: the offline-then-outbox gate every example applies before `performAccountSwitch`, returning `TAccountSwitchDecision`
- `wireLabControls`: builds `resetLocal` / `expireCheckpoint` / `forceServerConflict` once at client construction (`ILabControls`)

## Related

- [`examples/todo-react`](../../examples/todo-react)
- [`examples/todo-vue`](../../examples/todo-vue)
- [`examples/todo-expo`](../../examples/todo-expo)
