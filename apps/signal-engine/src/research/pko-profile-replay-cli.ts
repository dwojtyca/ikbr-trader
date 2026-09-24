import { readFile } from 'node:fs/promises';
import { replayPkoProfiles } from './pko-profile-replay.js';
const path=process.argv[2];
if(!path)throw Error('Usage: pnpm --filter @ikbr/signal-engine gpw:profile-replay <frozen-json>');
console.log(JSON.stringify(await replayPkoProfiles(await readFile(path,'utf8')),null,2));
