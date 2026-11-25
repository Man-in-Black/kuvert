/**
 * Google Meet (Meet REST API v2): Besprechungsraum anlegen und Einladungsblock liefern.
 */
import type { OnlineMeeting } from '@kuvert/shared';
import { HttpError } from '../../core/errors.js';
import type { MeetingsProvider } from '../../core/providers.js';
import { escapeHtml, type GoogleClient } from './client.js';

interface MeetSpace {
  name?: string;
  meetingUri?: string;
  meetingCode?: string;
}

export class GoogleMeetProvider implements MeetingsProvider {
  constructor(private g: GoogleClient) {}

  async createMeeting(input: { subject: string; start: string; end: string }): Promise<OnlineMeeting> {
    const space = await this.g.json<MeetSpace>('https://meet.googleapis.com/v2/spaces', { method: 'POST', body: {} });
    if (!space.meetingUri) throw new HttpError(502, 'Google Meet lieferte keinen Besprechungslink');
    const uri = escapeHtml(space.meetingUri);
    const html = [
      '<div class="kuvert-meeting" style="margin:16px 0;padding:12px 16px;border-left:4px solid #1a73e8;background:#f1f6fe;font-family:Arial,sans-serif">',
      '<p style="margin:0 0 6px 0;font-size:15px"><strong>Google Meet – Jetzt teilnehmen</strong></p>',
      `<p style="margin:0 0 6px 0"><a href="${uri}">${uri}</a></p>`,
      space.meetingCode ? `<p style="margin:0;color:#5f6368;font-size:12px">Meeting-Code: ${escapeHtml(space.meetingCode)}</p>` : '',
      '</div>',
    ].join('');
    return {
      joinUrl: space.meetingUri,
      subject: input.subject,
      start: input.start,
      end: input.end,
      html,
      provider: 'meet',
    };
  }
}
