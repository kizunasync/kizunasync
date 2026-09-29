const path = require('node:path')

/** Pin the monorepo Turbo Module so Expo autolinking finds ios/android. */
module.exports = {
  dependencies: {
    '@kizunasync/rn-uniffi': {
      root: path.join(__dirname, '../../packages/rn-uniffi'),
    },
  },
}
