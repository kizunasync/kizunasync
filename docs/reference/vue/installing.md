---
title: Installing
description: Install the Vue bindings and the packages that build the client they read.
status: alpha
docType: reference
library: vue
pageKind: installing
audience: app-developer
---

# Vue: Installing

`@kizunasync/vue` carries one dependency, `@kizunasync/core`, and declares [Vue](https://vuejs.org) `^3.5.13` as a peer. The other packages build the client the composables read: `@kizunasync/core` holds the engine and the config helpers, `@kizunasync/supabase` composes the client over [Supabase](https://supabase.com), and `@kizunasync/web` is the browser driver. [`@supabase/supabase-js`](https://supabase.com/docs/reference/javascript/installing) is Supabase's JavaScript client, which `@kizunasync/supabase` takes as a peer and `src/supabase-client.ts` creates.

## Install from npm

:::tabs{group=pm}
```bash tab=npm
npm install @kizunasync/vue @kizunasync/core @kizunasync/supabase @kizunasync/web @supabase/supabase-js
```

```bash tab=pnpm
pnpm add @kizunasync/vue @kizunasync/core @kizunasync/supabase @kizunasync/web @supabase/supabase-js
```

```bash tab=yarn
yarn add @kizunasync/vue @kizunasync/core @kizunasync/supabase @kizunasync/web @supabase/supabase-js
```

```bash tab=bun
bun add @kizunasync/vue @kizunasync/core @kizunasync/supabase @kizunasync/web @supabase/supabase-js
```
:::

TypeScript resolves `createKizunaSyncPlugin` from `@kizunasync/vue`. On a native host, swap `@kizunasync/web` for `@kizunasync/expo` and follow [Expo: Installing](../expo/installing.md); the composables are the same package either way.

## Related reference

- [Introduction](./introduction.md)
- [Initializing](./initializing.md)
- [React: Installing](../react/installing.md)
- [Expo: Installing](../expo/installing.md)
- [JavaScript: Installing](../javascript/installing.md)
