/** Deutsche Bezeichnungen für Audit-Log-Aktionen. Unbekannte Aktionen werden roh angezeigt. */
const LABELS: Record<string, string> = {
  'auth.setup': 'Ersteinrichtung',
  'auth.login': 'Anmeldung',
  'auth.login_failed': 'Fehlgeschlagene Anmeldung',
  'auth.2fa_failed': '2FA-Code falsch',
  'auth.2fa_enabled': '2FA aktiviert',
  'auth.2fa_disabled': '2FA deaktiviert',
  'auth.2fa_recovery_regenerated': 'Wiederherstellungscodes erneuert',
  'auth.register': 'Registrierung',
  'auth.password_changed': 'Passwort geändert',
  'admin.user_created': 'Benutzer angelegt',
  'admin.user_updated': 'Benutzer geändert',
  'admin.user_deleted': 'Benutzer gelöscht',
  'admin.password_reset': 'Passwort zurückgesetzt',
  'admin.2fa_reset': '2FA zurückgesetzt',
  'admin.sessions_revoked': 'Überall abgemeldet',
  'admin.policies_updated': 'Richtlinien geändert',
  'admin.services_updated': 'Dienst-Einstellungen geändert',
  'admin.microsoft_app_provisioned': 'Microsoft-365-App eingerichtet',
  'api.token_created': 'API-Token erstellt',
  'api.token_deleted': 'API-Token widerrufen',
  'api.webhook_created': 'Webhook angelegt',
  'account.added': 'Konto hinzugefügt',
  'account.connected': 'Konto verbunden',
  'account.admin_consent': 'Administratorzustimmung erteilt',
  'account.removed': 'Konto entfernt',
  'profile.email_changed': 'E-Mail geändert',
  'profile.session_revoked': 'Sitzung beendet',
  'profile.sessions_revoked': 'Andere Sitzungen beendet',
  'threecx.config_updated': '3CX-Anbindung geändert',
  'threecx.extension_assigned': '3CX-Nebenstelle zugeordnet',
  'threecx.auto_assigned': '3CX-Nebenstellen automatisch zugeordnet',
};

export function auditLabel(action: string): string {
  return LABELS[action] ?? action;
}

export type AuditTone = 'neutral' | 'success' | 'warning' | 'danger' | 'primary' | 'info';

export function auditTone(action: string): AuditTone {
  if (/failed|deleted|removed|disabled|revoked|reset/.test(action)) return action.includes('failed') ? 'danger' : 'warning';
  if (/created|enabled|added|connected|setup|register/.test(action)) return 'success';
  if (action.startsWith('admin.')) return 'primary';
  if (action.startsWith('api.')) return 'info';
  return 'neutral';
}

export const AUDIT_GROUPS: { value: string; label: string }[] = [
  { value: '', label: 'Alle Ereignisse' },
  { value: 'auth.', label: 'Anmeldung & 2FA' },
  { value: 'admin.', label: 'Admin-Aktionen' },
  { value: 'api.', label: 'API & Webhooks' },
  { value: 'account.', label: 'Konten' },
  { value: 'profile.', label: 'Profil' },
];
