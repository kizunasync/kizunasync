/** Lets a docs block import a `.vue` file: plain tsc cannot read a single-file component, so each one types as a plain `DefineComponent`. */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}
