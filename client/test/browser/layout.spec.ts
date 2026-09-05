import { test, expect, Page } from '@playwright/test'

const title = 'Roadside Pleasure'

async function openTrack(page: Page) {
  page.on('pageerror', error => { throw error })
  await page.addInitScript(() => localStorage.setItem('token', 'layout-fixture'))
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname
    const responses: Record<string, unknown> = {
      '/api/auth/me': { user: { id: 'owner', email: 'owner@example.com', role: 'ADMIN' } },
      '/api/tracks/layout-fixture': {
        isOwner: true,
        track: { id: 'layout-fixture', title, status: 'WIP', comment_access: 'PRIVATE',
          current_version_id: 'version', current_version_number: 1, duration_seconds: 166,
          stream_url: '/api/stream/version' },
      },
      '/api/comments/track/layout-fixture': {
        canPost: true, next_cursor: null,
        comments: Array.from({ length: 20 }, (_, index) => ({
          id: `comment-${index}`, user_email: 'owner@example.com',
          body: 'A whole world in little windows. '.repeat(12), created_at: '2026-08-29T12:00:00Z',
        })),
      },
      '/api/tracks/layout-fixture/versions': { versions: [], next_cursor: null },
      '/api/attachments/track/layout-fixture': { attachments: [], next_cursor: null },
      '/api/reactions/track/layout-fixture': { counts: { heart: 0, fire: 0, laugh: 0, cry: 0 }, visitorReaction: null },
    }
    return route.fulfill({ json: responses[pathname] ?? {} })
  })
  await page.goto('/tracks/layout-fixture')
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
}

test('track page and player fit the window while resizing', async ({ page }) => {
  await openTrack(page)
  for (const width of [1920, 1280, 1024, 768, 640, 639, 390, 320, 1280]) {
    await test.step(`${width}px window`, async () => {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => page.evaluate(() => {
        const root = document.documentElement
        const main = document.querySelector('main')!
        const footer = document.querySelector('footer')!
        const bounds = footer.getBoundingClientRect()
        return {
          pageOverflowX: Math.max(0, root.scrollWidth - root.clientWidth),
          pageOverflowY: Math.max(0, root.scrollHeight - root.clientHeight),
          contentOverflowX: Math.max(0, main.scrollWidth - main.clientWidth),
          playerOverflowX: Math.max(0, footer.scrollWidth - footer.clientWidth),
          playerBelowWindow: Math.max(0, Math.round(bounds.bottom - window.innerHeight)),
        }
      })).toEqual({ pageOverflowX: 0, pageOverflowY: 0, contentOverflowX: 0, playerOverflowX: 0, playerBelowWindow: 0 })
      await expect(page.locator('footer').getByRole('button', { name: 'Play', exact: true }).filter({ visible: true })).toBeInViewport()
      await expect(page.getByRole('slider', { name: 'Playback position' }).filter({ visible: true })).toBeInViewport()
      if (width >= 640) {
        const volume = page.getByRole('slider', { name: 'Volume', exact: true }).filter({ visible: true })
        await expect(volume).toBeInViewport({ ratio: 1 })
        await volume.fill('0.3')
        await expect(volume).toHaveValue('0.3')
      }
    })
  }
})
