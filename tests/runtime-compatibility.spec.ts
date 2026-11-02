import { test, expect, type Page } from '@playwright/test';

async function openSettings(page: Page, hold = false) {
  await page.addInitScript(({ hold }) => {
    const state = window as any; state.isTauri = true;
    state.compatibilityFixture = { calls: [], reply: { executable: 'D:\\tools\\codex.exe', cliVersion: 'codex-cli 0.2.0', selectedServerExecutable: 'D:\\next\\codex-server.exe', selectedServerVersion: '0.3.0', serverState: 'running', serverVersion: '0.1.0', subagents: false, compactIfIdle: null, expectedTurnInterrupt: null }, release: () => {} };
    state.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback() {}, async invoke(command: string, args: any = {}) {
      const fixture = state.compatibilityFixture; fixture.calls.push({command,args});
      if(command.startsWith('plugin:event|')) return 1;
      if(command === 'get_ui_language') return 'ko';
      if(command === 'set_ui_language') return {};
      if(command === 'load_layout') return {version:1,columns:2,sessions:[]};
      if(command === 'list_projects' || command === 'list_sessions') return [];
      if(command === 'get_codex_settings') return {savedPath:null,resolvedPath:'D:\\tools\\codex.exe',source:'path',error:null,appServer:{savedPath:null,resolvedPath:'D:\\next\\codex-server.exe',source:'sibling',error:null,kind:'standalone'}};
      if(command === 'runtime_compatibility') { if(hold) await new Promise<void>(resolve => {fixture.release=resolve;}); return fixture.reply; }
      return null;
    }};
  }, {hold});
  await page.goto('/'); await expect(page.locator('#app')).toHaveAttribute('aria-busy','false');
  await page.locator('#settings-open').click(); await page.locator('#codex-settings-open').click();
}

test('선택 명령줄과 서버 후보와 실행 중 서버의 경로·버전을 구분하고 조회 외 명령을 보내지 않는다', async ({page}) => {
  await openSettings(page);
  expect(await page.evaluate(() => (window as any).compatibilityFixture.calls.filter((c:any) => c.command==='runtime_compatibility').length)).toBe(0);
  await page.locator('.compatibility-refresh').click();
  await expect(page.locator('.compatibility-details')).toContainText('codex-cli 0.2.0');
  await expect(page.locator('.compatibility-details')).toContainText('0.1.0');
  await expect(page.locator('.compatibility-details dt')).toHaveText(['선택한 명령줄 실행 파일','선택한 명령줄 버전','서버 후보 실행 파일','서버 후보 버전','실제 실행 중인 서버 실행 파일','기존 연결에서 보고한 서버 버전','서브에이전트 관리','안전한 유휴 압축','지정 작업만 중단']);
  await expect(page.locator('.compatibility-details dd')).toHaveText(['D:\\tools\\codex.exe','codex-cli 0.2.0','D:\\next\\codex-server.exe','0.3.0','미확인','0.1.0','지원되지 않음','미확인','미확인']);
  await expect(page.locator('.compatibility-help')).toContainText('실행 중인 서버는 바뀌지');
  await expect(page.locator('.compatibility-scope')).toContainText('버전이 같아도 출처·파일 해시·실행 세대를 확인하기 전에는 같은 패키지로 확정하지 않습니다');
  await page.locator('#codex-settings-close').click();
  await page.locator('#language-select').selectOption('en');
  await page.locator('#codex-settings-open').click(); await page.locator('.compatibility-refresh').click();
  await expect(page.locator('.compatibility-details dt')).toHaveText(['Selected CLI executable','Selected CLI version','Server candidate executable','Server candidate version','Actually running server executable','Server version reported by existing connections','Subagent management','Safe idle compaction','Interrupt exact turn']);
  await expect(page.locator('.compatibility-details dd')).toHaveText(['D:\\tools\\codex.exe','codex-cli 0.2.0','D:\\next\\codex-server.exe','0.3.0','Unknown','0.1.0','Not supported','Unknown','Unknown']);
  await expect(page.locator('.compatibility-scope')).toContainText('Matching versions do not confirm the same package');
  await expect(page.locator('.compatibility-details')).toContainText('Not supported');
  const calls = await page.evaluate(() => (window as any).compatibilityFixture.calls);
  expect(calls.filter((c:any)=>c.command === 'runtime_compatibility')).toHaveLength(2);
  expect(calls.filter((c:any)=> /initialize|resume|server_start|server_stop|start_session|session_stop|set_codex|choose_codex|complete_exit/.test(c.command))).toEqual([]);
});

test('닫힌 화면의 지연 응답을 버리고 조회 실패를 지원됨으로 표시하지 않는다', async ({page}) => {
  await openSettings(page,true); await page.locator('.compatibility-refresh').click();
  await expect(page.locator('.compatibility-refresh')).toBeDisabled();
  await page.locator('#codex-settings-close').click(); await page.locator('#codex-settings-open').click();
  await page.evaluate(() => (window as any).compatibilityFixture.release());
  await expect(page.locator('.compatibility-refresh')).toBeEnabled();
  await expect(page.locator('.compatibility-details')).toBeHidden();
  await page.evaluate(() => { (window as any).compatibilityFixture.reply={executable:'fixture',cliVersion:null,serverState:'unavailable',serverVersion:null,subagents:null,compactIfIdle:null,expectedTurnInterrupt:null}; });
  await page.locator('.compatibility-refresh').click(); await page.evaluate(() => (window as any).compatibilityFixture.release());
  await expect(page.locator('.compatibility-status')).toContainText('공유서버 연결을 확인하지 못했습니다');
  await expect(page.locator('.compatibility-details dd')).toHaveText(['fixture','미확인','미확인','미확인','미확인','미확인','미확인','미확인','미확인']);
  await page.evaluate(() => { (window as any).compatibilityFixture.reply.subagents='true'; });
  await page.locator('.compatibility-refresh').click(); await page.evaluate(() => (window as any).compatibilityFixture.release());
  await expect(page.locator('.compatibility-status')).toContainText('호환성을 확인하지 못했습니다');
  await expect(page.locator('.compatibility-details')).toBeHidden();
});

