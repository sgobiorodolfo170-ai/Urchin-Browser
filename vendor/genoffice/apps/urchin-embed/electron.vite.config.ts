import { defineConfig } from 'electron-vite'

/**
 * Urchin embedding bundle (main process only).
 *
 * The default electron-vite main behavior is intentional here: electron and the
 * node builtins stay external while everything else is bundled. That is exactly
 * what a foreign host needs, because
 * - every @genoffice/* workspace package ships as raw TypeScript source with
 *   extensionless imports (externalizing breaks Node resolution), and
 * - the host (Urchin Browser) must not be forced to install GenOffice's
 *   third-party main-process dependency tree into its own node_modules.
 *
 * Output: out/main/index.js (CommonJS — this package has no "type": "module"),
 * required by the host at runtime from an absolute path.
 */
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      minify: false,
      sourcemap: false,
    },
  },
})
