// Scans fixture.html with axe Watcher so run-devhub-action has known violations
// to report. It used to scan a third-party site, which went violation-free.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import {
  playwrightConfig,
  PlaywrightController,
  wrapPlaywrightPage
} from '@axe-core/watcher/playwright'

const { API_KEY, PROJECT_ID, SERVER_URL } = process.env
const html = await readFile(new URL('./fixture.html', import.meta.url))
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' }).end(html)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

const context = await chromium.launchPersistentContext(
  '',
  playwrightConfig({
    axe: { apiKey: API_KEY, projectId: PROJECT_ID, serverURL: SERVER_URL },
    // Branded Chrome ignores --load-extension, which axe Watcher needs.
    executablePath: chromium.executablePath(),
    headless: false,
    args: ['--headless=new']
  })
)
try {
  const rawPage = await context.newPage()
  const controller = new PlaywrightController(rawPage)
  const page = wrapPlaywrightPage(rawPage, controller)
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await controller.analyze()
  await controller.flush()
} finally {
  await context.close()
  server.close()
}
