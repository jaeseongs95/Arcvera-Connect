import { bindAttribute, bindText, t, unbindText } from './i18n';

export interface ExtensionPlugin {
  pluginId: string; name: string; marketplaceName: string; version: string | null;
  enabled: boolean; source: string; installPolicy: string | null; authPolicy: string | null;
}
export interface ExtensionSkill { name: string; description: string; path: string; scope: string; enabled: boolean; pluginId: string | null }
export interface ExtensionMarketplace { name: string; source: string; path: string | null }
export interface ExtensionHook {
  key: string; eventName: string; handlerType: 'command' | 'mcpTool' | 'prompt' | 'agent';
  command: string | null; server: string | null; tool: string | null; async: boolean;
  matcher: string | null; timeoutSec: number; statusMessage: string | null; additionalContextLimit: number | null;
  sourcePath: string; source: string; pluginId: string | null;
  enabled: boolean; isManaged: boolean; currentHash: string; trustStatus: 'managed' | 'untrusted' | 'trusted' | 'modified';
}
export interface ExtensionHooks { items: ExtensionHook[]; warnings: string[]; errors: { path: string; message: string }[] }
export interface ExtensionsSnapshot {
  executable: string; cwd: string | null;
  plugins: { installed: ExtensionPlugin[]; available: ExtensionPlugin[] } | null;
  marketplaces: ExtensionMarketplace[] | null; skills: ExtensionSkill[] | null;
  hooks: ExtensionHooks | null;
  skillDestinations: { user: string | null; project: string | null };
  errors: { section: 'plugins' | 'marketplaces' | 'skills' | 'hooks'; message: string }[];
}
interface ExtensionsHost {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  notify(ko: string, error?: boolean, en?: string): void;
}
type Tab = 'plugins' | 'skills' | 'hooks' | 'marketplaces';
const TABS: readonly Tab[] = ['plugins', 'skills', 'hooks', 'marketplaces'];
type Mutation = { operation: string; [key: string]: unknown };
type Row = { id: string; title: string; subtitle: string; searchable: string[]; item: ExtensionPlugin | ExtensionSkill | ExtensionMarketplace | ExtensionHook };

