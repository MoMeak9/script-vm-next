import { readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const version = await readFile(new URL('src/version.ts', root), 'utf8')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('Invalid release version')
if (version.match(/export const VERSION = ['"]([^'"]+)['"]/)?.[1] !== pkg.version) {
  throw new Error('package.json and src/version.ts versions must match')
}
if (pkg.private || !pkg.license || pkg.license === 'UNLICENSED') {
  throw new Error('Choose and approve the project license before publishing to npm')
}
await access(fileURLToPath(new URL('LICENSE', root)))
if (!pkg.repository?.url || !pkg.exports?.['.'] || !pkg.exports?.['./core']) {
  throw new Error('Release requires repository metadata and both public entry points')
}
const tag = pkg.version.includes('-') ? 'beta' : 'latest'
console.log(`Release metadata valid: ${pkg.name}@${pkg.version}, npm dist-tag ${tag}`)
console.log('Publish only the tarball that passed the package and browser checks.')
