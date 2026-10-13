// Shared terminal UI. See CONSOLE_UI.md. No dependencies or network side effects.
import { AsyncLocalStorage } from 'node:async_hooks';

const colored = Boolean(process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb');
const ansi = code => colored ? `\x1b[${code}m` : '';
export const c = Object.fromEntries(Object.entries({ reset: 0, bold: 1, dim: 2, red: 31,
  green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 }).map(([k, v]) => [k, ansi(v)]));
export const glyph = { ok: '✓', err: '✗', warn: '!', info: 'i', wait: '…', arrow: '→' };
const plain = value => String(value).replace(/\x1b\[[0-9;]*m/g, '');
export const visibleLength = value => plain(value).length;
const pad = (value, width, right = false) => {
  const spaces = ' '.repeat(Math.max(0, width - visibleLength(value)));
  return right ? spaces + value : value + spaces;
};
const paint = (value, color) => `${c[color] || ''}${value}${c.reset}`;
const valid = value => value != null && value !== '' && Number.isFinite(Number(value));
const decimal = (value, digits) => valid(value)
  ? Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const unit = (value, digits, suffix) => valid(value) ? `${decimal(value, digits)} ${suffix}` : '—';
export const fmt = {
  eth: value => unit(value, 4, 'ETH'), sol: value => unit(value, 4, 'SOL'),
  usd: value => valid(value) ? `$${decimal(value, 2)}` : '—',
  usdc: value => unit(value, 2, 'USDC'), pct: value => valid(value) ? `${decimal(Number(value) * 100, 1)}%` : '—',
  num: value => valid(value) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—',
  bool: value => value == null || Number.isNaN(value) ? '—' : paint(value ? 'yes' : 'no', value ? 'green' : 'dim'),
  addr: value => value ? (String(value).length > 12 ? `${String(value).slice(0, 8)}…${String(value).slice(-4)}` : String(value)) : '—',
  dur: value => {
    if (!valid(value)) return '—';
    const seconds = Math.floor(Math.max(0, Number(value)) / 1000);
    return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
      : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  },
  trunc: (value, width = 40) => value == null || Number.isNaN(value) ? '—' : plain(value).length > width
    ? plain(value).slice(0, Math.max(0, width - 1)) + '…' : String(value),
  status: value => value == null || Number.isNaN(value) ? '—' : paint(value,
    /^(ok|completed|done|success)$/i.test(value) ? 'green' : /^(pending|processing)$/i.test(value) ? 'yellow'
      : /^(failed|error)$/i.test(value) ? 'red' : 'dim'),
};

let tagWidth = 12, total = 0;
export const setTagWidth = width => { tagWidth = Math.max(1, Math.floor(width)); };
export const setTotal = value => { total = Math.max(0, Math.floor(value)); };
const stamp = () => new Date().toISOString().slice(11, 19);
function line(tag, color, message, index, count = total, stream = process.stdout) {
  const progress = index == null ? '' : ` [${pad(String(index), String(count).length, true)}/${count}]`;
  stream.write(`[${stamp()}]${progress} [${pad(fmt.trunc(tag, tagWidth), tagWidth)}] ${paint(message, color)}\n`);
}
export const log = (tag, color, message) => line(tag, color, message);
const states = { ok: 'green', err: 'red', warn: 'yellow', info: 'cyan', step: 'dim' };
const symbol = kind => kind === 'step' ? glyph.arrow : glyph[kind];
const status = kind => (tag, message) => line(tag, states[kind], `${symbol(kind)} ${message}`,
  undefined, total, kind === 'err' ? process.stderr : process.stdout);
export const ok = status('ok'), err = status('err'), warn = status('warn'), info = status('info'), step = status('step');
export function counter(count) {
  const context = new AsyncLocalStorage();
  let current = 0;
  const result = { tick() { const index = ++current; context.enterWith(index); return index; } };
  result.log = (tag, color, message) => line(tag, color, message, context.getStore() ?? current, count);
  for (const [kind, color] of Object.entries(states)) result[kind] = (tag, message) =>
    line(tag, color, `${symbol(kind)} ${message}`, context.getStore() ?? current, count,
      kind === 'err' ? process.stderr : process.stdout);
  return result;
}
export const divider = (char = '─', color = 'gray') => console.log(paint(char.repeat(Math.min(process.stdout.columns || 76, 100)), color));
export function banner(title, subtitle = '') { divider('═'); console.log(`  ${paint(title, 'bold')}${subtitle ? '  ' + subtitle : ''}`); divider('═'); }
export function section(title) { console.log(`\n${paint(title, 'bold')}`); }
export function summary(fields, { title } = {}) {
  if (title) section(title);
  const rows = Object.entries(fields), width = Math.max(0, ...rows.map(([key]) => visibleLength(key)));
  const values = Math.max(0, ...rows.map(([, value]) => visibleLength(value ?? '—')));
  for (const [key, value] of rows) console.log(`  ${pad(key, width)}  ${pad(value ?? '—', values, true)}`);
}
export function done(stats, { title = 'Run complete' } = {}) { divider('═'); summary(stats, { title }); divider('═'); }
export function table(rows, { columns, borders = false }) {
  const cells = rows.map(row => columns.map(col => String(col.fmt ? col.fmt(row[col.key]) : row[col.key] ?? '—')));
  const widths = columns.map((col, i) => Math.max(visibleLength(col.label), ...cells.map(row => visibleLength(row[i]))));
  const render = values => console.log('  ' + values.map((value, i) => pad(value, widths[i], columns[i].align === 'right')).join('  '));
  if (borders) divider();
  render(columns.map(col => col.label));
  cells.forEach(render);
  if (borders) divider();
}
export function grid(items, render, { cols = 10 } = {}) {
  const cells = items.map((item, i) => { const row = render(item, i); return `${row.label ?? i + 1}: ${row.cells.join('')}`; });
  const width = Math.max(0, ...cells.map(visibleLength));
  cols = Math.max(1, Math.floor(cols));
  for (let i = 0; i < cells.length; i += cols) console.log(cells.slice(i, i + cols).map(cell => pad(cell, width)).join('    '));
}
export function live({ format = state => Object.entries(state).map(([key, value]) => `${key}: ${value}`).join('  ') } = {}) {
  let state = {}, stopped = false, last = 0, rendered = false, timer;
  const tty = Boolean(process.stdout.isTTY && process.env.TERM !== 'dumb');
  function draw() {
    last = Date.now(); rendered = true;
    const value = format(state);
    process.stdout.write(tty ? `\x1b[?25l\x1b[2K\r${fmt.trunc(value, (process.stdout.columns || 80) - 1)}` : `[${stamp()}] ${value}\n`);
  }
  function stop() {
    if (stopped) return;
    stopped = true; clearTimeout(timer);
    if (tty && rendered) process.stdout.write('\x1b[?25h\n');
    process.removeListener('exit', stop); process.removeListener('SIGINT', interrupt);
  }
  function interrupt() { stop(); process.exit(130); }
  process.once('exit', stop); process.once('SIGINT', interrupt);
  return { set(update) {
    if (stopped) return;
    Object.assign(state, update);
    if (tty || Date.now() - last >= 5000) { clearTimeout(timer); timer = undefined; draw(); }
    else if (!timer) { timer = setTimeout(() => { timer = undefined; draw(); }, 5000 - (Date.now() - last)); timer.unref(); }
  }, stop };
}
export default { c, glyph, fmt, setTagWidth, setTotal, log, ok, err, warn, info, step,
  counter, banner, section, divider, summary, done, table, grid, live };
