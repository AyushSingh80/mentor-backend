/**
 * CSS module declarations.
 *
 * The Expo template imports `global.css` and a `.module.css` for the web
 * target, but ships no type declarations for them, so a clean `tsc --noEmit`
 * fails out of the box. These make the typecheck honest without changing
 * runtime behaviour.
 */

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.css';
