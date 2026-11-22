import tseslint from 'typescript-eslint'
import importX from 'eslint-plugin-import-x'

/**
 * Boundary lint for the modularity work.
 *
 * Only structural rules are enabled: this is not a style config and it does not
 * duplicate `tsc`. The point is to keep the process boundaries honest while the
 * remaining large modules are split up:
 *
 *   shared/   platform-neutral, imported by main, preload and renderer
 *   main/     Node + Electron
 *   preload/  a thin bridge, no renderer or main code
 *   renderer/ browser only, reaches main through `window.ncc`
 */
export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'dist-*/**',
      'node_modules/**',
      'resources/**',
      'release/**',
      'target/**',
      'vendor/**',
      'mobile/**',
      'src-tauri/**',
      'site-publisher/**',
      'website/**',
      'publisher/**',
      'crates/**',
      'packages/**',
      '.android-toolchain/**'
    ]
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Boundary rules need resolution, not type information; keeping the parser
        // project-free makes `npm run lint` fast enough to run on every change.
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'import-x': importX
    },
    settings: {
      'import-x/resolver': {
        typescript: {
          project: ['./tsconfig.eslint.json']
        }
      },
      // ModuleInfo only analyses files with a known extension; without `.ts` the
      // no-cycle rule resolves a TS import and then silently skips it.
      'import-x/extensions': ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.json']
    },
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/shared',
              from: './src/main',
              message: 'src/shared is loaded by every process; keep it platform-neutral.'
            },
            {
              target: './src/shared',
              from: './src/preload',
              message: 'src/shared is loaded by every process; keep it platform-neutral.'
            },
            {
              target: './src/shared',
              from: './src/renderer',
              message: 'src/shared is loaded by every process; keep it platform-neutral.'
            },
            {
              target: './src/main',
              from: './src/renderer',
              message: 'The main process must not import renderer code.'
            },
            {
              target: './src/renderer',
              from: './src/main',
              message: 'The renderer reaches main through window.ncc, never by importing it.'
            },
            {
              target: './src/preload',
              from: './src/renderer',
              message: 'The preload bridge must not import renderer code.'
            },
            {
              target: './src/preload',
              from: './src/main',
              message: 'The preload bridge must not import main-process code.'
            }
          ]
        }
      ],
      'import-x/no-cycle': ['error', { maxDepth: 4 }],
      'max-lines': ['warn', { max: 1200, skipBlankLines: true, skipComments: true }]
    }
  },
  {
    // `shared/` may not reach for Electron or Node built-ins; it runs in the renderer too.
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'src/shared runs in every process and must not use Electron.' }
          ],
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'fs/*',
                'path',
                'os',
                'crypto',
                'child_process',
                'http',
                'https',
                'net',
                'stream',
                'util',
                'events',
                'worker_threads'
              ],
              message: 'src/shared runs in the renderer as well; use a web API or keep the code in src/main.'
            }
          ]
        }
      ]
    }
  }
)
