/**
 * Drive vue-tsc with this package's TypeScript 6, not the hoisted root 7.
 * vue-tsc calls require.resolve('typescript/lib/tsc'); TS 7 does not export
 * that path. Must run under Node: volar patches fs.readFileSync around tsc.
 */
const { createRequire } = require('node:module')
const path = require('node:path')

const fromPkg = createRequire(path.join(__dirname, '..', 'package.json'))
const { run } = fromPkg('vue-tsc')

run(fromPkg.resolve('typescript/lib/tsc.js'))
