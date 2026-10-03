/**
 * Dynamic Expo config, the sole source of truth for the Expo manifest.
 *
 * The monorepo keeps env files at the repo root. This file loads `.env` then
 * `.env.local` from there before reading process.env. EXPO_PUBLIC_* vars are
 * also injected into the app bundle (Constants.expoConfig.extra);
 * TODO_EXPO_APPLE_TEAM_ID stays server/build-time only.
 *
 * Caveat: if you run `expo start --no-dev` or a CI that does not source
 * those files, set the vars in the environment directly before calling expo.
 */

const fs = require('node:fs')
const path = require('node:path')

/**
 * Parse one KEY=VALUE line from an env file: a blank line or a comment parses
 * to null, and a fully quoted value ("..." or '...') has its quotes stripped.
 */
function parseEnvLine(line) {
  const trimmed = line.trim()

  if (trimmed.length === 0 || trimmed.startsWith('#')) {
    return null
  }
  const separator = trimmed.indexOf('=')

  if (separator === -1) {
    return null
  }
  const key = trimmed.slice(0, separator).trim()
  let value = trimmed.slice(separator + 1).trim()
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))

  if (quoted) {
    value = value.slice(1, -1)
  }
  return { key, value }
}

/**
 * Apply one env file's KEY=VALUE lines to process.env, skipping a key already
 * in `preset` so `.env.local` overriding `.env` never fights a variable the
 * caller set explicitly.
 */
function loadEnvFile(file, preset) {
  if (!fs.existsSync(file)) {
    return
  }
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const parsed = parseEnvLine(line)

    if (parsed === null || preset.has(parsed.key)) {
      continue
    }
    process.env[parsed.key] = parsed.value
  }
}

function applyRootEnv() {
  const repoRoot = path.resolve(__dirname, '../..')
  const preset = new Set(Object.keys(process.env))

  for (const name of ['.env', '.env.local']) {
    loadEnvFile(path.join(repoRoot, name), preset)
  }
}

applyRootEnv()

/** @type {import('@expo/config').ConfigContext} */
module.exports = () => {
  // MARK: - Env vars
  const supabaseUrl = process.env.EXPO_PUBLIC_TODO_EXPO_SUPABASE_URL ?? 'http://127.0.0.1:55321'
  const supabasePublishableKey =
    process.env.EXPO_PUBLIC_TODO_EXPO_SUPABASE_PUBLISHABLE_KEY ??
    process.env.EXPO_PUBLIC_TODO_EXPO_SUPABASE_ANON_KEY ??
    ''
  const turnstileSiteKey = process.env.EXPO_PUBLIC_TODO_EXPO_TURNSTILE_SITE_KEY ?? ''

  // Build the ios object conditionally: omit appleTeamId entirely when not set so EAS / Xcode uses its own resolution rather than receiving undefined.
  const appleTeamId = process.env.TODO_EXPO_APPLE_TEAM_ID
  const ios = {
    supportsTablet: true,
    bundleIdentifier: 'com.kizunasync.demo',
    ...(appleTeamId !== undefined ? { appleTeamId } : {}),
  }

  return {
    expo: {
      name: 'Kizuna Todo Offline',
      slug: 'kizunasync-todo-offline',
      // Kept numeric on purpose: Expo maps this to CFBundleShortVersionString, which Apple requires numeric.
      version: '0.1.0',
      orientation: 'portrait',
      scheme: 'kizuna-todo',
      userInterfaceStyle: 'dark',
      ios,
      android: {
        // Android package names cannot contain hyphens (must be valid Java identifiers), so the iOS 'com.kizunasync.demo' becomes this.
        package: 'com.kizunasync.exampletodo',
      },
      plugins: [
        'expo-router',
        'expo-sqlite',
        'expo-secure-store',
        'expo-status-bar',
        // iOS 27 terminates an app that does not adopt the UIKit scene life cycle; SDK 57 opts in through this property and SDK 58 includes it.
        ['expo-build-properties', { ios: { enableSceneSupport: true } }],
      ],
      extra: {
        supabaseUrl,
        supabasePublishableKey,
        turnstileSiteKey,
      },
    },
  }
}
