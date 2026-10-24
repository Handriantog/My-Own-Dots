import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { manifestSchema } from '../../src/shared/abilities/manifest.ts';

await writeFile(
  new URL('../../docs/abilities/manifest.schema.json', import.meta.url),
  JSON.stringify(z.toJSONSchema(manifestSchema, { reused: 'ref' }), null, 2) +
    '\n',
);
