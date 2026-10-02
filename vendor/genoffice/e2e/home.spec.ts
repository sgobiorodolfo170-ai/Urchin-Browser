import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test.describe('home screen', () => {
  test('shows hero, quick-create cards and tab bar', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'home-basics' })
    const { page } = launched
    try {
      await expect(page.locator('.home-hero')).toBeVisible()
      // six AI quick-create cards plus the "Open file" browse card
      await expect(page.locator('.quick-card')).toHaveCount(7)
      // the "Open file" browse card sits first in the row
      await expect(page.locator('.quick-card').first()).toContainText('Open Local File')
      // the six AI format cards follow in stable order
      await expect(page.locator('.quick-card', { hasText: 'AI Docs' })).toBeVisible()
      await expect(page.locator('.quick-card', { hasText: 'AI Sheets' })).toBeVisible()
      await expect(page.locator('.quick-card', { hasText: 'AI Slides' })).toBeVisible()
      await expect(page.locator('.quick-card', { hasText: 'AI Markdown' })).toBeVisible()
      await expect(page.locator('.quick-card', { hasText: 'AI HTML' })).toBeVisible()
      await expect(page.locator('.quick-card', { hasText: 'AI PDF' })).toBeVisible()
      await expect(page.locator('.tab-bar .tab-item.tab-home')).toBeVisible()
      await page.screenshot({ path: screenshotPath('home-overview') })
    } finally {
      await closeAndSaveVideo(launched, 'home-basics')
    }
  })

  test('renders localized UI when GENOFFICE_LANG=zh-CN', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      lang: 'zh-CN',
      videoDir: 'home-zh-cn',
    })
    const { page } = launched
    try {
      await expect(page.locator('.nav-item .nav-label').first()).toHaveText('最近')
      await page.screenshot({ path: screenshotPath('home-zh-cn') })
    } finally {
      await closeAndSaveVideo(launched, 'home-zh-cn')
    }
  })
})
