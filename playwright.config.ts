import { defineConfig } from '@playwright/test';

const bundled = process.env.AGENT_GRID_BUNDLED_FRONTEND_TEST === '1';
const sourceOnly = process.env.AGENT_GRID_SOURCE_FIXTURES_ONLY === '1';
if (bundled && sourceOnly) throw new Error('Choose bundled UI or source fixtures, not both.');

// These fixtures import source modules or intercept Vite module responses.
// Keep mixed files together so their fault-injection paths remain available.
const sourceFixtures = [
  'context-capabilities', 'context-controls', 'conversation-integration',
  'conversation', 'cron-manager', 'external-links', 'link-drag',
  'project-management', 'project-switch-scroll', 'project-tabs',
  'question-center-limits', 'question-center', 'saved-cron', 'startup-runtime',
  'subagent-manager', 'terminal-flow', 'weekly-usage',
].map(name => `**/${name}.spec.ts`);

export default defineConfig({
  testDir: './tests',
  testMatch: sourceOnly ? sourceFixtures : undefined,
  testIgnore: bundled ? sourceFixtures : undefined,
  workers: 1,
  outputDir: process.env.AGENT_GRID_TEST_OUTPUT ?? 'test-results',
  use: { baseURL: 'http://127.0.0.1:1420', viewport: { width: 1440, height: 1000 }, channel: process.env.PLAYWRIGHT_CHANNEL, trace: 'retain-on-failure' },
  webServer: {
    command: bundled ? 'npm run preview -- --host 127.0.0.1 --port 1420 --strictPort' : 'npm run dev',
    url: 'http://127.0.0.1:1420', reuseExistingServer: !process.env.CI,
  },
});
