// Compiles src/shared/login-forms.ts into the script the Android WebView runs in pages.
// The same file is imported by the desktop content preload, so both behave alike.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const OUTPUT = resolve(root, 'src-tauri/gen/android/app/src/main/assets/login-forms.js')

/** A script that defines `nccLogin` for whatever follows it in the same function. */
export function compileLoginForms() {
  const source = readFileSync(resolve(root, 'src/shared/login-forms.ts'), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, removeComments: true }
  })
  return `var nccLogin = (function () {\nvar exports = {};\n${outputText}\nreturn exports;\n})();\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, compileLoginForms())
  console.log(`Wrote ${OUTPUT}`)
}
