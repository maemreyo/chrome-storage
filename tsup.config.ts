import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'react/index': 'src/react/index.ts',
      'adapters/index': 'src/adapters/index.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    splitting: true,
    clean: true,
    treeshake: true,
    minify: true,
    sourcemap: true,
    external: ['react', 'react-dom', 'chrome'],
    esbuildOptions(options) {
      options.banner = {
        js: '"use client"',
      }
      options.platform = 'browser'
      options.target = 'es2020'
    },
    onSuccess: 'echo "✅ Storage module build completed successfully!"'
  },
])