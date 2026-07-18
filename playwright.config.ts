// Playwright config for the WebGL2 browser tests.
//
// The browser is the system chromium (no downloaded binaries) and the harness is
// loaded straight off disk as a file:// URL, so there is no static server and no
// extra dependency. Headless GL here is SwiftShader software rendering, so these
// tests judge correctness (pixel parity against the Canvas2D reference),
// draw-call counts, atlas upload counts, and relative CPU deltas. They never
// assert absolute frame rates.

import { defineConfig } from '@playwright/test';

const CHROMIUM = process.env.VTGL_CHROMIUM ?? '/usr/bin/chromium';

export default defineConfig({
  testDir: './test-browser',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    launchOptions: {
      executablePath: CHROMIUM,
      args: [
        // Force a working GL stack in headless: ANGLE over SwiftShader.
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-lcd-text',
        '--force-device-scale-factor=1',
      ],
    },
  },
});
