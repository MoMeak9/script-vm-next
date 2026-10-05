import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { examples } from './examples';
import { createCompiler, runCode, type CompileFailure, type CompileResult, type LogEntry } from './runtime';
import './style.css';

declare const __APP_VERSION__: string;
declare const __BUILD_COMMIT__: string;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing playground element: ${id}`);
  return found as T;
}

const compileButton = element<HTMLButtonElement>('compile-button');
const runButton = element<HTMLButtonElement>('run-button');
const stopButton = element<HTMLButtonElement>('stop-button');
const copyButton = element<HTMLButtonElement>('copy-button');
const downloadButton = element<HTMLButtonElement>('download-button');
const exampleSelect = element<HTMLSelectElement>('example-select');
const consoleOutput = element('console-output');
const compiler = createCompiler();
const encoder = new TextEncoder();
let selectedExample = examples[0];
let compiled: CompileResult | undefined;
let compiledSource: string | undefined;
let compiling = false;
let running = false;
let compilationGeneration = 0;
let runGeneration = 0;
let activeRun: ReturnType<typeof runCode> | undefined;
let errorLocation: { line: number; column: number } | undefined;
let logCount = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const sourceEditor = new EditorView({
  doc: selectedExample.source,
  extensions: [
    basicSetup,
    javascript(),
    EditorView.contentAttributes.of({ 'aria-label': 'JavaScript 源码', 'aria-multiline': 'true', spellcheck: 'false' }),
    EditorView.updateListener.of(update => {
      if (!update.docChanged) return;
      updateSourceSize();
      updateButtons();
      element('runtime-details').hidden = true;
      if (!compiling) {
        element('app-status').textContent = '源码已修改，请重新编译';
        element('output-caption').textContent = compiled ? '源码已修改 · 产物待更新' : '等待编译';
      }
      hideError();
    }),
    EditorView.domEventHandlers({
      keydown(event) {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          if (!compiling) void compileSource();
          return true;
        }
        return false;
      },
    }),
  ],
  parent: element('source-editor'),
});

const outputEditor = new EditorView({
  doc: '// 编译完成后，自包含的 JavaScript 产物会显示在这里。',
  extensions: [
    basicSetup,
    javascript(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ 'aria-label': '只读编译产物', 'aria-readonly': 'true', tabindex: '0' }),
    EditorView.theme({
      '&': { color: '#b8c6e3', backgroundColor: '#1b2438' },
      '.cm-gutters': { backgroundColor: '#1b2438', color: '#5c6c8c', border: 'none' },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8194ba' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#394b70' },
      '.cm-cursor': { borderLeftColor: '#afc0e6' },
      '.cm-matchingBracket': { backgroundColor: '#405475', color: '#fff' },
      '.cm-searchMatch': { backgroundColor: '#5b4f23' },
    }, { dark: true }),
  ],
  parent: element('output-editor'),
});

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes.toLocaleString()} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function updateSourceSize(): void {
  element('source-size').textContent = formatBytes(encoder.encode(sourceEditor.state.doc.toString()).byteLength);
}

function updateRuntimeDetails(result: CompileResult): void {
  const runtime = result.stats.runtime;
  element('runtime-details').hidden = !runtime;
  if (!runtime) return;
  const labels = { sync: '同步', async: '异步', generator: '生成器', 'async-generator': '异步生成器' };
  element('runtime-summary').textContent = ` · ${runtime.instructionCount.toLocaleString()} 类指令`;
  element('runtime-modes').textContent = runtime.executionModes.map(mode => labels[mode]).join('、');
}

function updateButtons(): void {
  const current = Boolean(compiled && compiledSource === sourceEditor.state.doc.toString());
  compileButton.disabled = compiling;
  compileButton.setAttribute('aria-busy', String(compiling));
  runButton.disabled = !current || compiling || running;
  stopButton.disabled = !compiling && !running;
  copyButton.disabled = !current || compiling;
  downloadButton.disabled = !current || compiling;
}

function hideError(): void {
  element('error-panel').hidden = true;
  errorLocation = undefined;
}

function showError(error: unknown, title = '编译失败'): void {
  const failure = error instanceof Error ? error as CompileFailure : new Error(String(error)) as CompileFailure;
  element('error-title').textContent = title;
  const location = failure.line
    ? `${failure.filename || 'playground.js'}:${failure.line}:${failure.column ?? 1}`
    : '';
  element('error-message').textContent = [failure.code, location, failure.message].filter(Boolean).join(' · ');
  errorLocation = failure.line ? { line: failure.line, column: failure.column ?? 1 } : undefined;
  element('error-location').hidden = !errorLocation;
  element('error-panel').hidden = false;
}

function setRunStatus(status: string, text: string): void {
  element('run-status').dataset.state = status;
  element('run-status').dataset.status = status;
  element('run-status-text').textContent = text;
}

function stopExecution(): void {
  activeRun?.stop();
  activeRun = undefined;
  running = false;
}

async function compileSource(): Promise<void> {
  stopExecution();
  const generation = ++compilationGeneration;
  const source = sourceEditor.state.doc.toString();
  compiling = true;
  hideError();
  element('app-status').textContent = '正在编译…';
  element('output-caption').textContent = '编译中…';
  element('runtime-details').hidden = true;
  updateButtons();
  try {
    const result = await compiler.compile(source);
    if (generation !== compilationGeneration) return;
    compiled = result;
    compiledSource = source;
    outputEditor.dispatch({ changes: { from: 0, to: outputEditor.state.doc.length, insert: result.code } });
    element('metric-duration').textContent = `${result.durationMs.toFixed(1)} ms`;
    element('metric-size').textContent = formatBytes(encoder.encode(result.code).byteLength);
    element('metric-bytecode').textContent = result.stats.bytecodeWords.toLocaleString();
    element('metric-functions').textContent = result.stats.functionCount.toLocaleString();
    const current = source === sourceEditor.state.doc.toString();
    if (current) updateRuntimeDetails(result);
    element('output-caption').textContent = current ? '编译成功 · IIFE' : '源码已修改 · 产物待更新';
    element('app-status').textContent = current ? '编译完成，可以运行产物' : '源码已修改，请重新编译';
  } catch (error) {
    if (generation !== compilationGeneration) return;
    compiled = undefined;
    compiledSource = undefined;
    showError(error);
    element('output-caption').textContent = '编译失败';
    element('app-status').textContent = '请修改源码后重新编译';
    outputEditor.dispatch({ changes: { from: 0, to: outputEditor.state.doc.length, insert: '// 本次编译失败。请查看诊断信息并修改源码。' } });
    for (const id of ['metric-duration', 'metric-size', 'metric-bytecode', 'metric-functions']) element(id).textContent = '—';
  } finally {
    if (generation === compilationGeneration) {
      compiling = false;
      updateButtons();
    }
  }
}

function clearConsole(): void {
  consoleOutput.replaceChildren();
  const message = document.createElement('p');
  message.id = 'console-empty';
  message.className = 'console-empty';
  message.textContent = '↳ 点击「运行产物」，在这里查看 console 输出。代码不会自动执行。';
  consoleOutput.append(message);
  logCount = 0;
  element('console-count').textContent = '0';
}

function addLog(entry: LogEntry): void {
  if (logCount >= 201) return;
  document.getElementById('console-empty')?.remove();
  const row = document.createElement('div');
  row.className = 'console-entry';
  row.dataset.level = entry.level;
  const prefix = document.createElement('span');
  prefix.className = 'log-prefix';
  prefix.setAttribute('aria-hidden', 'true');
  prefix.textContent = entry.level === 'error' ? '×' : entry.level === 'warn' ? '!' : '›';
  const message = document.createElement('span');
  message.className = 'log-text';
  message.textContent = entry.text.slice(0, 4_000);
  row.append(prefix, message);
  consoleOutput.append(row);
  logCount++;
  element('console-count').textContent = String(logCount);
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function runCompiled(): void {
  if (!compiled || compiledSource !== sourceEditor.state.doc.toString() || compiling || running) return;
  stopExecution();
  hideError();
  clearConsole();
  const generation = ++runGeneration;
  running = true;
  updateButtons();
  try {
    activeRun = runCode(compiled.code, {
      onLog(entry) {
        if (generation === runGeneration) addLog(entry);
      },
      onStatus(status) {
        if (generation !== runGeneration) return;
        const labels = { running: '运行中', completed: '运行完成', stopped: '已停止', timeout: '运行超时' };
        setRunStatus(status, labels[status]);
        if (status !== 'running') {
          running = false;
          activeRun = undefined;
          if (status === 'timeout') addLog({ level: 'warn', text: '运行超过 3 秒，已自动停止。你可以修改代码后重新编译、运行。' });
          if (status === 'completed' && logCount === 0) {
            element('console-empty').textContent = '↳ 运行完成，没有 console 输出。';
          }
          updateButtons();
        }
      },
      onError(message) {
        if (generation !== runGeneration) return;
        running = false;
        activeRun = undefined;
        setRunStatus('error', '运行失败');
        addLog({ level: 'error', text: message });
        updateButtons();
      },
    });
  } catch (error) {
    running = false;
    setRunStatus('error', '运行失败');
    addLog({ level: 'error', text: error instanceof Error ? error.message : String(error) });
    updateButtons();
  }
}

function resetToExample(): void {
  stopExecution();
  ++runGeneration;
  compiler.cancel();
  ++compilationGeneration;
  compiling = false;
  sourceEditor.dispatch({ changes: { from: 0, to: sourceEditor.state.doc.length, insert: selectedExample.source }, selection: { anchor: 0 }, scrollIntoView: true });
  element('example-description').textContent = selectedExample.description;
  clearConsole();
  setRunStatus('idle', '尚未运行');
  void compileSource();
}

function toast(message: string): void {
  if (toastTimer) clearTimeout(toastTimer);
  element('toast').textContent = message;
  element('toast').hidden = false;
  toastTimer = setTimeout(() => { element('toast').hidden = true; }, 2_500);
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    toast('无法访问剪贴板，请选择文本手动复制');
  }
}

for (const example of examples) {
  const option = document.createElement('option');
  option.value = example.id;
  option.textContent = example.label;
  exampleSelect.append(option);
}
exampleSelect.addEventListener('change', () => {
  selectedExample = examples.find(example => example.id === exampleSelect.value) || examples[0];
  resetToExample();
});
compileButton.addEventListener('click', () => { void compileSource(); });
runButton.addEventListener('click', runCompiled);
stopButton.addEventListener('click', () => {
  if (compiling) {
    ++compilationGeneration;
    compiler.cancel();
    compiling = false;
    element('app-status').textContent = '编译已停止';
    element('output-caption').textContent = '编译已停止';
  }
  stopExecution();
  updateButtons();
});
element('reset-button').addEventListener('click', resetToExample);
element('clear-console').addEventListener('click', clearConsole);
copyButton.addEventListener('click', () => { if (compiled) void copyText(compiled.code); });
downloadButton.addEventListener('click', () => {
  if (!compiled) return;
  const url = URL.createObjectURL(new Blob([compiled.code], { type: 'text/javascript;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'example.vm.js';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
});
element('error-location').addEventListener('click', () => {
  if (!errorLocation) return;
  const line = sourceEditor.state.doc.line(Math.min(Math.max(errorLocation.line, 1), sourceEditor.state.doc.lines));
  const anchor = Math.min(line.from + Math.max(errorLocation.column - 1, 0), line.to);
  sourceEditor.dispatch({ selection: { anchor }, scrollIntoView: true });
  sourceEditor.focus();
});
window.addEventListener('pagehide', () => {
  ++compilationGeneration;
  compiler.cancel();
  compiling = false;
  stopExecution();
  updateButtons();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) void compileSource();
});

element('version-label').textContent = `v${__APP_VERSION__}`;
element('release-status').textContent = `预发布准备中 · v${__APP_VERSION__}`;
element('commit-label').textContent = __BUILD_COMMIT__.slice(0, 8);
element('example-description').textContent = selectedExample.description;
updateSourceSize();
void compileSource();
