// scripts/indexnow-test.js
//
// One-shot exerciser for the IndexNow submission plumbing. Runs the same
// POST that netlify/plugins/indexnow/index.js makes during onSuccess, but
// against a single test URL instead of the full sitemap. Useful for
// verifying that (a) the env vars are wired up correctly and (b) the
// verification key file at https://<host>/<key>.txt is publicly reachable
// before relying on the build plugin to do it on every deploy.
//
// Usage:
//   node --env-file=.env.local scripts/indexnow-test.js
//
// .env.local must contain:
//   INDEXNOW_API_KEY=<32-char lowercase-hex key matching the .txt verification file>
//   SITE_HOST=<bare host, e.g., aigamma.com>
//
// Exit codes:
//   0  — IndexNow returned 200 OK or 202 Accepted (success)
//   1  — env vars missing
//   2  — IndexNow returned 4xx/5xx; if 403 the key file is not publicly
//        readable at https://<host>/<key>.txt and a deploy carrying the
//        key file is required before this script can succeed
//   3  — fetch threw before getting a response (network/DNS failure)
//
// See docs/indexnow.md for the wider integration.

const ENDPOINT = 'https://api.indexnow.org/indexnow'

const apiKey = process.env.INDEXNOW_API_KEY
const host = process.env.SITE_HOST

if (!apiKey || !host) {
  console.error('FAIL: INDEXNOW_API_KEY and SITE_HOST must be set in .env.local before running this test.')
  console.error(`  INDEXNOW_API_KEY: ${apiKey ? '(set)' : '(missing)'}`)
  console.error(`  SITE_HOST:        ${host ? '(set)' : '(missing)'}`)
  process.exit(1)
}

const testUrl = `https://${host}/`
const keyLocation = `https://${host}/${apiKey}.txt`
const body = JSON.stringify({ host, key: apiKey, keyLocation, urlList: [testUrl] })

console.log(`POST ${ENDPOINT}`)
console.log(`  host:        ${host}`)
console.log(`  keyLocation: ${keyLocation}`)
console.log(`  urlList:     [${testUrl}]`)

let res
try {
  res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body,
  })
} catch (err) {
  console.error(`FAIL: fetch threw before response: ${err.message}`)
  process.exit(3)
}

const text = await res.text().catch(() => '')
console.log(`HTTP ${res.status} ${res.statusText}`)
if (text) console.log(`Response body: ${text}`)

if (res.status === 200 || res.status === 202) {
  console.log('OK: IndexNow accepted the submission.')
  process.exit(0)
}

if (res.status === 403) {
  console.error(
    `FAIL (403): IndexNow could not verify the key. The file at ${keyLocation} is either missing, not publicly readable, or its contents do not match the key. ` +
      `Deploy the site (so the verification file ships at /${apiKey}.txt) and re-run.`
  )
  process.exit(2)
}

console.error(`FAIL (${res.status}): unexpected response from IndexNow.`)
process.exit(2)
