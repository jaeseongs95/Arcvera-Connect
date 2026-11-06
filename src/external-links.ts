import { invoke } from '@tauri-apps/api/core';
import type { ILink, Terminal } from '@xterm/xterm';

const MAX_URL_LENGTH = 8192;

/** The host validates again; URL parsing must never silently remove controls. */
export function validateExternalUrl(value: string): string {
  if (!value || value.length > MAX_URL_LENGTH || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)|%c2%[89][0-9a-f]/i.test(value) || !/^https?:\/\/[^/?#]+/i.test(value)) throw new Error('HTTP(S) 웹 주소만 열 수 있습니다.');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('올바른 웹 주소가 아닙니다.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('HTTP(S) 웹 주소만 열 수 있습니다.');
  return parsed.href;
}

export async function openExternalUrl(url: string): Promise<void> {
  await invoke('open_external_url', { url: validateExternalUrl(url) });
}

function linksIn(text: string) {
  const links: { index: number; text: string }[] = [];
  const pattern = /https?:\/\/[^\s\u0000-\u001f\u007f-\u009f<>"'`\\]+/giu;
  for (const match of text.matchAll(pattern)) {
    // Sentence punctuation and unmatched enclosing brackets are not part of a URL.
    let value = match[0].replace(/[.,!?:;]+$/u, '');
    for (;;) {
      const last = value.at(-1); const opening = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : '';
      if (!opening || value.split(last!).length <= value.split(opening).length) break;
      value = value.slice(0, -1).replace(/[.,!?:;]+$/u, '');
    }
    try { validateExternalUrl(value); links.push({ index: match.index!, text: value }); } catch { /* Invalid text remains text. */ }
  }
  return links;
}

/** Adds text nodes and safe anchors; no content is interpreted as HTML. */
export function appendLinkifiedText(parent: HTMLElement, text: string, onError: (error: unknown) => void = error => { console.error('외부 링크 열기 실패', error); }) {
  let offset = 0;
  for (const link of linksIn(text)) {
    parent.append(document.createTextNode(text.slice(offset, link.index)));
    const anchor = document.createElement('a');
    anchor.textContent = link.text; anchor.href = validateExternalUrl(link.text); anchor.title = anchor.href; anchor.rel = 'noopener noreferrer';
    anchor.draggable = false;
    anchor.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation(); });
    // Chromium still emits click after dragging a non-draggable anchor.
    // Keep small click wobble, but remember a drag even if it returns to start.
    let pointerDown: { x: number; y: number; dragged: boolean } | undefined;
    anchor.addEventListener('pointerdown', event => { pointerDown = event.button === 0 ? { x: event.clientX, y: event.clientY, dragged: false } : undefined; });
    const trackPointer = (event: PointerEvent | MouseEvent) => {
      if (pointerDown && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 4) pointerDown.dragged = true;
    };
    anchor.addEventListener('pointermove', trackPointer);
    anchor.addEventListener('pointercancel', () => { pointerDown = undefined; });
    anchor.addEventListener('click', event => {
      // A link inside a question's radio label must not select or submit it.
      event.preventDefault(); event.stopPropagation();
      trackPointer(event);
      const dragged = event.detail > 0 && pointerDown?.dragged;
      pointerDown = undefined;
      if (dragged) return;
      void openExternalUrl(link.text).catch(onError);
    });
    parent.append(anchor); offset = link.index + link.text.length;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}

/** Owns the plain URL provider and OSC 8 handler for one terminal's lifetime. */
export function installTerminalExternalLinks(terminal: Terminal, onError: (error: unknown) => void) {
  let disposed = false;
  const previous = terminal.options.linkHandler;
  const previousTitle = terminal.element?.getAttribute('title');
  const element = terminal.element;
  let mouseDown: { x: number; y: number } | undefined;
  const rememberMouseDown = (event: MouseEvent) => { mouseDown = { x: event.clientX, y: event.clientY }; };
  element?.addEventListener('mousedown', rememberMouseDown, true);
  const activate = (event: MouseEvent, url: string) => {
    // xterm activates on mouseup even after dragging within the same link.
    // A selection left over from a previous gesture must not block a new click.
    const selecting = terminal.hasSelection() && mouseDown && (event.clientX !== mouseDown.x || event.clientY !== mouseDown.y);
    if (event.button !== 0 || event.shiftKey || selecting) return;
    event.preventDefault(); event.stopPropagation();
    if (!disposed) void openExternalUrl(url).catch(onError);
  };
  const hover = (_event: MouseEvent, url: string) => { if (!disposed) terminal.element?.setAttribute('title', url); };
  const leave = () => { if (previousTitle == null) terminal.element?.removeAttribute('title'); else terminal.element?.setAttribute('title', previousTitle); };
  const handler = { activate, hover, leave };
  terminal.options.linkHandler = handler;
  const provider = terminal.registerLinkProvider({
    provideLinks(y, callback) {
      if (disposed) { callback(undefined); return; }
      const buffer = terminal.buffer.active;
      const readRow = (row: number) => {
        const line = buffer.getLine(row);
        return line ? { row, line, text: line.translateToString(true, 0, MAX_URL_LENGTH) } : undefined;
      };
      const current = readRow(y - 1);
      if (!current) { callback(undefined); return; }
      const rows = [current];
      let cells = Math.min(current.line.length, MAX_URL_LENGTH);
      let clippedStart = false; let clippedEnd = current.line.length > MAX_URL_LENGTH;
      // Cell width is the progress measure even for erased, wrapped blank rows.
      // Stop at whitespace: earlier/later tokens cannot cross the requested row.
      while (rows[0].row > 0 && rows[0].line.isWrapped && rows[0].text && !/^\s/u.test(rows[0].text)) {
        const previous = readRow(rows[0].row - 1); if (!previous) break;
        if (cells + previous.line.length > MAX_URL_LENGTH) { clippedStart = true; break; }
        rows.unshift(previous); cells += previous.line.length;
        if (!previous.text || /\s/u.test(previous.text)) break;
      }
      while (!clippedEnd) {
        const next = readRow(rows.at(-1)!.row + 1);
        if (!next?.line.isWrapped) break;
        // Prefer the requested row's nearby suffix over far-away prefix context.
        while (cells + next.line.length > MAX_URL_LENGTH && rows[0].row < current.row) {
          cells -= rows.shift()!.line.length; clippedStart = true;
        }
        if (cells + next.line.length > MAX_URL_LENGTH) { clippedEnd = true; break; }
        rows.push(next); cells += next.line.length;
        if (!next.text || /\s/u.test(next.text)) break;
      }
      let text = ''; let reads = 0;
      const starts: { x: number; y: number }[] = []; const ends: { x: number; y: number }[] = [];
      const cell = buffer.getNullCell();
      mapping: for (let index = 0; index < rows.length; index++) {
        const { row, line, text: trimmed } = rows[index];
        let used = 0;
        for (let column = 0; column < line.length; column++) {
          if (index === rows.length - 1 && used >= trimmed.length) break;
          if (reads++ >= MAX_URL_LENGTH) { clippedEnd = true; break mapping; }
          if (!line.getCell(column, cell)) continue;
          const width = cell.getWidth(); const chars = cell.getChars();
          if (!width) continue;
          const next = rows[index + 1];
          if (!chars && column === line.length - 1 && next?.line.isWrapped) {
            if (reads++ >= MAX_URL_LENGTH) { clippedEnd = true; break mapping; }
            if (next.line.getCell(0, cell)?.getWidth() === 2) continue;
          }
          const value = chars || ' ';
          if (text.length + value.length > MAX_URL_LENGTH) { clippedEnd = true; break mapping; }
          const start = { x: column + 1, y: row + 1 }; const end = { x: column + width, y: row + 1 };
          for (let unit = 0; unit < value.length; unit++) { starts.push(start); ends.push(end); }
          text += value; used += value.length;
        }
      }
      const boundary = /[\s<>"'`\\]/u;
      const links: ILink[] = linksIn(text).flatMap(link => {
        // Never reinterpret the middle/end of a clipped token as another URL.
        if (clippedStart && !boundary.test(text.slice(0, link.index))) return [];
        if (clippedEnd && !boundary.test(text.slice(link.index + link.text.length))) return [];
        const start = starts[link.index]; const end = ends[link.index + link.text.length - 1];
        return start && end && start.y <= y && end.y >= y ? [{ text: link.text, range: { start, end }, activate, hover, leave }] : [];
      });
      callback(links);
    },
  });
  return { dispose() { if (disposed) return; disposed = true; element?.removeEventListener('mousedown', rememberMouseDown, true); provider.dispose(); leave(); if (terminal.options.linkHandler === handler) terminal.options.linkHandler = previous; } };
}
