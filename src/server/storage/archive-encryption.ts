import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { Decrypter, Encrypter } from 'age-encryption';

// Node and DOM declarations describe the same runtime Web Streams differently.
const web = (stream: Readable) =>
  Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
const node = (stream: ReadableStream<Uint8Array>) =>
  Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>);
export async function encryptArchiveStream(
  source: Readable,
  passphrase: string,
): Promise<Readable> {
  const encrypter = new Encrypter();
  encrypter.setPassphrase(passphrase);
  return node(await encrypter.encrypt(web(source)));
}

/** Preflight the bounded header before the library parses it or derives a key.
 * Reuse those exact bytes and the same descriptor so path replacement cannot
 * bypass the work-factor limit. The library authenticates the complete stream.
 */
export async function openArchiveStream(
  path: string,
  passphrase: string | undefined,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let input: Readable | undefined;
  try {
    if (!(await file.stat()).isFile())
      throw new Error('Archive source must be a regular file');
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    const encrypted = !(head[0] === 0x1f && head[1] === 0x8b);
    if (encrypted) {
      const text = head.toString('ascii');
      if (!text.startsWith('age-encryption.org/v1\n'))
        throw new Error('Unsupported archive encoding');
      const mac = text.indexOf('\n--- ');
      const end = text.indexOf('\n', mac + 1);
      if (mac < 0 || end < 0)
        throw new Error('Archive encryption header exceeds limit');
      const stanzas = text
        .slice(0, mac)
        .split('\n')
        .filter((line) => line.startsWith('-> '));
      if (
        stanzas.length !== 1 ||
        !/^-> scrypt [A-Za-z0-9+/]+ (?:[1-9]|1[0-8])$/.test(stanzas[0])
      )
        throw new Error('Unsupported encryption recipient or work factor');
      if (!passphrase) throw new Error('A recovery passphrase is required');
    }
    input = Readable.from(
      (async function* () {
        yield head;
        yield* file.createReadStream({
          start: bytesRead,
          autoClose: false,
          signal,
        });
      })(),
      { signal },
    );
    const stream = encrypted
      ? await (async () => {
          const decrypter = new Decrypter();
          decrypter.addPassphrase(passphrase!);
          return node(await decrypter.decrypt(web(input!)));
        })()
      : input;
    return {
      encrypted,
      stream,
      async close() {
        stream.destroy();
        input?.destroy();
        await file.close();
      },
    };
  } catch (error) {
    input?.destroy();
    await file.close();
    throw error;
  }
}
