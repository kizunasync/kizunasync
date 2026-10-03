/**
 * The Tailwind entry is consumed by Metro (via Uniwind), not by tsc:
 * `import '../global.css'` exists to put the file in the bundle graph and has no
 * module shape to describe. Uniwind's own `className` augmentations live in the
 * generated `uniwind-types.d.ts`, which this file deliberately does not touch.
 */
declare module '*.css' {}
