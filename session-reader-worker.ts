/** Plain JavaScript worker source: kept in a .ts module so Pi package *.ts includes it. */
export const sessionReaderWorkerSource = String.raw`
const { parentPort } = require('node:worker_threads');
const { open } = require('node:fs/promises');
const { resolve, isAbsolute } = require('node:path');

const BLOCK = 64 * 1024;
const SAMPLE = 4096;
const MAX_HEADER = 1024 * 1024;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 8;
const files = new Map();
const stats = { bytesRead: 0, parsedLines: 0, fullLoads: 0, incrementalLoads: 0 };
let nextEpoch = 1;

function normalizedPath(path) {
  const full = resolve(path);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}
function object(value) { return value !== null && typeof value === 'object'; }
function headerError() { return new Error("Child session header is missing or malformed; verify the child's saved session file."); }
function validate(header, expected) {
  if (!object(header) || header.type !== 'session' || typeof header.id !== 'string' || !header.id ||
      typeof header.cwd !== 'string' || !isAbsolute(header.cwd)) throw headerError();
  if (expected.sessionId && header.id !== expected.sessionId) throw new Error('Child session identity does not match its saved record; verify the session file.');
  if (expected.cwd && normalizedPath(header.cwd) !== normalizedPath(expected.cwd)) throw new Error('Child session cwd does not match its saved record; verify the session file.');
  if (header.version !== expected.version) throw new Error('Child session version requires migration or a compatible Pi version; inspection will not migrate history.');
}
function chat(entry) {
  if (entry.type !== 'message' || !object(entry.message)) return undefined;
  const { role, content } = entry.message;
  if (role !== 'user' && role !== 'assistant') return undefined;
  const parts = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (!object(part)) continue;
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      else if (part.type === 'image') parts.push('[image omitted]');
    }
  }
  const text = parts.join('\n');
  return text ? { id: entry.id, role, text } : undefined;
}
async function readAt(file, length, offset) {
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await file.read(buffer, total, length - total, offset + total);
    if (!bytesRead) break;
    total += bytesRead;
    stats.bytesRead += bytesRead;
  }
  return buffer.subarray(0, total);
}
function fresh() {
  return { epoch: nextEpoch++, revision: 0, header: undefined, byId: new Map(), leaf: null,
    size: 0, offset: 0, headerScanned: 0, pending: Buffer.alloc(0), provisional: undefined, branch: undefined };
}
function install(state, entry) {
  if (!object(entry) || typeof entry.type !== 'string' || typeof entry.id !== 'string' || !entry.id || entry.type === 'session') return;
  const previous = state.byId.get(entry.id);
  const item = { entry, chat: chat(entry), revision: ++state.revision };
  state.byId.set(entry.id, item);
  state.leaf = entry.id;
  state.branch = undefined;
  return { id: entry.id, previous };
}
function parseLine(state, buffer, expected, offset) {
  const line = buffer.toString('utf8');
  if (!line.trim()) return undefined;
  let entry;
  try { entry = JSON.parse(line); stats.parsedLines++; }
  catch (error) { if (!state.header) throw headerError(); return undefined; }
  if (!state.header) {
    validate(entry, expected); state.header = entry;
    state.headerOffset = offset; state.headerBytes = Buffer.from(buffer);
    return undefined;
  }
  return install(state, entry);
}
function removeProvisional(state) {
  const provisional = state.provisional;
  if (!provisional) return;
  const { id, previous, leaf } = provisional;
  if (previous) state.byId.set(id, previous);
  else state.byId.delete(id);
  state.leaf = leaf;
  state.provisional = undefined;
  state.branch = undefined;
  return provisional;
}
async function scan(file, state, size, expected) {
  const previousTail = removeProvisional(state);
  const consume = (buffer, offset) => {
    // Completing an already valid unterminated record with LF must not clone
    // or reparse its potentially giant unchanged payload a second time.
    if (previousTail && previousTail.buffer.equals(buffer)) {
      state.byId.set(previousTail.id, previousTail.item);
      state.leaf = previousTail.id;
      state.branch = undefined;
      return { id: previousTail.id, previous: previousTail.previous };
    }
    return parseLine(state, buffer, expected, offset);
  };
  let parts = state.pending.length ? [state.pending] : [];
  let length = state.pending.length;
  while (state.offset < size) {
    const block = await readAt(file, Math.min(BLOCK, size - state.offset), state.offset);
    if (!block.length) throw new Error('Child session changed while reading; retry inspection.');
    state.offset += block.length;
    let start = 0;
    let newline;
    while ((newline = block.indexOf(10, start)) !== -1) {
      const part = block.subarray(start, newline);
      if (part.length) { parts.push(part); length += part.length; }
      if (!state.header) {
        state.headerScanned += length + 1;
        if (state.headerScanned > MAX_HEADER) throw new Error('Child session header exceeds the 1 MiB inspection limit.');
      }
      consume(parts.length === 1 ? parts[0] : Buffer.concat(parts, length), state.offset - block.length + newline - length);
      parts = []; length = 0; start = newline + 1;
    }
    if (start < block.length) { const part = block.subarray(start); parts.push(part); length += part.length; }
    if (!state.header && state.headerScanned + length > MAX_HEADER) throw new Error('Child session header exceeds the 1 MiB inspection limit.');
  }
  state.pending = parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts, length);
  if (state.pending.length) {
    const leaf = state.leaf;
    const provisional = consume(state.pending, state.offset - state.pending.length);
    if (provisional) state.provisional = { ...provisional, leaf, buffer: state.pending, item: state.byId.get(provisional.id) };
  }
  if (!state.header) throw headerError();
  validate(state.header, expected);
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs; }
function sameStamp(a, b) { return sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function remember(path, state) {
  files.delete(path); files.set(path, state);
  let bytes = 0;
  for (const value of files.values()) bytes += value.size;
  for (const [key, value] of files) {
    if (files.size <= MAX_FILES && bytes <= MAX_CACHE_BYTES) break;
    // A single large file may be used by this request but need not remain cached.
    files.delete(key); bytes -= value.size;
  }
}
async function load(path, expected) {
  const file = await open(path, 'r');
  try {
    const stamp = await file.stat();
    let state = files.get(path);
    if (state && sameStamp(state.stamp, stamp)) {
      validate(state.header, expected); remember(path, state); return state;
    }
    let append = state && sameFile(state.stamp, stamp) && stamp.size > state.size;
    if (append) {
      // Native sessions append. Check both header bytes and the previous EOF to
      // reject replacement/truncation/rewrite instead of trusting size alone.
      const prefix = await readAt(file, state.prefix.length, 0);
      const tail = await readAt(file, state.tail.length, state.size - state.tail.length);
      append = prefix.equals(state.prefix) && tail.equals(state.tail);
      if (append && state.headerOffset + state.headerBytes.length > state.prefix.length) {
        const header = await readAt(file, state.headerBytes.length, state.headerOffset);
        append = header.equals(state.headerBytes);
      }
    }
    if (!append) { state = fresh(); stats.fullLoads++; }
    else stats.incrementalLoads++;
    await scan(file, state, stamp.size, expected);
    const after = await file.stat();
    if (!sameStamp(stamp, after)) {
      files.delete(path);
      throw new Error('Child session changed while reading; retry inspection.');
    }
    state.size = stamp.size;
    state.stamp = stamp;
    state.prefix = await readAt(file, Math.min(SAMPLE, state.size), 0);
    state.tail = await readAt(file, Math.min(SAMPLE, state.size), Math.max(0, state.size - SAMPLE));
    remember(path, state);
    return state;
  } catch (error) { files.delete(path); throw error; }
  finally { await file.close(); }
}
function branch(state) {
  if (state.branch) return state.branch;
  const entries = [];
  const visited = new Set();
  let id = state.leaf;
  while (id) {
    if (visited.has(id)) throw new Error('Child session contains a cyclic branch; verify its saved session file.');
    visited.add(id);
    const item = state.byId.get(id);
    if (!item) break;
    entries.push(item);
    id = item.entry.parentId;
  }
  entries.reverse();
  state.branch = { entries, positions: new Map(entries.map((item, index) => [item.entry.id, index])) };
  return state.branch;
}
function cursorError(reason) {
  return new Error('Invalid conversation cursor (' + reason + '). Reset by omitting cursor in readConversation (tool callers: set fromStart:true) to read the active branch from the start.');
}
function page(state, request) {
  const { entries, positions } = branch(state);
  let position = request.position;
  const start = position.id === null ? 0 : positions.get(position.id);
  if (start === undefined) throw cursorError('entry is no longer on the active branch');
  if (position.offset > (entries[start]?.chat?.text.length ?? 0)) throw cursorError('text offset is out of range');
  let remaining = request.maxChars;
  const messages = [];
  let hasMore = false;
  for (let i = start; i < entries.length; i++) {
    const item = entries[i];
    const message = item.chat;
    const offset = i === start ? position.offset : 0;
    if (!message || offset === message.text.length) {
      position = { id: item.entry.id, offset: message?.text.length ?? 0 };
      continue;
    }
    if (messages.length >= request.limit || remaining <= 0) { hasMore = true; break; }
    const text = message.text.slice(offset, offset + remaining);
    messages.push({ id: message.id, role: message.role, text, ...(offset > 0 ? { continued: true } : {}) });
    remaining -= text.length;
    position = { id: message.id, offset: offset + text.length };
    if (position.offset < message.text.length) { hasMore = true; break; }
  }
  return { messages, position, hasMore };
}
async function execute(request) {
  if (request.kind === 'stats') return { ...stats, cachedFiles: files.size };
  const state = await load(normalizedPath(request.path), request.expected);
  if (request.kind === 'page') return page(state, request);
  const active = branch(state).entries;
  const sameEpoch = request.epoch === state.epoch;
  return { header: state.header, size: state.size, epoch: state.epoch, revision: state.revision,
    ids: sameEpoch && request.revision === state.revision ? undefined : active.map(item => item.entry.id),
    entries: active.filter(item => !sameEpoch || item.revision > request.revision || item.sentAt === undefined || item.sentAt > request.revision).map(item => {
      item.sentAt ??= state.revision;
      return item.entry;
    }) };
}
// Serialize requests: each file's provisional tail and append offset have one owner.
let queue = Promise.resolve();
parentPort.on('message', request => {
  queue = queue.then(async () => {
    try { parentPort.postMessage({ id: request.id, value: await execute(request) }); }
    catch (error) { parentPort.postMessage({ id: request.id, error: { message: error.message, code: error.code } }); }
  });
});
`;
