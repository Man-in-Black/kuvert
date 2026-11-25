/**
 * Microsoft Teams: Online-Besprechungen erzeugen (Graph /me/onlineMeetings).
 */
import type { OnlineMeeting } from '@kuvert/shared';
import type { MeetingsProvider } from '../../core/providers.js';
import { escapeHtml, type GraphClient } from './graph.js';

interface GOnlineMeeting {
  joinWebUrl?: string;
  joinUrl?: string;
  subject?: string;
  startDateTime?: string;
  endDateTime?: string;
  joinMeetingIdSettings?: { joinMeetingId?: string; passcode?: string | null };
  audioConferencing?: { tollNumber?: string; conferenceId?: string } | null;
}

function formatRange(start?: string, end?: string): string {
  if (!start) return '';
  try {
    const fmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'full', timeStyle: 'short' });
    const s = new Date(start);
    const e = end ? new Date(end) : undefined;
    const sameDay = e && s.toDateString() === e.toDateString();
    const endStr = e ? (sameDay ? new Intl.DateTimeFormat('de-DE', { timeStyle: 'short' }).format(e) : fmt.format(e)) : '';
    return `${fmt.format(s)}${endStr ? ` – ${endStr}` : ''}`;
  } catch {
    return start;
  }
}

/** HTML-Block zum Einfügen in E-Mails (ähnlich Outlook-Einladung) */
export function teamsMeetingHtml(m: { joinUrl: string; subject?: string; start?: string; end?: string; meetingId?: string; passcode?: string | null; dialIn?: string }): string {
  const url = escapeHtml(m.joinUrl);
  const rows: string[] = [];
  if (m.subject) rows.push(`<div style="font-size:14px;color:#252424;margin-top:4px">${escapeHtml(m.subject)}</div>`);
  const when = formatRange(m.start, m.end);
  if (when) rows.push(`<div style="font-size:13px;color:#616161;margin-top:4px">${escapeHtml(when)}</div>`);
  const ids: string[] = [];
  if (m.meetingId) ids.push(`Besprechungs-ID: <b>${escapeHtml(m.meetingId)}</b>`);
  if (m.passcode) ids.push(`Kennung: <b>${escapeHtml(m.passcode)}</b>`);
  if (ids.length) rows.push(`<div style="font-size:13px;color:#616161;margin-top:8px">${ids.join(' &nbsp;·&nbsp; ')}</div>`);
  if (m.dialIn) rows.push(`<div style="font-size:13px;color:#616161;margin-top:4px">Telefonische Einwahl: ${escapeHtml(m.dialIn)}</div>`);
  return [
    '<div class="kuvert-meeting" data-provider="teams" style="margin:16px 0;padding:14px 0;border-top:1px solid #d1d1d1;border-bottom:1px solid #d1d1d1;font-family:\'Segoe UI\',Arial,sans-serif">',
    '<div style="font-size:20px;font-weight:600;color:#252424">Microsoft Teams-Besprechung</div>',
    `<div style="margin-top:8px"><a href="${url}" target="_blank" rel="noopener noreferrer" style="font-size:15px;font-weight:600;color:#5b5fc7;text-decoration:underline">Jetzt an der Besprechung teilnehmen</a></div>`,
    ...rows,
    '</div>',
  ].join('');
}

export class TeamsMeetingsProvider implements MeetingsProvider {
  constructor(private graph: GraphClient) {}

  async createMeeting(input: { subject: string; start: string; end: string }): Promise<OnlineMeeting> {
    const m = await this.graph.json<GOnlineMeeting>('/me/onlineMeetings', {
      method: 'POST',
      body: {
        subject: input.subject || 'Besprechung',
        startDateTime: new Date(input.start).toISOString(),
        endDateTime: new Date(input.end).toISOString(),
      },
    });
    const joinUrl = m.joinWebUrl ?? m.joinUrl;
    if (!joinUrl) throw new Error('Teams hat keinen Besprechungslink geliefert');
    return {
      joinUrl,
      subject: m.subject ?? input.subject,
      start: m.startDateTime ?? input.start,
      end: m.endDateTime ?? input.end,
      provider: 'teams',
      html: teamsMeetingHtml({
        joinUrl,
        subject: m.subject ?? input.subject,
        start: m.startDateTime ?? input.start,
        end: m.endDateTime ?? input.end,
        meetingId: m.joinMeetingIdSettings?.joinMeetingId,
        passcode: m.joinMeetingIdSettings?.passcode,
        dialIn: m.audioConferencing?.tollNumber
          ? `${m.audioConferencing.tollNumber}${m.audioConferencing.conferenceId ? `, Konferenz-ID ${m.audioConferencing.conferenceId}#` : ''}`
          : undefined,
      }),
    };
  }
}
