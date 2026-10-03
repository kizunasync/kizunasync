---
title: Installing
description: Install the Vue bindings and the subpaths that build the client they read.
status: alpha
docType: reference
library: vue
pageKind: installing
audience: app-developer
---

# Vue: Installing

The Vue composables ship in the `kizunasync` package as the `kizunasync/vue` subpath, and [Vue](https://vuejs.org) `^3.5.13` is an optional peer. The other subpaths build the client the composables read: `kizunasync` holds the engine and the config helpers, `kizunasync/supabase` composes the client over [Supabase](https://supabase.com), and `kizunasync/web` is the browser driver. [`@supabase/supabase-js`](https://supabase.com/docs/reference/javascript/installing) is Supabase's JavaScript client, which `kizunasync/supabase` takes as a peer and `src/supabase-client.ts` creates.

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

TypeScript resolves `createKizunaSyncPlugin` from `kizunasync/vue`. On a native host, swap `kizunasync/web` for `kizunasync/expo` and follow [Expo: Installing](../expo/installing.md); the composables are the same either way.

## Related reference

- [Introduction](./introduction.md)
- [Initializing](./initializing.md)
- [React: Installing](../react/installing.md)
- [Expo: Installing](../expo/installing.md)
- [JavaScript: Installing](../javascript/installing.md)
