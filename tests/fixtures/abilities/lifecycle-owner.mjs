import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { AbilityController } from '../../../src/desktop/host/abilities/controller.ts';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const controller = new AbilityController({
  ...config.options,
  storage: {
    isEncryptionAvailable: () => false,
    encryptString() {
      throw new Error();
    },
    decryptString() {
      throw new Error();
    },
  },
  open: async () => {},
});
await controller.attach(config.connection);
process.send({ attached: controller.available });
process.on('SIGTERM', async () => {
  await controller.stop();
  process.exit(0);
});
