import { MAX_DECALS } from '../../maps/decals';

// Alpha order is independent of camera distance: wear, authored decals, combat effects.
export const FLOOR_LAYERS = {
  wear: -MAX_DECALS - 1,
  decalStart: -MAX_DECALS,
  decalHeightCells: 0.009,
};
