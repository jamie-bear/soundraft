import { test, expect, Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import path from 'node:path'

const email = process.env.E2E_EMAIL || 'browser@example.com'
const password = process.env.E2E_PASSWORD || 'browser-only-password'
async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
}
async function fixture(page: Page) {
  const token = await page.evaluate(() => localStorage.getItem('token'))
  expect(Boolean(token)).toBeTruthy()
  const headers = { Authorization: `Bearer ${token}` }
  const response = await page.request.post('/api/tracks', { headers, data: { title: `Browser fixture ${Date.now()}` } })
  expect(response.ok()).toBeTruthy()
  return { headers, track: (await response.json()).track }
}

test('owner upload, playback, seeking and draft recovery', async ({ page, context }) => {
  await login(page)
  const { track } = await fixture(page)
  await page.goto(`/tracks/${track.id}`)
  await page.getByRole('button', { name: 'Upload cover art' }).focus()
  await expect(page.getByRole('button', { name: 'Upload cover art' })).toBeFocused()
  await page.locator('input[type=file][accept*="audio"]').setInputFiles(path.resolve('../server/seed-data/example-track.wav'))
  await expect(page.getByRole('button', { name: 'Cancel upload' })).toBeHidden({ timeout: 30_000 })
  await expect(page.getByText('Processing and saving…')).toBeHidden()
  const playable = page.waitForResponse(r => r.url().includes('/api/stream/') && r.status() === 206)
  await page.getByRole('button', { name: 'Play', exact: true }).first().click()
  await playable
  await expect(page.getByRole('button', { name: 'Pause', exact: true }).first()).toBeVisible()
  const slider = page.getByRole('slider', { name: 'Playback position' }).filter({ visible: true })
  await slider.fill('0.4')
  await context.setOffline(true)
  await expect(page.getByText('You are offline. Reconnect and retry playback.')).toBeVisible()
  await context.setOffline(false)
  await page.getByRole('button', { name: 'Retry playback' }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true }).first()).toBeVisible()
  await page.getByLabel('Comment', { exact: true }).fill('Keep this draft')
  await page.route('**/api/comments/track/*', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Temporarily unavailable"}' }) : route.continue())
  await page.getByRole('button', { name: 'Post', exact: true }).click()
  await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('Keep this draft')
  await page.route('**/api/stream/**', route => route.fulfill({ status: 503, body: 'Storage unavailable' }))
  await slider.fill('0.5')
  await expect(page.getByText('Audio could not load. Check your connection and retry.')).toBeVisible()
  await page.unroute('**/api/stream/**')
  await page.getByRole('button', { name: 'Retry playback' }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true }).first()).toBeVisible()

  let heldUpload: import('@playwright/test').Route | undefined
  await page.route('**/api/tracks/*/versions', route => {
    if (route.request().method() === 'POST') heldUpload = route
    else void route.continue()
  })
  await page.locator('input[type=file][accept*="audio"]').setInputFiles(path.resolve('../server/seed-data/example-track.wav'))
  await expect.poll(() => Boolean(heldUpload)).toBeTruthy()
  await page.getByRole('button', { name: 'Cancel upload' }).click()
  await expect(page.getByRole('button', { name: 'Cancel upload' })).toBeHidden()
  await heldUpload!.abort().catch(() => {})
  await expect(page.getByLabel('Comment', { exact: true })).toHaveValue('Keep this draft')

})

test('visitor playlist playback renews and revoked sharing cannot renew', async ({ page, browser }) => {
  await login(page)
  const { track, headers } = await fixture(page)
  const upload = await page.request.post(`/api/tracks/${track.id}/versions`, { headers, multipart: {
    audio: { name: 'fixture.wav', mimeType: 'audio/wav', buffer: await (await import('node:fs/promises')).readFile(path.resolve('../server/seed-data/example-track.wav')) },
  } })
  expect(upload.ok()).toBeTruthy()
  const created = await page.request.post('/api/playlists', { headers, data: { title: 'Visitor playlist' } })
  const { playlist } = await created.json()
  expect((await page.request.post(`/api/playlists/${playlist.id}/tracks`, { headers, data: { trackId: track.id } })).ok()).toBeTruthy()
  const share = await page.request.post(`/api/playlists/${playlist.id}/share`, { headers, data: { makePublic: true } })
  const { shareToken } = await share.json()
  const visitor = await browser.newContext({ baseURL: new URL(page.url()).origin })
  const guest = await visitor.newPage()
  try {
    await guest.goto(new URL(`/share/playlist/${shareToken}`, page.url()).href)
    // The gate deliberately uses a 5s grant; exercise a queue older than its TTL.
    await guest.waitForTimeout(6000)
    const renewal = guest.waitForResponse(r => r.url().endsWith('/api/media/renew'))
    const audio = guest.waitForResponse(r => r.url().includes('/api/stream/') && r.status() === 206)
    await guest.getByRole('button', { name: /play/i }).first().click()
    expect((await renewal).status()).toBe(200)
    await audio
    await expect(guest.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    expect((await guest.request.get(`/api/tracks/${track.id}`)).status()).toBe(401)
    await page.request.post(`/api/playlists/${playlist.id}/share`, { headers, data: { makePublic: false } })
    await guest.getByRole('slider', { name: 'Playback position' }).filter({ visible: true }).fill('0.6')
    await expect(guest.getByText(/Access to this audio has expired or was revoked/)).toBeVisible()
  } finally { await visitor.close() }
})

test('first library page is bounded, mobile navigation and accessibility', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  const calls: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/tracks') calls.push(request.url()) })
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('link', { name: 'Tracks', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Tracks', exact: true })).toBeVisible()
  await expect.poll(() => calls.length).toBe(1)
  expect(new URL(calls[0]).searchParams.get('limit')).toBe('50')
  const scan = await new AxeBuilder({ page }).analyze()
  expect(scan.violations.filter(v => ['serious', 'critical'].includes(v.impact || '')).map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([])
})

test('session expiry redirects while a database outage preserves credentials', async ({ page }) => {
  await login(page)
  await page.route('**/api/auth/me', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Temporarily unavailable"}' }))
  await page.reload()
  await expect(page.getByRole('button', { name: /retry/i })).toBeVisible()
  expect(await page.evaluate(() => Boolean(localStorage.getItem('token')))).toBeTruthy()
  await page.unroute('**/api/auth/me')
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Session expired"}' }))
  await page.reload()
  await expect(page).toHaveURL(/\/login/)
})
