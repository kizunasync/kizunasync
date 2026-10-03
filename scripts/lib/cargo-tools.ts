import { delimiter, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')

/** Absolute path to cargo subcommand plugins installed with `cargo install --root .cargo-tools`. */
export function cargoToolsBin(): string {
  return resolve(REPO_ROOT, '.cargo-tools/bin')
}

/** Copy of `env` with the `.cargo-tools/bin` plugin directory prepended to `PATH`. */
export function withCargoToolsOnPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PATH: `${cargoToolsBin()}${delimiter}${env.PATH ?? ''}` }
}