export function createExtensionsManager(host: ExtensionsHost) {
  const dialog = document.createElement('dialog'); dialog.id = 'extensions-dialog';
  dialog.setAttribute('aria-labelledby', 'extensions-title');
  // Static markup only. CLI metadata and user input are inserted as text below.
  dialog.innerHTML = `<div class="dialog-heading"><div><span class="eyebrow" id="extensions-eyebrow"></span><h2 id="extensions-title"></h2></div><button id="extensions-close" class="icon-button">×</button></div>
    <p id="extensions-description"></p>
    <dl class="extensions-context"><dt id="extensions-executable-label"></dt><dd id="extensions-executable"></dd><dt id="extensions-project-label"></dt><dd id="extensions-project"></dd></dl>
    <div class="extensions-tabs" role="tablist"><button id="extensions-tab-plugins" role="tab" aria-controls="extensions-content" data-tab="plugins"></button><button id="extensions-tab-skills" role="tab" aria-controls="extensions-content" data-tab="skills"></button><button id="extensions-tab-hooks" role="tab" aria-controls="extensions-content" data-tab="hooks"></button><button id="extensions-tab-marketplaces" role="tab" aria-controls="extensions-content" data-tab="marketplaces"></button></div>
    <div class="extensions-tools"><label for="extensions-search" id="extensions-search-label"></label><input id="extensions-search" type="search" maxlength="200" autocomplete="off"/><button id="extensions-plugin-discover" class="quiet-button"></button><button id="extensions-plugin-search" class="quiet-button" hidden></button><button id="extensions-refresh" class="quiet-button"></button></div>
    <div id="extensions-status" role="status" aria-live="polite"></div><div id="extensions-error" class="inline-error" role="alert" hidden></div>
    <section id="extensions-content" class="extensions-panes" role="tabpanel"><div class="extensions-list-pane"><div id="extensions-list" role="listbox" tabindex="0"></div><div class="extensions-paging"><small id="extensions-range"></small><button id="extensions-previous" class="quiet-button" hidden></button><button id="extensions-more" class="quiet-button" hidden></button></div></div><div class="extensions-detail-pane"><div id="extensions-detail"></div>
      <form id="extensions-skill-form" class="extensions-form" hidden><h3 id="extensions-import-title"></h3><label for="extensions-skill-source" id="extensions-skill-source-label"></label><div class="extensions-picker"><input id="extensions-skill-source" readonly/><button type="button" id="extensions-skill-choose" class="quiet-button"></button></div><label for="extensions-skill-name" id="extensions-skill-name-label"></label><input id="extensions-skill-name" maxlength="64" pattern="[a-z0-9_][a-z0-9_\\-]{0,63}" required/><small id="extensions-skill-name-help"></small><label for="extensions-skill-scope" id="extensions-skill-scope-label"></label><select id="extensions-skill-scope"><option value="user" id="extensions-scope-user"></option><option value="project" id="extensions-scope-project"></option></select><small id="extensions-skill-destination"></small><button id="extensions-skill-import" class="primary-button" type="submit"></button></form>
      <form id="extensions-marketplace-form" class="extensions-form" hidden><h3 id="extensions-marketplace-title"></h3><label for="extensions-marketplace-source" id="extensions-marketplace-source-label"></label><input id="extensions-marketplace-source" maxlength="4096" required/><label for="extensions-marketplace-ref" id="extensions-marketplace-ref-label"></label><input id="extensions-marketplace-ref" maxlength="200"/><button id="extensions-marketplace-add" class="primary-button" type="submit"></button></form>
    </div></section>
    <div id="extensions-review" class="extensions-review" hidden><strong id="extensions-review-title"></strong><pre id="extensions-review-target"></pre><p id="extensions-review-scope"></p><div class="extensions-review-actions"><button id="extensions-review-cancel" class="quiet-button"></button><button id="extensions-review-confirm" class="primary-button"></button></div></div>
    <small id="extensions-effect"></small>`;
  document.body.append(dialog);
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const text = (selector: string, ko: string, en: string) => bindText($(selector), ko, en);
  for (const [selector, ko, en] of [
    ['#extensions-eyebrow', '확장 관리', 'EXTENSIONS'], ['#extensions-title', '플러그인·스킬·Hook', 'Plugins, skills & hooks'],
    ['#extensions-description', '설치된 확장을 관리하거나 필요한 플러그인을 찾아 추가하세요.', 'Manage installed extensions or find a plugin to add.'],
    ['#extensions-executable-label', '실행 파일', 'Executable'], ['#extensions-project-label', '프로젝트', 'Project'],
    ['#extensions-tab-plugins', '플러그인', 'Plugins'], ['#extensions-tab-skills', '스킬', 'Skills'], ['#extensions-tab-marketplaces', '마켓플레이스', 'Marketplaces'],
    ['#extensions-tab-hooks', 'Hook', 'Hooks'], ['#extensions-plugin-discover', '플러그인 추가', 'Add a plugin'], ['#extensions-plugin-search', '찾기', 'Find'],
    ['#extensions-search-label', '목록 검색', 'Search list'], ['#extensions-refresh', '새로 고침', 'Refresh'],
    ['#extensions-more', '50개 더 보기', 'Show 50 more'],
    ['#extensions-previous', '이전 항목', 'Previous entries'],
    ['#extensions-import-title', '로컬 스킬 가져오기', 'Import a local skill'], ['#extensions-skill-source-label', 'SKILL.md가 있는 폴더', 'Folder containing SKILL.md'],
    ['#extensions-skill-choose', '폴더 선택…', 'Choose folder…'], ['#extensions-skill-name-label', '저장할 폴더 이름', 'Destination folder name'],
    ['#extensions-skill-name-help', '소문자 영문·숫자·하이픈·밑줄, 최대 64자. 기존 폴더는 덮어쓰지 않습니다.', 'Lowercase letters, digits, hyphens and underscores, up to 64 characters. Existing folders are never overwritten.'],
    ['#extensions-skill-scope-label', '가져올 위치', 'Import scope'], ['#extensions-scope-user', '사용자 · 모든 프로젝트', 'User · all projects'], ['#extensions-scope-project', '현재 프로젝트', 'Current project'],
    ['#extensions-skill-import', '가져오기 검토', 'Review import'], ['#extensions-marketplace-title', '마켓플레이스 등록', 'Add a marketplace'],
    ['#extensions-marketplace-source-label', '로컬 경로 또는 Git 주소', 'Local path or Git URL'], ['#extensions-marketplace-ref-label', 'Git 리비전 (선택)', 'Git revision (optional)'],
    ['#extensions-marketplace-add', '등록 검토', 'Review registration'], ['#extensions-review-cancel', '취소', 'Cancel'], ['#extensions-review-confirm', '실행', 'Apply'],
    ['#extensions-effect', '변경 후 새 세션에서 구성을 확인하세요. 열린 터미널은 재시작하지 않습니다.', 'Check the configuration in a new session after changes. Open terminals are not restarted.'],
  ]) text(selector, ko, en);
  bindAttribute($('#extensions-close'), 'aria-label', '확장 관리 닫기', 'Close extension manager');
  bindAttribute($('#extensions-search'), 'placeholder', '이름·설명·경로로 검색', 'Search names, descriptions and paths');
  bindAttribute($('#extensions-list'), 'aria-label', '확장 목록', 'Extension list');
  const search = $<HTMLInputElement>('#extensions-search');
  const selections: Partial<Record<Tab, string>> = {};
  const limits: Record<Tab, number> = { plugins: 50, skills: 50, hooks: 50, marketplaces: 50 };
  const starts: Record<Tab, number> = { plugins: 0, skills: 0, hooks: 0, marketplaces: 0 };
  let tab: Tab = 'plugins'; let snapshot: ExtensionsSnapshot | undefined; let cwd: string | null = null;
  let version = 0; let busy = false; let mutation: Promise<ExtensionsSnapshot> | undefined;
  let pendingRead: { token: number; cwd: string | null; catalogQuery: string | null } | undefined; let readPump: Promise<void> | undefined;
  let catalogMode = false; let loadedCatalogQuery: string | null = null;
  let pendingAction: Mutation | undefined;
  let exitRequested = false; let exitDrain: Promise<void> | undefined; let picker: Promise<string | null> | undefined;
  const current = (token: number) => dialog.open && token === version;
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
  const preview = (value: string) => value.length > 4096 ? `${value.slice(0, 4096)}…` : value;
  function status(ko: string, en = ko) { text('#extensions-status', ko, en); }
  function showError(error: unknown) { $('#extensions-error').hidden = false; $('#extensions-error').textContent = preview(errorMessage(error)); }
  function setBusy(value: boolean) {
    busy = value; const blocked = value || exitRequested; dialog.setAttribute('aria-busy', String(blocked));
    for (const control of dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button:not(#extensions-close),input,select')) control.disabled = blocked;
    if (!blocked) {
      $<HTMLOptionElement>('#extensions-scope-project').disabled = !snapshot?.skillDestinations.project;
      if (!snapshot?.skillDestinations.project && $<HTMLSelectElement>('#extensions-skill-scope').value === 'project') $<HTMLSelectElement>('#extensions-skill-scope').value = 'user';
      $<HTMLButtonElement>('#extensions-skill-import').disabled = !snapshot?.skillDestinations[$<HTMLSelectElement>('#extensions-skill-scope').value as 'user' | 'project'];
      $<HTMLButtonElement>('#extensions-marketplace-add').disabled = !snapshot?.marketplaces;
      $('#extensions-list').querySelectorAll<HTMLButtonElement>('button').forEach(button => button.disabled = false);
      updateDestination();
    }
    updateCatalogControls();
  }
  function cancelReview() { pendingAction = undefined; $('#extensions-review').hidden = true; }
  function review(request: Mutation, target: string, ko: string, en: string, scopeKo: string, scopeEn: string) {
    if (busy || exitRequested) return;
    pendingAction = request; text('#extensions-review-title', ko, en); $('#extensions-review-target').textContent = target;
    text('#extensions-review-scope', scopeKo, scopeEn); $('#extensions-review').hidden = false;
    const destructive = request.operation === 'removePlugin' || request.operation === 'removeMarketplace';
    $('#extensions-review-confirm').className = destructive ? 'danger-button' : 'primary-button';
    text('#extensions-review-confirm', destructive ? '제거 확인' : '실행', destructive ? 'Confirm removal' : 'Apply');
    $('#extensions-review-confirm').focus();
  }
  const userScope = ['선택한 CLI의 사용자 구성에 저장됩니다. 모든 프로젝트에 영향을 줄 수 있습니다.', 'Saved in the selected CLI user configuration. This can affect all projects.'] as const;
  function hookHandler(hook: ExtensionHook) {
    return hook.handlerType === 'command' ? hook.command ?? '' : hook.handlerType === 'mcpTool' ? `${hook.server} / ${hook.tool}` : hook.handlerType;
  }
  const hookTrustNames = { trusted: ['신뢰함', 'Trusted'], untrusted: ['신뢰 확인 필요', 'Review required'], modified: ['내용 변경 · 재검토 필요', 'Changed · review required'], managed: ['관리 정책', 'Managed'] } as const;
  function hookTrust(hook: ExtensionHook) {
    return t(hookTrustNames[hook.trustStatus][0], hookTrustNames[hook.trustStatus][1]);
  }
  function hookReview(hook: ExtensionHook) {
    return `${hook.eventName}\n${hook.sourcePath}\n${hookHandler(hook)}\n${hook.matcher ?? ''}\n${t('시간 제한', 'Timeout')}: ${hook.timeoutSec}s\n${t('내용 지문', 'Content fingerprint')}: ${hook.currentHash}`;
  }
  function rows(): Row[] {
    if (!snapshot) return [];
    if (tab === 'plugins') {
      const installed = snapshot.plugins?.installed ?? []; const ids = new Set(installed.map(item => item.pluginId));
      const items = catalogMode ? (loadedCatalogQuery === search.value.trim() ? snapshot.plugins?.available ?? [] : []).filter(item => !ids.has(item.pluginId)) : installed;
      return items.map(item => ({ id: item.pluginId, title: item.name, subtitle: `${item.marketplaceName}${item.version ? ` · ${item.version}` : ''}`, searchable: [item.name, item.pluginId, item.marketplaceName, item.source], item }));
    }
    if (tab === 'skills') return (snapshot.skills ?? []).map(item => ({ id: item.path, title: item.name, subtitle: item.description, searchable: [item.name, item.description, item.path, item.scope, item.pluginId ?? ''], item }));
    if (tab === 'hooks') return (snapshot.hooks?.items ?? []).map(item => ({ id: item.key, title: item.eventName, subtitle: `${item.source} · ${item.enabled ? t('사용 중', 'Enabled') : t('사용 안 함', 'Disabled')} · ${hookTrust(item)}`, searchable: [item.key, item.eventName, item.sourcePath, item.source, item.pluginId ?? '', hookHandler(item)], item }));
    return (snapshot.marketplaces ?? []).map(item => ({ id: item.name, title: item.name, subtitle: item.source, searchable: [item.name, item.source, item.path ?? ''], item }));
  }
  function metadata(parent: HTMLElement, ko: string, en: string, value: string | null | undefined) {
    if (value === null || value === undefined || value === '') return;
    const term = document.createElement('dt'); bindText(term, ko, en); const detail = document.createElement('dd'); detail.textContent = preview(value); parent.append(term, detail);
  }
  function action(parent: HTMLElement, id: string, ko: string, en: string, run: () => void) {
    const button = document.createElement('button'); button.id = id; button.type = 'button'; button.className = 'quiet-button'; bindText(button, ko, en); button.disabled = busy || exitRequested; button.onclick = run; parent.append(button);
  }
  function renderDetail(row?: Row) {
    const detail = $('#extensions-detail'); detail.replaceChildren();
    if (!row) { const empty = document.createElement('p'); bindText(empty, '목록에서 항목을 선택하세요.', 'Select an item from the list.'); detail.append(empty); return; }
    const title = document.createElement('h3'); title.textContent = row.title;
    const data = document.createElement('dl'); const actions = document.createElement('div'); actions.className = 'extensions-item-actions';
    if (tab === 'plugins') {
      const plugin = row.item as ExtensionPlugin; const installed = !!snapshot?.plugins?.installed.some(item => item.pluginId === plugin.pluginId);
      metadata(data, 'ID', 'ID', plugin.pluginId); metadata(data, '마켓플레이스', 'Marketplace', plugin.marketplaceName); metadata(data, '버전', 'Version', plugin.version);
      metadata(data, '소스', 'Source', plugin.source); metadata(data, '설치 정책', 'Install policy', plugin.installPolicy); metadata(data, '인증 정책', 'Authentication policy', plugin.authPolicy);
      const state = document.createElement('p'); bindText(state, installed ? (plugin.enabled ? '설치됨 · 사용' : '설치됨 · 사용 안 함') : '설치할 수 있음', installed ? (plugin.enabled ? 'Installed · enabled' : 'Installed · disabled') : 'Available to install'); detail.append(state);
      if (installed) {
        action(actions, 'extensions-plugin-toggle', plugin.enabled ? '사용 안 함' : '사용', plugin.enabled ? 'Disable' : 'Enable', () => review({ operation: 'setPluginEnabled', pluginId: plugin.pluginId, enabled: !plugin.enabled }, plugin.pluginId, '플러그인 사용 설정', 'Change plugin activation', ...userScope));
        action(actions, 'extensions-plugin-remove', '플러그인 제거…', 'Remove plugin…', () => review({ operation: 'removePlugin', pluginId: plugin.pluginId }, plugin.pluginId, '플러그인을 제거할까요?', 'Remove this plugin?', ...userScope));
      } else action(actions, 'extensions-plugin-install', '플러그인 설치…', 'Install plugin…', () => review({ operation: 'installPlugin', selector: `${plugin.name}@${plugin.marketplaceName}` }, `${plugin.name}@${plugin.marketplaceName}`, '플러그인 설치', 'Install plugin', ...userScope));
    } else if (tab === 'skills') {
      const skill = row.item as ExtensionSkill;
      const description = document.createElement('p'); description.textContent = preview(skill.description); detail.append(description);
      metadata(data, '파일', 'File', skill.path); metadata(data, '범위', 'Scope', skill.scope); metadata(data, '플러그인', 'Plugin', skill.pluginId);
      const state = document.createElement('p'); bindText(state, skill.enabled ? '사용 중' : '사용 안 함', skill.enabled ? 'Enabled' : 'Disabled'); detail.append(state);
      action(actions, 'extensions-skill-toggle', skill.enabled ? '사용 안 함' : '사용', skill.enabled ? 'Disable' : 'Enable', () => review({ operation: 'setSkillEnabled', path: skill.path, enabled: !skill.enabled }, skill.path, '스킬 사용 설정', 'Change skill activation', ...userScope));
    } else if (tab === 'hooks') {
      const hook = row.item as ExtensionHook;
      metadata(data, '이벤트', 'Event', hook.eventName); metadata(data, '출처', 'Source', hook.source);
      metadata(data, '등록 파일', 'Definition file', hook.sourcePath); metadata(data, '플러그인', 'Plugin', hook.pluginId);
      metadata(data, '종류', 'Handler', hook.handlerType); metadata(data, '대상 조건', 'Matcher', hook.matcher);
      metadata(data, '시간 제한', 'Timeout', `${hook.timeoutSec}s`); metadata(data, '내용 지문', 'Content fingerprint', hook.currentHash);
      const content = document.createElement('pre'); content.id = 'extensions-hook-content'; content.textContent = hookHandler(hook); detail.append(content);
      const state = document.createElement('p'); bindText(state, `${hook.enabled ? '사용 중' : '사용 안 함'} · ${hookTrustNames[hook.trustStatus][0]}`, `${hook.enabled ? 'Enabled' : 'Disabled'} · ${hookTrustNames[hook.trustStatus][1]}`); detail.append(state);
      if (hook.isManaged) {
        const managed = document.createElement('p'); bindText(managed, '관리자가 정한 Hook입니다. 여기서는 사용·신뢰 설정을 바꾸지 않습니다.', 'This hook is managed by policy. Its activation and trust cannot be changed here.'); detail.append(managed);
      } else {
        const needsReview = hook.trustStatus === 'untrusted' || hook.trustStatus === 'modified';
        if (hook.enabled || !needsReview) action(actions, 'extensions-hook-toggle', hook.enabled ? '사용 안 함' : '사용', hook.enabled ? 'Disable' : 'Enable', () => review({ operation: 'setHookEnabled', key: hook.key, currentHash: hook.currentHash, enabled: !hook.enabled }, hookReview(hook), 'Hook 사용 설정', 'Change hook activation', ...userScope));
        if (needsReview && hook.handlerType === 'command') action(actions, 'extensions-hook-trust', '내용 검토 후 신뢰…', 'Review and trust…', () => review({ operation: 'trustHook', key: hook.key, currentHash: hook.currentHash }, hookReview(hook), '이 Hook의 현재 내용을 신뢰할까요?', 'Trust the current contents of this hook?', '등록 파일과 실행 내용을 확인하세요. 현재 내용만 승인하며 사용 상태는 바꾸지 않습니다.', 'Review its definition file and handler. Only these contents are trusted; activation is unchanged.'));
        else if (needsReview) {
          const unavailable = document.createElement('p'); bindText(unavailable, '실행 입력을 모두 확인할 수 없어 이 앱에서는 신뢰 승인할 수 없습니다. 등록 파일과 사용 중인 CLI의 지원 범위를 확인하세요.', 'The complete execution input is unavailable, so this app cannot approve trust. Review the definition file and the capabilities of your CLI.'); detail.append(unavailable);
        }
      }
    } else {
      const marketplace = row.item as ExtensionMarketplace;
      metadata(data, '소스', 'Source', marketplace.source); metadata(data, '경로', 'Path', marketplace.path);
      action(actions, 'extensions-marketplace-upgrade', '소스 업데이트…', 'Update source…', () => review({ operation: 'upgradeMarketplace', name: marketplace.name }, marketplace.name, '마켓플레이스 업데이트', 'Update marketplace', ...userScope));
      action(actions, 'extensions-marketplace-remove', '등록 제거…', 'Remove registration…', () => review({ operation: 'removeMarketplace', name: marketplace.name }, marketplace.name, '마켓플레이스 등록을 제거할까요?', 'Remove this marketplace registration?', ...userScope));
    }
    detail.prepend(title); detail.append(data, actions);
  }
  function renderList() {
    const query = search.value.trim().toLocaleLowerCase(); const filtered = rows().filter(row => !query || row.searchable.some(field => field.toLocaleLowerCase().includes(query)));
    if (starts[tab] >= filtered.length) starts[tab] = Math.floor(Math.max(0, filtered.length - 1) / 250) * 250;
    const visible = filtered.slice(starts[tab], starts[tab] + limits[tab]);
    if (snapshot && !visible.some(row => row.id === selections[tab])) selections[tab] = visible[0]?.id;
    const list = $('#extensions-list'); list.replaceChildren();
    for (const row of visible) {
      const button = document.createElement('button'); button.className = 'extensions-row'; button.dataset.extensionId = row.id;
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(row.id === selections[tab])); button.disabled = busy || exitRequested;
      const title = document.createElement('strong'); title.textContent = preview(row.title); const subtitle = document.createElement('span'); subtitle.textContent = preview(row.subtitle);
      button.append(title, subtitle); button.onclick = () => { if (!busy && !exitRequested) { cancelReview(); selections[tab] = row.id; renderList(); } }; list.append(button);
    }
    if (!filtered.length) {
      const empty = document.createElement('p'); const unavailable = !snapshot || snapshot[tab] === null;
      bindText(empty, tab === 'plugins' && catalogMode && !loadedCatalogQuery ? '플러그인 이름을 두 글자 이상 입력하고 찾기를 누르세요.' : unavailable ? '목록을 불러오지 못했습니다.' : query ? '검색 결과가 없습니다.' : '등록된 항목이 없습니다.', tab === 'plugins' && catalogMode && !loadedCatalogQuery ? 'Enter at least two characters of a plugin name and choose Find.' : unavailable ? 'This list could not be loaded.' : query ? 'No matching items.' : 'No entries found.'); list.append(empty);
    }
    $('#extensions-more').hidden = filtered.length <= starts[tab] + limits[tab];
    $('#extensions-previous').hidden = starts[tab] === 0;
    text('#extensions-more', limits[tab] < 250 ? '50개 더 보기' : '다음 항목', limits[tab] < 250 ? 'Show 50 more' : 'Next entries');
    $('#extensions-range').textContent = filtered.length ? `${starts[tab] + 1}–${starts[tab] + visible.length} / ${filtered.length}` : '';
    renderDetail(visible.find(row => row.id === selections[tab]));
    const sectionErrors = snapshot?.errors.filter(error => error.section === tab) ?? [];
    if (tab === 'hooks' && snapshot?.hooks && (snapshot.hooks.errors.length || snapshot.hooks.warnings.length)) {
      const diagnostics = document.createElement('p'); diagnostics.id = 'extensions-hook-diagnostics';
      bindText(diagnostics, `Hook 구성 안내 ${snapshot.hooks.warnings.length}건 · 읽지 못한 구성 ${snapshot.hooks.errors.length}건. 등록 파일을 확인한 뒤 새로 고침하세요.`, `${snapshot.hooks.warnings.length} hook notices · ${snapshot.hooks.errors.length} configuration errors. Check the definition files and refresh.`); $('#extensions-detail').append(diagnostics);
    }
    if (sectionErrors.length) { $('#extensions-error').textContent = preview(sectionErrors.map(error => error.message).join('\n')); $('#extensions-error').hidden = false; }
    else $('#extensions-error').hidden = true;
    $('#extensions-content').setAttribute('aria-labelledby', `extensions-tab-${tab}`);
    $('#extensions-skill-form').hidden = tab !== 'skills'; $('#extensions-marketplace-form').hidden = tab !== 'marketplaces';
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      const selected = button.dataset.tab === tab; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      button.dataset.error = String(!!snapshot?.errors.some(error => error.section === button.dataset.tab));
    }
    updateDestination(); updateCatalogControls();
  }
  function updateCatalogControls() {
    $('#extensions-plugin-discover').hidden = tab !== 'plugins';
    $('#extensions-plugin-search').hidden = tab !== 'plugins' || !catalogMode;
    text('#extensions-plugin-discover', catalogMode ? '설치된 플러그인' : '플러그인 추가', catalogMode ? 'Installed plugins' : 'Add a plugin');
    $<HTMLButtonElement>('#extensions-plugin-search').disabled = busy || exitRequested || [...search.value.trim()].length < 2;
    bindAttribute(search, 'placeholder', tab === 'plugins' && catalogMode ? '추가할 플러그인 이름 (두 글자 이상)' : '이름·설명·경로로 검색', tab === 'plugins' && catalogMode ? 'Plugin name to add (at least two characters)' : 'Search names, descriptions and paths');
  }
  function updateDestination() {
    const scope = $<HTMLSelectElement>('#extensions-skill-scope').value as 'user' | 'project';
    const base = snapshot?.skillDestinations[scope]; const name = $<HTMLInputElement>('#extensions-skill-name').value.trim();
    const target = base ? `${base.replace(/[\\/]+$/, '')}${base.includes('\\') ? '\\' : '/'}${name || '<name>'}` : null;
    text('#extensions-skill-destination', target ? `저장 위치: ${target}` : '이 범위의 저장 위치를 확인할 수 없습니다.', target ? `Destination: ${target}` : 'The destination for this scope is unavailable.');
    $<HTMLButtonElement>('#extensions-skill-import').disabled = busy || exitRequested || !base;
  }
  function show(value: ExtensionsSnapshot) {
    snapshot = value; $('#extensions-executable').textContent = value.executable;
    if (value.cwd) { unbindText($('#extensions-project')); $('#extensions-project').textContent = value.cwd; } else text('#extensions-project', '사용자 구성 · 선택된 프로젝트 없음', 'User configuration · no project selected');
    setBusy(busy); renderList();
  }
  async function pumpReads() {
    while (pendingRead) {
      const intent = pendingRead; pendingRead = undefined;
      try {
        if (mutation) { try { await mutation; } catch { /* Requery after the earlier operation settles. */ } }
        if (!current(intent.token) || exitRequested) continue;
        const value = await host.call<ExtensionsSnapshot>('extensions_list', { cwd: intent.cwd, ...(intent.catalogQuery ? { catalogQuery: intent.catalogQuery } : {}) });
        if (current(intent.token)) { loadedCatalogQuery = intent.catalogQuery; show(value); status(value.errors.length ? '일부 목록을 불러오지 못했습니다. 오류가 있는 탭을 확인하세요.' : '실제 CLI 구성을 불러왔습니다.', value.errors.length ? 'Some lists could not be loaded. Review the marked tabs.' : 'Loaded the actual CLI configuration.'); }
      } catch (error) {
        if (current(intent.token)) { snapshot = undefined; renderList(); showError(error); status('구성을 불러오지 못했습니다. 새로 고침으로 다시 시도하세요.', 'Could not load the configuration. Refresh to retry.'); }
      } finally { if (current(intent.token)) setBusy(false); }
    }
  }
  function load() {
    if (exitRequested || busy && dialog.getAttribute('aria-busy') === 'true') return;
    const catalogQuery = tab === 'plugins' && catalogMode ? search.value.trim() : null;
    if (catalogQuery !== null && [...catalogQuery].length < 2) return;
    cancelReview(); $('#extensions-error').hidden = true; setBusy(true); status('구성을 불러오는 중…', 'Loading configuration…');
    // ponytail: one active read and one replaceable intent; no server per popup reopen.
    pendingRead = { token: version, cwd, catalogQuery };
    if (!readPump) readPump = pumpReads().finally(() => { readPump = undefined; });
  }
  async function apply() {
    if (busy || exitRequested || !pendingAction) return;
    const request = pendingAction; const token = version; cancelReview(); $('#extensions-error').hidden = true; setBusy(true); status('변경하고 실제 구성을 다시 확인하는 중…', 'Applying changes and verifying the configuration…');
    const operation = host.call<ExtensionsSnapshot>('extensions_mutate', { cwd, request }); mutation = operation;
    try {
      const value = await operation;
      if (current(token)) { if (request.operation === 'installPlugin') { catalogMode = false; loadedCatalogQuery = null; search.value = ''; } show(value); status('변경이 저장되고 선택한 문맥의 구성을 다시 확인했습니다.', 'Saved changes and read back the selected configuration.'); }
      else host.notify('확장 구성이 변경되었습니다. 확장 관리를 다시 열어 확인하세요.', false, 'Extension configuration changed. Reopen the manager to review it.');
    } catch (error) {
      if (current(token)) { snapshot = undefined; renderList(); showError(error); status('변경을 완료하지 못했습니다. 오류와 실제 구성을 확인하세요.', 'The change could not be completed. Review the error and refresh the actual configuration.'); }
      else host.notify(`확장 구성 변경 실패: ${errorMessage(error)}`, true, `Could not change extension configuration: ${errorMessage(error)}`);
    } finally { if (mutation === operation) mutation = undefined; if (current(token)) setBusy(false); }
  }
  $('#extensions-close').onclick = () => dialog.close();
  dialog.onclose = () => { version++; pendingRead = undefined; snapshot = undefined; cancelReview(); $('#extensions-list').replaceChildren(); $('#extensions-detail').replaceChildren(); $('#extensions-error').textContent = ''; $('#extensions-error').hidden = true; $('#extensions-more').hidden = true; $('#extensions-previous').hidden = true; $('#extensions-range').textContent = ''; };
  $('#extensions-refresh').onclick = load; search.oninput = () => { if (!busy && !exitRequested) { limits[tab] = 50; starts[tab] = 0; cancelReview(); renderList(); } };
  $('#extensions-plugin-discover').onclick = () => {
    if (busy || exitRequested) return;
    catalogMode = !catalogMode; loadedCatalogQuery = null; search.value = ''; delete selections.plugins; limits.plugins = 50; starts.plugins = 0; cancelReview(); renderList();
    if (catalogMode) search.focus(); else load();
  };
  $('#extensions-plugin-search').onclick = load;
  search.onkeydown = event => { if (event.key === 'Enter' && tab === 'plugins' && catalogMode) { event.preventDefault(); load(); } };
  $('#extensions-more').onclick = () => { if (!busy && !exitRequested) { if (limits[tab] < 250) limits[tab] += 50; else { starts[tab] += 250; limits[tab] = 50; } cancelReview(); renderList(); } };
  $('#extensions-previous').onclick = () => { if (!busy && !exitRequested) { starts[tab] = Math.max(0, starts[tab] - 250); limits[tab] = 250; cancelReview(); renderList(); } };
  for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-tab]')) button.onclick = () => { if (!busy && !exitRequested) { cancelReview(); tab = button.dataset.tab as Tab; renderList(); } };
  $('.extensions-tabs').onkeydown = event => {
    if (busy || exitRequested || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const index = TABS.indexOf(tab);
    tab = TABS[event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]; cancelReview(); renderList(); $(`#extensions-tab-${tab}`).focus();
  };
  $('#extensions-list').onkeydown = event => {
    if (busy || exitRequested || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...$('#extensions-list').querySelectorAll<HTMLButtonElement>('[role="option"]')]; if (!buttons.length) return;
    event.preventDefault(); const selected = buttons.findIndex(button => button.getAttribute('aria-selected') === 'true'); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
    selections[tab] = buttons[next].dataset.extensionId; cancelReview(); renderList(); $('#extensions-list [aria-selected="true"]').focus();
  };
  $('#extensions-review-cancel').onclick = cancelReview; $('#extensions-review-confirm').onclick = () => void apply();
  $('#extensions-skill-choose').onclick = async () => {
    if (busy || exitRequested || picker) return; const token = version; cancelReview(); setBusy(true); status('폴더 선택을 기다리는 중…', 'Waiting for folder selection…');
    try {
      const operation = host.call<string | null>('choose_skill_folder'); picker = operation;
      const source = await operation;
      if (current(token)) {
        if (source) { $<HTMLInputElement>('#extensions-skill-source').value = source; if (!$<HTMLInputElement>('#extensions-skill-name').value) $<HTMLInputElement>('#extensions-skill-name').value = source.split(/[\\/]/).filter(Boolean).at(-1) ?? ''; updateDestination(); }
        status(source ? '가져올 위치를 확인한 뒤 검토하세요.' : '폴더 선택을 취소했습니다.', source ? 'Choose the destination, then review the import.' : 'Folder selection canceled.');
      }
    } catch (error) { if (current(token)) { showError(error); status('폴더를 선택하지 못했습니다.', 'Could not select a folder.'); } }
    finally { picker = undefined; if (current(token)) setBusy(false); }
  };
  $('#extensions-skill-scope').onchange = () => { cancelReview(); updateDestination(); }; $('#extensions-skill-name').oninput = () => { $<HTMLInputElement>('#extensions-skill-name').setCustomValidity(''); cancelReview(); updateDestination(); };
  $<HTMLInputElement>('#extensions-skill-name').oninvalid = event => {
    const field = event.target as HTMLInputElement; field.setCustomValidity('');
    if (field.validity.valueMissing) field.setCustomValidity(t('저장할 폴더 이름을 입력하세요.', 'Enter a destination folder name.'));
    else if (field.validity.patternMismatch) field.setCustomValidity(t('소문자 영문·숫자·하이픈·밑줄을 사용해 64자 이내로 입력하세요.', 'Use up to 64 lowercase letters, digits, hyphens or underscores.'));
  };
  $('#extensions-skill-form').onsubmit = event => {
    event.preventDefault(); if (busy || exitRequested) return;
    const sourcePath = $<HTMLInputElement>('#extensions-skill-source').value; const name = $<HTMLInputElement>('#extensions-skill-name').value.trim();
    const scope = $<HTMLSelectElement>('#extensions-skill-scope').value as 'user' | 'project'; const base = snapshot?.skillDestinations[scope];
    if (!sourcePath || !base) { status('소스 폴더와 저장 위치를 먼저 선택하세요.', 'Choose a source folder and an available destination first.'); return; }
    const destination = `${base.replace(/[\\/]+$/, '')}${base.includes('\\') ? '\\' : '/'}${name}`;
    review({ operation: 'importSkill', sourcePath, name, scope }, `${sourcePath}\n→ ${destination}`, '스킬 폴더 가져오기', 'Import skill folder', scope === 'project' ? '현재 프로젝트에 새 폴더를 만듭니다. 기존 폴더는 덮어쓰지 않습니다.' : '사용자 스킬 폴더에 복사합니다. 모든 프로젝트에서 발견할 수 있습니다.', scope === 'project' ? 'Creates a new folder in the current project. Existing folders are never overwritten.' : 'Copies into the user skills directory, where all projects can discover it.');
  };
  $('#extensions-marketplace-source').oninput = cancelReview; $('#extensions-marketplace-ref').oninput = cancelReview;
  $('#extensions-marketplace-form').onsubmit = event => {
    event.preventDefault(); if (busy || exitRequested) return;
    const source = $<HTMLInputElement>('#extensions-marketplace-source').value.trim(); const gitRef = $<HTMLInputElement>('#extensions-marketplace-ref').value.trim();
    if (source) review({ operation: 'addMarketplace', source, ...(gitRef ? { gitRef } : {}) }, `${source}${gitRef ? `\nref: ${gitRef}` : ''}`, '마켓플레이스 등록', 'Register marketplace', ...userScope);
  };
  return {
    beginExit(): Promise<void> {
      if (exitDrain) return exitDrain;
      // Close admission synchronously, before waiting for already accepted work.
      exitRequested = true; pendingRead = undefined; cancelReview(); setBusy(busy);
      const accepted = [mutation, readPump, picker].flatMap(operation => operation ? [operation.then(() => undefined)] : []);
      exitDrain = Promise.allSettled(accepted).then(results => {
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) throw failure.reason;
      });
      return exitDrain;
    },
    cancelExit() { exitRequested = false; exitDrain = undefined; setBusy(busy); },
    open(projectCwd?: string) {
      if (dialog.open || exitRequested) return;
      const nextCwd = projectCwd || null; if (cwd !== nextCwd) for (const key of TABS) delete selections[key];
      if (catalogMode) search.value = ''; catalogMode = false; loadedCatalogQuery = null;
      snapshot = undefined; cwd = nextCwd; version++; busy = false; for (const key of TABS) { limits[key] = 50; starts[key] = 0; } $('#extensions-executable').textContent = '…';
      if (cwd) { unbindText($('#extensions-project')); $('#extensions-project').textContent = cwd; } else text('#extensions-project', '사용자 구성 · 선택된 프로젝트 없음', 'User configuration · no project selected');
      renderList();
      dialog.showModal(); load(); $('#extensions-close').focus();
    },
  };
}
