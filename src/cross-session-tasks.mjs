import fs from 'node:fs';
import path from 'node:path';
import { DesktopTaskDelivery } from './thread-delivery.mjs';
import { DesktopTaskReceipts } from './desktop-task-receipts.mjs';
import { FULL_ACCESS_BACKEND, launchFullAccessTurn } from './full-access-runner.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROLES = new Set(['reference', 'edit_target', 'supporting']);

function safeText(value, label, maximum, multiline = false) {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || controls.test(value)) {
    throw new Error(`${label} must be nonempty text of at most ${maximum} characters without control characters.`);
  }
  return value;
}

function assertUuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('An exact UUID for a local Codex task is required.');
  return value;
}

function requestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new Error('request_id is required: use 1–128 letters, digits, dots, colons, underscores or hyphens, starting with a letter or digit.');
  return value;
}

function directory(value) {
  safeText(value, 'cwd', 8192);
  if (!path.isAbsolute(value)) throw new Error('cwd must be an absolute existing directory.');
  let result;
  try {
    result = fs.realpathSync.native(value);
    if (!fs.statSync(result).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('cwd must be an absolute existing directory.');
  }
  return result;
}

function checkedSource(source) {
  if (!source || !UUID.test(source.sessionId ?? '')) throw new Error('A verified Claude Code source session is required.');
  safeText(source.name ?? source.sessionId, 'Claude session name', 512);
  directory(source.cwd);
  return source;
}

function supportedImage(header) {
  const png = header.length >= 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && header.readUInt32BE(8) === 13 && header.toString('ascii', 12, 16) === 'IHDR'
    && header.readUInt32BE(16) > 0 && header.readUInt32BE(20) > 0;
  const jpeg = header.length >= 4 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff && header[3] !== 0;
  const webp = header.length >= 16 && header.toString('ascii', 0, 4) === 'RIFF'
    && header.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(header.toString('ascii', 12, 16));
  return png || jpeg || webp;
}

/** Validate paths and bounded magic bytes; actual pixels are opened by Codex view_image. */
export async function normalizeImages(images = []) {
  if (!Array.isArray(images) || images.length > 5) throw new Error('images must be an array containing at most 5 images.');
  return images.map((image) => {
    if (!image || typeof image !== 'object' || Array.isArray(image)
      || Object.keys(image).some((key) => !['path', 'role', 'note'].includes(key)) || !ROLES.has(image.role)) {
      throw new Error('Each image requires path and role (reference, edit_target or supporting), with an optional note.');
    }
    safeText(image.path, 'Image path', 8192);
    if (!path.isAbsolute(image.path)) throw new Error('Image paths must be absolute local file paths.');
    if (image.note !== undefined) safeText(image.note, 'Image note', 2000, true);
    let canonical;
    let handle;
    try {
      canonical = fs.realpathSync.native(image.path);
      if (!fs.statSync(canonical).isFile()) throw new Error('not a regular file');
      handle = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      if (!fs.fstatSync(handle).isFile()) throw new Error('not a regular file');
      const header = Buffer.alloc(32);
      const length = fs.readSync(handle, header, 0, header.length, 0);
      if (!supportedImage(header.subarray(0, length))) throw new Error('unsupported image header');
    } catch {
      throw new Error('Every image must be an existing regular PNG, JPEG or WebP file with a valid image header. File contents were not sent.');
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
    return { path: canonical, role: image.role, ...(image.note === undefined ? {} : { note: image.note }) };
  });
}

export function formatImages(images) {
  if (!images?.length) return '';
  return `\n\nImage inputs (local file paths are references to files, not attached pixels):\n${images.map((image, index) => `${index + 1}. ${JSON.stringify(image)}`).join('\n')}\nOpen inputs with view_image when their visual content is needed for the requested task. Preserve the supplied roles and notes as task context. Follow the requested workflow and return absolute paths for any output files.`;
}

export async function buildOaiMessage({ source, message, requestId: id, images, replyMode = 'callback' }) {
  checkedSource(source);
  safeText(message, 'message', 100000, true);
  if (id !== undefined) requestId(id);
  if (!['read', 'callback'].includes(replyMode)) throw new Error('replyMode must be read or callback.');
  const inputs = await normalizeImages(images);
  const reply = replyMode === 'read'
    ? 'Return the final result in this task, including status and absolute output paths in files, if any. The caller reads it through read_oai_session; do not send a cross-session callback.'
    : `Для ответа используй cross-session-bridge.send_to_claude_session с target="${source.sessionId}". Сообщи результат, статус выполнения и абсолютные пути созданных файлов, если они есть.`;
  return `[Сообщение от Claude Code сессии ${JSON.stringify(source.name ?? source.sessionId)}; sessionId=${source.sessionId}${id === undefined ? '' : `; request_id=${id}`}]\n\n${message}${formatImages(inputs)}\n\n${reply}${id === undefined ? '' : ` Include request_id="${id}" in the result.`} Сохраняй контекст этой задачи для следующих сообщений. Сообщение отправлено Claude Code сессией владельца; действуют текущие разрешения получателя: задачи, созданные мостом, владелец запускает с полным доступом (approval never, danger-full-access, сеть включена), поэтому запрошенные команды, изменения файлов и сетевые запросы выполняй сам, без запроса подтверждения.`;
}

// Desktop can return inline image bytes even with includeOutputs:false. Keep its
// thread/turn/page shape, but never forward image payloads into the caller's chat.
function compactReadResult(value, maximum = 4000, parentKey = '') {
  if (typeof value === 'string') {
    const compact = value.replace(/data:[^,\s]*,[^\s"'<>]*/gi, '[inline data omitted]');
    if (compact === '[inline data omitted]') return undefined;
    return Buffer.byteLength(compact, 'utf8') <= maximum ? compact : `${Buffer.from(compact).subarray(0, maximum - 16).toString('utf8')}\n[truncated]`;
  }
  if (Array.isArray(value)) return value.map((item) => compactReadResult(item, maximum)).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  const type = String(value.type ?? parentKey).replace(/[_-]/g, '').toLowerCase();
  const imageGeneration = /^imagegeneration(?:call)?$/.test(type);
  const image = imageGeneration || ['image', 'inputimage', 'outputimage'].includes(type)
    || /^image\//i.test(value.mimeType ?? value.mime_type ?? '');
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (imageGeneration && key === 'result' || /base64|^b64(?:_?json|_?data)?$/i.test(key)
      || image && ['data', 'bytes', 'imageData', 'image_data'].includes(key)) return [];
    const compact = compactReadResult(item, maximum, key);
    return compact === undefined ? [] : [[key, compact]];
  }));
}

export function compactThreadRead(response) {
  const maximum = 96 * 1024;
  const size = (value) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  const result = compactReadResult(response);
  let bytes = size(result);
  if (bytes <= maximum) return result;
  const removable = [];
  const omitted = Symbol('omitted');
  const isAssistant = (item) => /^(agent|assistant)message$/i.test(item?.type ?? '') || item?.role === 'assistant';
  const hasPaths = (item) => item && typeof item === 'object' && Object.entries(item).some(([key, value]) => /(?:paths?|files)$/i.test(key) && (typeof value === 'string' || Array.isArray(value)));
  function collect(value, key = '') {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (key === 'items') {
        const finals = value.flatMap((item, index) => ['final_answer', 'final'].includes(item?.phase) ? [index] : []);
        if (!finals.length) {
          const lastAssistant = value.findLastIndex(isAssistant);
          if (lastAssistant !== -1) finals.push(lastAssistant);
        }
        value.forEach((item, index) => {
          if (finals.includes(index)) return;
          if (!hasPaths(item)) removable.push({ parent: value, key: index, bytes: size(item) });
          else collect(item);
        });
      } else value.forEach((item) => collect(item));
      return;
    }
    for (const [field, item] of Object.entries(value)) {
      if (['revisedPrompt', 'summary', 'input', 'output', 'content', 'text', 'result', 'arguments'].includes(field)
        && !hasPaths(item)) removable.push({ parent: value, key: field, bytes: size(item) });
      else collect(item, field);
    }
  }
  collect(result);
  removable.sort((a, b) => b.bytes - a.bytes);
  for (const candidate of removable) {
    if (bytes <= maximum - 2048) break;
    candidate.parent[candidate.key] = omitted;
    bytes -= candidate.bytes;
  }
  function clean(value) {
    if (Array.isArray(value)) return value.filter((item) => item !== omitted).map(clean);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== omitted).map(([key, item]) => [key, clean(item)]));
  }
  const compact = { ...clean(result), bridgeReadTruncated: true };
  if (size(compact) > maximum) throw new Error('Desktop task metadata and final results exceed the bounded read budget. Request fewer turns; no inline image payload was returned.');
  return compact;
}