test('선택 서버 정보가 비어 있거나 실행 중 버전이 없으면 다른 대상의 값으로 대신하지 않는다', async ({page}) => {
  await openSettings(page);
  for (const missing of [false, true]) {
    await page.evaluate(missing => {
      const reply = (window as any).compatibilityFixture.reply;
      if (missing) { delete reply.selectedServerExecutable; delete reply.selectedServerVersion; }
      else Object.assign(reply, { selectedServerExecutable: null, selectedServerVersion: null });
    }, missing);
    await page.locator('.compatibility-refresh').click();
    await expect(page.locator('.compatibility-details dd')).toHaveText(['D:\\tools\\codex.exe','codex-cli 0.2.0','미확인','미확인','미확인','0.1.0','지원되지 않음','미확인','미확인']);
  }
  await page.evaluate(() => {
    Object.assign((window as any).compatibilityFixture.reply, { selectedServerExecutable: 'D:\\next\\server.exe', selectedServerVersion: 'codex-cli 0.2.0', serverVersion: null });
  });
  await page.locator('.compatibility-refresh').click();
  await expect(page.locator('.compatibility-details dd')).toHaveText(['D:\\tools\\codex.exe','codex-cli 0.2.0','D:\\next\\server.exe','codex-cli 0.2.0','미확인','미확인','지원되지 않음','미확인','미확인']);
  await expect(page.locator('.compatibility-scope')).toContainText('같은 패키지로 확정하지 않습니다');
});

for (const field of ['selectedServerExecutable', 'selectedServerVersion']) {
  test(`새 선택 서버 필드 ${field}의 잘못된 형식과 길이 초과를 거절한다`, async ({page}) => {
    await openSettings(page);
    for (const value of [42, true, {}, [], 'x'.repeat(1025)]) {
      await page.evaluate(({field,value}) => { (window as any).compatibilityFixture.reply[field] = value; }, {field,value});
      await page.locator('.compatibility-refresh').click();
      await expect(page.locator('.compatibility-status')).toContainText('호환성을 확인하지 못했습니다');
      await expect(page.locator('.compatibility-details')).toBeHidden();
    }
  });
}

test('새 선택 서버 필드는 1024자 경계를 허용하고 태그처럼 보이는 값도 글자로 표시한다', async ({page}) => {
  await openSettings(page);
  const path = '<img src=x onerror="window.compatibilityInjected=true">'.padEnd(1024, 'p');
  const version = '<script>window.compatibilityInjected=true</script>'.padEnd(1024, 'v');
  await page.evaluate(({path,version}) => {
    Object.assign((window as any).compatibilityFixture.reply, { selectedServerExecutable: path, selectedServerVersion: version });
  }, {path,version});
  await page.locator('.compatibility-refresh').click();
  await expect(page.locator('.compatibility-details dd').nth(2)).toHaveText(path);
  await expect(page.locator('.compatibility-details dd').nth(3)).toHaveText(version);
  await expect(page.locator('.compatibility-details img, .compatibility-details script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).compatibilityInjected)).toBeUndefined();
});

test('조회 대기 중 언어 변경은 추가 조회 없이 단일 미결 조회와 응답을 유지한다', async ({page}) => {
  await openSettings(page,true);
  await page.locator('.compatibility-refresh').click();
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('#language-select')!;
    select.value = 'en'; select.dispatchEvent(new Event('change', {bubbles:true}));
    document.querySelector<HTMLButtonElement>('.compatibility-refresh')!.click();
  });
  await expect(page.locator('.compatibility-refresh')).toBeDisabled();
  await expect(page.locator('.compatibility-status')).toHaveText('Checking…');
  expect(await page.evaluate(() => (window as any).compatibilityFixture.calls.filter((c:any)=>c.command==='runtime_compatibility').length)).toBe(1);
  await page.evaluate(() => (window as any).compatibilityFixture.release());
  await expect(page.locator('.compatibility-details dd')).toHaveText(['D:\\tools\\codex.exe','codex-cli 0.2.0','D:\\next\\codex-server.exe','0.3.0','Unknown','0.1.0','Not supported','Unknown','Unknown']);
  await expect(page.locator('.compatibility-refresh')).toBeEnabled();
});

 test('기존 연결의 보고 버전은 현재 서버 연결 성공으로 표시하지 않는다', async ({page}) => {
  await openSettings(page);
  await page.evaluate(() => { Object.assign((window as any).compatibilityFixture.reply, { serverState: 'unavailable', selectedServerExecutable: null, selectedServerVersion: null, serverVersion: 'observed-v1' }); });
  await page.locator('.compatibility-refresh').click();
  await expect(page.locator('.compatibility-status')).toContainText('추가 연결 없이 기존 관측 정보만 표시');
  await expect(page.locator('.compatibility-details dd').nth(5)).toHaveText('observed-v1');
  await expect(page.locator('.compatibility-help')).toContainText('현재 실행 상태를 다시 확인한 값이 아닙니다');
  await expect(page.locator('.compatibility-scope')).toContainText('서버에 새로 연결하지 않습니다');
});
