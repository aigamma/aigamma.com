// netlify/plugins/indexnow/index.js
//
// Local Netlify Build Plugin that pushes the site's URL list to Bing's
// IndexNow API on every successful production deploy. Parses the sitemap
// the Vite build emits at dist/sitemap.xml, extracts the <loc> entries,
// and POSTs them to https://api.indexnow.org/indexnow in batches of up to
// 10000 URLs per request (the protocol maximum). The IndexNow protocol is
// a unified push notification API that Bing, Yandex, Naver, Seznam, and
// IndexNow.org-aligned engines all consume from a single submission, so
// one POST per deploy reaches every participating index.
//
// Required env vars (set in Netlify UI under Site settings ->
// Environment variables, never in code or netlify.toml):
//   INDEXNOW_API_KEY — the 32-character lowercase-hex key that matches the
//                      verification file at https://aigamma.com/<key>.txt
//   SITE_HOST        — the bare host, e.g., aigamma.com
//
// Failure semantics: any non-2xx response from api.indexnow.org marks the
// deploy as failed via utils.build.failPlugin, which surfaces the failure
// in the Netlify deploy log and prevents an IndexNow regression from
// going silently unnoticed. Disable the plugin by commenting out the
// [[plugins]] block in netlify.toml; the deploy completes normally with
// no IndexNow side effects.
//
// See docs/indexnow.md for the wider integration, verification flow, and
// Bing Webmaster Tools IndexNow Insights monitoring procedure.

import { promises as fs } from 'node:fs'
import path from 'node:path'

const ENDPOINT = 'https://api.indexnow.org/indexnow'
const BATCH_SIZE = 10000

export const onSuccess = async ({ utils, constants }) => {
  const apiKey = process.env.INDEXNOW_API_KEY
  const host = process.env.SITE_HOST

  if (!apiKey) {
    return utils.build.failPlugin(
      'INDEXNOW_API_KEY env var is not set. Configure it under Netlify Site settings -> Environment variables.'
    )
  }
  if (!host) {
    return utils.build.failPlugin(
      'SITE_HOST env var is not set. Configure it under Netlify Site settings -> Environment variables (value should be the bare host, e.g., aigamma.com).'
    )
  }

  const publishDir = constants.PUBLISH_DIR
  if (!publishDir) {
    return utils.build.failPlugin('Netlify constants.PUBLISH_DIR is empty; cannot locate sitemap.xml.')
  }

  const sitemapPath = path.join(publishDir, 'sitemap.xml')
  let sitemapXml
  try {
    sitemapXml = await fs.readFile(sitemapPath, 'utf-8')
  } catch (err) {
    return utils.build.failPlugin(
      `Could not read sitemap at ${sitemapPath}: ${err.message}. Verify the Vite build emitted dist/sitemap.xml (sitemapPlugin in vite.config.js).`
    )
  }

  const urls = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()).filter(Boolean)
  if (urls.length === 0) {
    return utils.build.failPlugin(`Sitemap at ${sitemapPath} contains zero <loc> entries.`)
  }

  const keyLocation = `https://${host}/${apiKey}.txt`
  const batchCount = Math.ceil(urls.length / BATCH_SIZE)

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const body = JSON.stringify({ host, key: apiKey, keyLocation, urlList: batch })

    let res
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body,
      })
    } catch (err) {
      return utils.build.failPlugin(`IndexNow request to ${ENDPOINT} threw: ${err.message}`)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return utils.build.failPlugin(
        `IndexNow batch ${batchNum}/${batchCount} returned ${res.status} ${res.statusText}. Response body: ${text || '(empty)'}. ` +
          `A 403 typically means the key file at ${keyLocation} is not publicly readable; verify the file exists in the publish directory and re-deploy.`
      )
    }

    console.log(`[indexnow] batch ${batchNum}/${batchCount}: submitted ${batch.length} URLs (HTTP ${res.status})`)
  }

  console.log(`[indexnow] Successfully submitted ${urls.length} URLs in ${batchCount} batch(es) to ${ENDPOINT}.`)
}
