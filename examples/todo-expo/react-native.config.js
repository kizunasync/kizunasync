const path = require('node:path')

/**
 * In the monorepo the native module's source lives in `packages/rn-uniffi`,
 * so Expo autolinking needs this pin to find its ios/android projects.
 */
module.exports = {
  dependencies: {
    '@kizunasync/rn-uniffi': {
      root: path.join(__dirname, '../../packages/rn-uniffi'),
    },
  },
}
