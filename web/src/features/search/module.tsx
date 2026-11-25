import { Search } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { SearchSettings } from './SearchSettings';

/** Volltext-Suchindex: Einstellungsseite (Status, Konten, Suchbefehle) */
const mod: WebModule = {
  id: 'search',
  feature: 'search',
  settings: [{ id: 'search', label: 'Suche', icon: Search, order: 22, component: SearchSettings }],
};

export default mod;
