import { test, expect } from '@playwright/test';

test('QC-B1 질문함은 32세션의 sync·async 최대 2048항목을 받고 상한 초과는 마지막 목록을 보존한다', async ({ page }) => {
  await page.clock.install();
  await page.route('**/question-limit-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('/question-limit-fixture');
  await page.evaluate(async () => {
    const modulePath = '/src/question-center.ts';
    const { createQuestionCenter } = await import(modulePath);
    const languagePath = '/src/i18n.ts'; const { setLanguage } = await import(languagePath); setLanguage('ko');
    const items = Array.from({ length: 32 }, (_, session) => Array.from({ length: 64 }, (_, index) => {
      const id = index < 32 ? `rpc-${index}` : JSON.stringify(['request_user_input_async', `call-${index}`, 0]);
      return { id, requestId: id, sessionId: `session-${session}`, generation: 1, kind: index < 32 ? 'approval' : 'question',
        source: index < 32 ? 'request' : 'async', canRespond: false, approval: index < 32 ? { options: [] } : undefined,
        questions: index < 32 ? undefined : [{ id, question: '질문 원문' }] };
    })).flat();
    const state = (window as any).questionLimits = { items };
    const widget = createQuestionCenter({ openSession() {}, async call() { return { items: state.items, complete: true }; } });
    document.body.append(widget.button, widget.element);
  });
  await expect(page.locator('#question-count')).toHaveText('2048');
  await expect(page.locator('.question-item')).toHaveCount(2048);
  await page.evaluate(() => { const f = (window as any).questionLimits; f.items.push({ ...f.items[0], id: 'overflow', requestId: 'overflow' }); });
  await page.clock.runFor(3_000);
  await page.getByRole('button', { name: /^질문함 ·/ }).click();
  await expect(page.locator('.question-list-status')).toContainText('이전 목록을 유지');
  await expect(page.locator('#question-count')).toHaveText('2048');
  await expect(page.locator('.question-item')).toHaveCount(2048);
});
