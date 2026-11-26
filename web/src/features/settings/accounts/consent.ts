import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';

/** Zustimmungs-Link für den Administrator einer anderen Organisation in die Zwischenablage */
export async function copyConsentLink(type: string, tenant?: string | null) {
  try {
    const { url } = await api<{ url: string }>(`/accounts/oauth/${encodeURIComponent(type)}/consent-link`, { query: tenant ? { tenant } : undefined });
    await navigator.clipboard.writeText(url);
    toast.success('Zustimmungs-Link kopiert – an einen Administrator der Organisation senden');
  } catch (err) {
    toast.error(errorMessage(err));
  }
}
