import { createContext } from 'react';
import type { Dot } from '../shared/types';

export const DotAppearanceContext = createContext<Dot[]>([]);
