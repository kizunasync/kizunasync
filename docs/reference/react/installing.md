---
title: Installing
description: Install the React bindings and the subpaths that build the client they read.
status: alpha
docType: reference
library: react
pageKind: installing
audience: app-developer
---

# React: Installing

The React hooks ship in the `kizunasync` package as the `kizunasync/react` subpath, and [React](https://react.dev) 19 or later is an optional peer. The other subpaths build the client the hooks read: `kizunasync` holds the engine and the config helpers, `kizunasync/supabase` composes the client over [Supabase](https://supabase.com), and `kizunasync/web` is the browser driver. [`@supabase/supabase-js`](https://supabase.com/docs/reference/javascript/installing) is Supabase's JavaScript client, which `kizunasync/supabase` takes as a peer and `src/supabase-client.ts` creates.

## Install from npm

:::tabs{group=pm}
```bash tab=npm
npm install kizunasync @supabase/supabase-js
```

```bash tab=pnpm
pnpm add kizunasync @supabase/supabase-js
```

```bash tab=yarn
yarn add kizunasync @supabase/supabase-js
```

```bash tab=bun
bun add kizunasync @supabase/supabase-js
```
:::

TypeScript resolves `KizunaSyncProvider` from `kizunasync/react`. On a native host, swap `kizunasync/web` for `kizunasync/expo` and follow [Expo: Installing](../expo/installing.md); the hooks are the same either way.

## Related reference

- [Introduction](./introduction.md)
- [Initializing](./initializing.md)
- [Vue: Installing](../vue/installing.md)
- [Expo: Installing](../expo/installing.md)
- [JavaScript: Installing](../javascript/installing.md)
