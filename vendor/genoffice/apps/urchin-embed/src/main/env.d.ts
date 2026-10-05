/**
 * Type shims required by the slides main-process graph imported transitively
 * through `createSlidesView` / `slidesIsDirty` / `requestSlidesClose`.
 *
 * Kept local to the embed (instead of including `../slides/src/main/env.d.ts`
 * verbatim) because that file also declares a minimal `bidi-js` module that
 * would clash with the richer `packages/pdf2docx/src/bidi-js.d.ts` already in
 * this tsconfig's include list. Only the two shims slides needs that pdf2docx
 * does not already provide live here: the `?asset` suffix and harfbuzzjs'
 * deep-path factory.
 */

/** electron-vite main-process asset import: ?asset copies the file into the bundle and returns its runtime path */
declare module '*?asset' {
  const path: string
  export default path
}

/** harfbuzzjs low-level Emscripten factory (deep-path import; the wrapper has a top-level await and cannot go into a CJS bundle) */
declare module '*/harfbuzzjs/dist/harfbuzz.js' {
  function createHarfBuzz(moduleArg?: Record<string, unknown>): Promise<unknown>
  export default createHarfBuzz
}
