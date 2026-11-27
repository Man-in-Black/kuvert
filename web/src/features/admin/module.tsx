import { KeyRound, LayoutDashboard, Puzzle, ScrollText, Server, Shield, SlidersHorizontal, Users } from 'lucide-react';
import type { WebModule } from '@/modules/types';
import { useExtensions } from '@/modules/context';
import { SectionLayout } from '@/layout/SectionLayout';
import { OverviewSection } from './OverviewSection';
import { UsersSection } from './UsersSection';
import { PoliciesSection } from './PoliciesSection';
import { AuditSection } from './AuditSection';
import { SystemSection } from './SystemSection';
import { ServicesSection } from './ServicesSection';
import { ModulesSection } from './ModulesSection';

/** Admin-Bereich: eigene Abschnitte + Abschnitte anderer Module (`admin`-Erweiterungspunkt, z. B. Integrationen) */
function AdminPage() {
  const sections = useExtensions('admin');
  return <SectionLayout title="Admin-Bereich" subtitle="Verwaltung & Sicherheit" icon={<Shield />} basePath="/admin" sections={sections} />;
}

const mod: WebModule = {
  id: 'admin',
  isActive: ({ app }) => !!app.user?.isAdmin,
  nav: [{ path: 'admin', label: 'Admin', icon: Shield, order: 90 }],
  routes: [{ path: 'admin/*', element: <AdminPage /> }],
  admin: [
    { id: 'overview', label: 'Übersicht', icon: LayoutDashboard, order: 0, component: OverviewSection },
    { id: 'users', label: 'Benutzer', icon: Users, order: 10, component: UsersSection },
    { id: 'modules', label: 'Module', icon: Puzzle, order: 12, component: ModulesSection },
    { id: 'services', label: 'Dienste & Anmeldung', icon: KeyRound, order: 15, component: ServicesSection },
    { id: 'policies', label: 'Richtlinien', icon: SlidersHorizontal, order: 20, component: PoliciesSection },
    { id: 'audit', label: 'Audit-Log', icon: ScrollText, order: 30, component: AuditSection },
    { id: 'system', label: 'System', icon: Server, order: 40, component: SystemSection },
  ],
};

export default mod;
