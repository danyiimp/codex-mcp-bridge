import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export async function readRemoteSession(target, turnLimit = 3) {
  const socketPath = path.join(os.homedir(), '.remote-peers', 'control.sock');
  if (!fs.lstatSync(socketPath).isSocket()) throw new Error('Remote peers transport is not connected.');
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => socket.destroy(new Error('Remote read timeout')));
    socket.on('error', reject);
    socket.on('end', () => { if (!buffer.includes('\n')) reject(new Error('Remote read connection closed without a result')); });
    socket.on('connect', () => socket.write(JSON.stringify({ target, turnLimit }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1048576) return socket.destroy(new Error('Remote read exceeds the response limit'));
      if (!buffer.includes('\n')) return;
      socket.end();
      try {
        const result = JSON.parse(buffer.split('\n')[0]);
        if (result.error) reject(new Error(result.error));
        else resolve(result.result);
      } catch (error) { reject(error); }
    });
  });
}
