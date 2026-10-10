import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir:'.',
  testMatch:['guide.spec.ts'],
  timeout:60000,
  fullyParallel:false,
  workers:1,
  expect:{timeout:12000},
  reporter:[['list']],
  use:{
    baseURL:'http://127.0.0.1:4321',
    actionTimeout:12000,
    navigationTimeout:20000,
    trace:'retain-on-failure',
    screenshot:'only-on-failure'
  },
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
  webServer:{
    cwd:'../..',
    command:'pnpm exec vite preview --config prototypes/motion-learning-preview/vite.config.ts --host 127.0.0.1 --port 4321',
    url:'http://127.0.0.1:4321/',
    reuseExistingServer:false,
    timeout:90000,
    stdout:'pipe',
    stderr:'pipe'
  }
})
