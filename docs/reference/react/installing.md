---
title: Installing
description: Install the React bindings and the packages that build the client they read.
status: alpha
docType: reference
library: react
pageKind: installing
audience: app-developer
---

# React: Installing

`@kizunasync/react` carries one dependency, `@kizunasync/core`, and declares [React](https://react.dev) 19 or later as a peer. The other packages build the client the hooks read: `@kizunasync/core` holds the engine and the config helpers, `@kizunasync/supabase` composes the client over [Supabase](https://supabase.com), and `@kizunasync/web` is the browser driver. [`@supabase/supabase-js`](https://supabase.com/docs/reference/javascript/installing) is Supabase's JavaScript client, which `@kizunasync/supabase` takes as a peer and `src/supabase-client.ts` creates.

## Install from npm

:::tabs{group=pm}
```bash tab=npm
npm install @kizunasync/react @kizunasync/core @kizunasync/supabase @kizunasync/web @supabase/supabase-js
```

```bash tab=pnpm
pnpm add @kizunasync/react @kizunasync/core @kizunasync/supabase @kizunasync/web @supabase/supabase-js
```

```bash tab=yarn
yarn add @kizunasync/react @kizunasync/core @kizunasync/supabase @kizunasync/web @supabase/supabase-js
```

```bash tab=bun
bun add @kizunasync/react @kizunasync/core @kizunasync/supabase @kizunasync/web @supabase/supabase-js
```
:::

TypeScript resolves `KizunaSyncProvider` from `@kizunasync/react`. On a native host, swap `@kizunasync/web` for `@kizunasync/expo` and follow [Expo: Installing](../expo/installing.md); the hooks are the same package either way.

## Related reference

- [Introduction](./introduction.md)
- [Initializing](./initializing.md)
- [Vue: Installing](../vue/installing.md)
- [Expo: Installing](../expo/installing.md)
- [JavaScript: Installing](../javascript/installing.md)