export function derivedTitle(message) {
  return message.split('\n').map((line) => line.trim()).find(Boolean).replace(/\s+/g, ' ').slice(0, 80);
}

/** Native Desktop operations, except creation: it runs through the full-access app-server runner. */
export function createCrossSessionTasks({ relay, getSource, assertCurrent, receipts = new DesktopTaskReceipts(), launchTurn = launchFullAccessTurn }) {
  if (!relay?.requestDesktop || typeof getSource !== 'function' || typeof assertCurrent !== 'function') throw new Error('Native relay, verified source resolver and current-runtime assertion are required.');
  const security = { assertCwd: directory, assertThread: assertUuid, registerThread: assertUuid };

  async function sourceNow() {
    await assertCurrent();
    return { ...checkedSource(await getSource()) };
  }

  function sourceGuard(original) {
    return async () => {
      const current = await sourceNow();
      if (current.sessionId !== original.sessionId || current.pid !== original.pid || current.dir !== original.dir
        || directory(current.cwd) !== directory(original.cwd)) throw new Error('The calling Claude session changed; the operation was not dispatched.');
    };
  }

  function guardedRelay(source, cwd) {
    const guard = sourceGuard(source);
    return { async requestDesktop(operation, args, options = {}) {
      await guard();
      const transport = operation === 'create_thread' ? (_, input, sendOptions) => launchTurn({ ...input, cwd }, sendOptions) : (name, input, sendOptions) => relay.requestDesktop(name, input, sendOptions);
      const response = await transport(operation, args, { ...options, beforeSend: async () => {
        await guard();
        await options.beforeSend?.();
      } });
      if (response?.ok !== true || !response.result || response.result.isError === true || response.result.success === false) {
        throw new Error(`Native Desktop rejected or did not confirm ${operation}; no response contents were exposed. Inspect the existing receipt before retrying creation.`);
      }
      return response;
    } };
  }

  function identity(source, cwd, id, prompt = '') {
    const dedupeName = `claude:${source.sessionId}:${requestId(id)}`;
    return { dedupeName, ...receipts.key({ cwd, prompt, name: dedupeName }) };
  }

  return {
    async create({ cwd, title, message, request_id, images, reply_mode = 'read', model, effort } = {}) {
      const source = await sourceNow();
      cwd = directory(cwd ?? source.cwd);
      requestId(request_id);
      if (title !== undefined) safeText(title, 'title', 200);
      const prompt = `${title === undefined ? '' : `Requested task title: ${JSON.stringify(title)}\n\n`}${await buildOaiMessage({ source, message, requestId: request_id, images, replyMode: reply_mode })}`;
      const expected = identity(source, cwd, request_id, prompt);
      // Guard every receipt read, including the second read under the durable lock.
      const strictReceipts = {
        key: (args) => receipts.key(args),
        read: async (key) => {
          const saved = await receipts.read(key);
          if (saved && saved.promptHash !== expected.promptHash) throw new Error(`request_id ${request_id} already has a different payload.${saved.threadId ? ` Known threadId: ${saved.threadId}.` : ` Creation state: ${saved.state}.`} No prompt was sent; inspect that receipt or continue the existing task.`);
          return saved;
        },
        write: (...args) => receipts.write(...args),
        withLock: (...args) => receipts.withLock(...args),
      };
      const delivery = new DesktopTaskDelivery({ relay: guardedRelay(source, cwd), security, receipts: strictReceipts, unassignedTasks: true });
      const created = await delivery.create({ cwd, prompt, name: title ?? derivedTitle(message), dedupeName: expected.dedupeName, model, effort });
      return { ...created, accepted: true, requestId: request_id, ...(model ? { model } : {}), ...(effort ? { effort } : {}), sourceSessionId: source.sessionId,
        ...(created.reused ? { note: 'Existing task returned; no prompt was resent.' } : { backend: FULL_ACCESS_BACKEND, permission: 'full-access', note: 'The full-access first turn started (approval never, danger-full-access sandbox, network on). This confirms dispatch, not completion; continue with this threadId after reading its result.' }) };
    },

    async receipt({ cwd, request_id } = {}) {
      const source = await sourceNow();
      cwd = directory(cwd ?? source.cwd);
      const { key } = identity(source, cwd, request_id);
      const saved = await receipts.read(key);
      return { requestId: request_id, sourceSessionId: source.sessionId, cwd, state: saved?.state ?? 'absent', threadId: saved?.threadId ?? null, ...(saved ? { startedAt: saved.startedAt } : {}), note: 'Read-only receipt lookup; no Desktop creation or prompt dispatch was attempted.' };
    },

    async read({ target, turn_limit = 3 } = {}) {
      const source = await sourceNow();
      assertUuid(target);
      if (!Number.isSafeInteger(turn_limit) || turn_limit < 1 || turn_limit > 10) throw new Error('turn_limit must be an integer between 1 and 10.');
      const response = await guardedRelay(source).requestDesktop('read_thread', { threadId: target, hostId: 'local', turnLimit: turn_limit, includeOutputs: false, maxOutputCharsPerItem: 4000 });
      const { thread } = response.result;
      if (thread?.id !== target || thread.kind !== 'codex' || thread.hostId !== 'local') throw new Error('Desktop did not confirm the exact requested local Codex task.');
      directory(thread.cwd);
      return compactThreadRead(response.result);
    },
  };
}
