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

`@kizunasync/react` carries one dependency, `@kizunasync/core`, and declares [React](https://react.dev) 19 or later as a peer. The other three packages build the client the hooks read: the engine and config helpers, the [Supabase](https://supabase.com) composition, and the browser driver.

## Install from npm

:::tabs{group=pm}
```bash tab=npm
npm install @kizunasync/react @kizunasync/core @kizunasync/supabase @kizunasync/web
```

```bash tab=pnpm
pnpm add @kizunasync/react @kizunasync/core @kizunasync/supabase @kizunasync/web
```

```bash tab=yarn
yarn add @kizunasync/react @kizunasync/core @kizunasync/supabase @kizunasync/web
```

```bash tab=bun
bun add @kizunasync/react @kizunasync/core @kizunasync/supabase @kizunasync/web
```
:::

TypeScript resolves `KizunaSyncProvider` from `@kizunasync/react`. On a native host, swap `@kizunasync/web` for `@kizunasync/expo` and follow [Expo: Installing](../expo/installing.md); the hooks are the same package either way.

## Related reference

- [Introduction](./introduction.md)
- [Initializing](./initializing.md)
- [Vue: Installing](../vue/installing.md)
- [Expo: Installing](../expo/installing.md)
- [JavaScript: Installing](../javascript/installing.md)
