import fs from 'node:fs'
import { gzipSync } from 'node:zlib'
const root = new URL('../dist/', import.meta.url)
const html = fs.readFileSync(new URL('index.html', root), 'utf8')
const assets = new Set([...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(match => match[1]))
const manifest = JSON.parse(fs.readFileSync(new URL('.vite/manifest.json', root), 'utf8'))
const visited = new Set()
function include(key) {
  if (visited.has(key)) return
  visited.add(key)
  const chunk = manifest[key]
  if (!chunk) throw new Error(`Missing bundle manifest entry: ${key}`)
  if (chunk.file.endsWith('.js')) assets.add('/' + chunk.file)
  for (const dependency of chunk.imports || []) include(dependency)
}
// Include the useful authenticated first route and its static dependencies.
include('src/pages/Dashboard.tsx')
let bytes = 0
for (const asset of assets) bytes += gzipSync(fs.readFileSync(new URL(asset.replace(/^\//, ''), root))).length
const budget = Number(process.env.INITIAL_JS_GZIP_BUDGET || 94960) // 20% below the reviewed 118.7 kB baseline
console.log(JSON.stringify({ initial_js_gzip_bytes: bytes, budget_bytes: budget }))
if (!assets.size || bytes > budget) process.exitCode = 1
