import type { ArenaMap } from './types';
import { isArenaMap } from './validation';
import yard from '../../../content/maps/yard.json';
// One authored geometry asset is consumed by the browser and the Go server.
if (!isArenaMap(yard)) throw new Error('Invalid authored Yard map');
export const YARD: ArenaMap = yard;
