// Copies CodeGraph's platform library into the packaged app's resources. It has to be done here:
// electron-builder strips nested node_modules (CodeGraph's grammars live in one) from every file set.
const { cpSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName
  const arch = ARCH[context.arch]
  const src = join(__dirname, '..', 'node_modules', '@colbymchenry', `codegraph-${platform}-${arch}`, 'lib')
  if (!existsSync(src)) throw new Error(`CodeGraph bundle for ${platform}-${arch} is not installed (${src})`)
  const resources =
    platform === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources')
  cpSync(src, join(resources, 'codegraph', 'lib'), { recursive: true })
}
