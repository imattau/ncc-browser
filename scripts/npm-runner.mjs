import { execFileSync } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/**
 * Runs an npm subcommand in `cwd`. Prefers the npm that invoked the current script
 * (`npm_execpath`, run via this process's own node, both absolute paths so no PATH
 * lookup is needed), but falls back to a plain `npm`/`npm.cmd` lookup if that path isn't
 * actually runnable here — `npm_execpath` can be stale (e.g. inherited from a different
 * environment than this process is actually sandboxed into), in which case failing
 * outright would be wrong even though the fallback works fine. The fallback goes
 * through a shell even on POSIX: `execFileSync` resolves a bare command name itself
 * rather than asking the shell, and that resolution can miss a PATH entry (e.g. an nvm
 * shim) that an interactive shell finds without trouble.
 */
export function runNpm(cwd, args) {
  const npmCli = process.env.npm_execpath
  if (npmCli) {
    try {
      return execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit' })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return execFileSync(npm, args, { cwd, stdio: 'inherit', shell: true })
}
