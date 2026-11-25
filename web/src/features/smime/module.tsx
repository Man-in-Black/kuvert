import { ShieldCheck } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { SmimeSection } from './SmimeSection';

/** S/MIME: Zertifikatsverwaltung (Signier-/Verschlüsselungsschalter liegen im Mail-Bereich). */
const mod: WebModule = {
  id: 'smime',
  feature: 'smime',
  settings: [{ id: 'smime', label: 'S/MIME', icon: ShieldCheck, order: 80, component: SmimeSection }],
};

export default mod;
