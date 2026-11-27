/**
 * Verfassen-Fenster: Absender, Empfänger, Editor, Signaturen, Anhänge,
 * Optionen, S/MIME, Entwürfe, Versand.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Editor } from '@tiptap/react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  Cloud,
  ExternalLink,
  FileSignature,
  FileText,
  Link2,
  Lock,
  Maximize2,
  Minimize2,
  Minus,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Quote,
  Send,
  ShieldCheck,
  Trash2,
  Type,
  Upload,
  X,
} from 'lucide-react';
import type { EmailAddress, Importance, OutgoingAttachment, OutgoingMessage, ShareLink, SmimeCertInfo, UploadInfo } from '@kuvert/shared';
import { api, errorMessage, uploadFile } from '@/lib/api';
import { useFeature, useSettings, useSignatures } from '@/lib/queries';
import { cn, escapeHtml, formatSize, isValidEmail, textToHtml } from '@/lib/utils';
import { useIsMobile } from '@/lib/useIsMobile';
import { AddressInput } from '@/components/AddressInput';
import { RichEditor } from '@/components/editor/RichEditor';
import { Badge, Button, Dropdown, IconButton, Select, useConfirm, type MenuItem } from '@/components/ui';
import { useExtensions } from '@/modules/context';
import { StoragePickerDialog, type StoragePickResult } from '@/features/files/StorageBrowser';
import type { ComposerExtensionProps, ComposeDraft } from '../extension-types';
import { attachmentUrl, mailKeys } from '../api';
import { useAllIdentities } from '../hooks';
import { MailFrame } from '../components/MailFrame';
import { AttachmentPreview, type PreviewFile } from '../components/AttachmentPreview';
import { buildMailSrcDoc, htmlToPlain } from '../sanitize';
import {
  ATTACHMENT_KEYWORDS,
  applyHtmlSignature,
  extractSignature,
  pickDefaultSignature,
  prepareInlineImages,
  rawSignatureHtml,
  stripSignature,
  wrapBody,
} from './build';
import { ScheduleDialog, TemplatesDialog } from './dialogs';
import { sendMessage } from './send';
import { closeComposer, setComposerMinimized, setComposerTitle, type ComposerAttachment, type ComposerEntry, type ComposerInit } from './store';
import { useFloatingFrame } from './useFloatingFrame';
import { notifyMailChanged, openComposeWindow } from './window';

let keyCounter = 0;
const akey = () => `a${Date.now()}-${keyCounter++}`;

const AUTOSAVE_MS = 30_000;

/**
 * variant "floating": Fenster im Hauptfenster (angedockt, verschiebbar, minimierbar);
 * variant "window": füllt ein eigenes Browserfenster (Popup) aus.
 */
export function Composer({ entry, variant = 'floating' }: { entry: ComposerEntry; variant?: 'floating' | 'window' }) {
  const init = entry.init;
  const inWindow = variant === 'window';
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const { settings } = useSettings();
  const { data: signatures = [], isFetched: sigsLoaded } = useSignatures();
  const { options: identities } = useAllIdentities();
  const smimeEnabled = useFeature('smime');
  const toolbarExt = useExtensions('composerToolbar');
  const optionExt = useExtensions('composerOptions');
  const attachSources = useExtensions('composerAttachSources');
  const { confirm, dialog: confirmDialog } = useConfirm();

  /* ───────────── Zustand ───────────── */
  const [fromKey, setFromKey] = useState<string | null>(null);
  const [to, setTo] = useState<EmailAddress[]>(init.message?.to ?? []);
  const [cc, setCc] = useState<EmailAddress[]>(init.message?.cc ?? []);
  const [bcc, setBcc] = useState<EmailAddress[]>(init.message?.bcc ?? []);
  const [showCc, setShowCc] = useState(!!init.message?.cc?.length);
  const [showBcc, setShowBcc] = useState(!!init.message?.bcc?.length);
  const [subject, setSubject] = useState(init.message?.subject ?? '');
  const [html, setHtml] = useState(init.message?.html ?? (init.message?.text ? textToHtml(init.message.text) : '<p></p>'));
  const [plainText, setPlainText] = useState(init.plainText ?? (settings.composeFormat === 'text' && init.mode === 'new' && !init.message?.html));
  const [text, setText] = useState(init.message?.text ?? '');
  const [quoteHtml, setQuoteHtml] = useState<string | undefined>(init.quoteHtml);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [rawSig, setRawSig] = useState<string | null>(init.signature?.raw ?? null);
  const [sigId, setSigId] = useState<string | null>(init.signature?.id ?? null);
  const [sigManual, setSigManual] = useState(init.signature ? init.signature.manual : !!init.skipSignature);
  const [sigApplied, setSigApplied] = useState(!!init.signature || !!init.skipSignature);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(init.attachments ?? []);
  const [importance, setImportance] = useState<Importance>(init.message?.importance ?? 'normal');
  const [readReceipt, setReadReceipt] = useState(!!init.message?.requestReadReceipt);
  const [sendAt, setSendAt] = useState<string | null>(init.message?.sendAt ?? null);
  const [smime, setSmime] = useState<{ sign: boolean; encrypt: boolean }>({
    sign: !!init.message?.smime?.sign,
    encrypt: !!init.message?.smime?.encrypt,
  });
  const [draftRef, setDraftRef] = useState(init.draftRef);
  const [draftsSupported, setDraftsSupported] = useState(true);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [cloudMode, setCloudMode] = useState<'attach' | 'link' | null>(null);
  const [attachSource, setAttachSource] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const version = useRef(init.dirty ? 1 : 0);
  const savedVersion = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const frame = useFloatingFrame(rootRef, !inWindow && !maximized && !isMobile);
  const fileInput = useRef<HTMLInputElement>(null);
  const touch = () => {
    version.current++;
  };

  /* ───────────── Absender ───────────── */
  const current = identities.find((o) => o.key === fromKey) ?? null;
  const accountId = current?.accountId ?? init.accountId ?? identities[0]?.accountId ?? '';

  useEffect(() => {
    if (fromKey || !identities.length) return;
    const addr = (init.identityAddress ?? init.message?.from?.address)?.toLowerCase();
    const pick =
      (addr && identities.find((o) => o.accountId === init.accountId && o.identity.address.toLowerCase() === addr)) ||
      (addr && identities.find((o) => o.identity.address.toLowerCase() === addr)) ||
      identities.find((o) => o.accountId === init.accountId) ||
      identities[0];
    if (pick) setFromKey(pick.key);
  }, [identities, fromKey, init]);

  /* ───────────── Signatur ───────────── */
  const sigKind: 'new' | 'reply' = init.mode === 'new' ? 'new' : 'reply';

  const applySignature = useCallback(
    (id: string | null) => {
      const sig = id ? signatures.find((s) => s.id === id) : undefined;
      setSigId(sig?.id ?? null);
      if (sig?.mode === 'raw') {
        setRawSig(sig.content);
        setHtml((h) => stripSignature(h));
      } else {
        setRawSig(null);
        setHtml((h) => applyHtmlSignature(h, sig));
      }
    },
    [signatures],
  );

  // Standardsignatur beim Öffnen und beim Absenderwechsel (solange nicht manuell gewählt)
  useEffect(() => {
    if (!sigsLoaded || !current) return;
    if (sigApplied && sigManual) return;
    const def = pickDefaultSignature(signatures, current.accountId, current.identity.address, sigKind);
    if (!sigApplied || (def?.id ?? null) !== sigId) applySignature(def?.id ?? null);
    setSigApplied(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigsLoaded, current?.key]);

  /* ───────────── Anhänge der Originalnachricht übernehmen ───────────── */
  const copied = useRef(false);
  useEffect(() => {
    if (copied.current || !init.copyAttachments) return;
    copied.current = true;
    const { ref, attachments: list } = init.copyAttachments;
    const isEdit = init.mode === 'edit';
    for (const a of list) {
      const key = akey();
      const visible = !a.inline || init.mode === 'forward';
      if (visible) setAttachments((prev) => [...prev, { key, filename: a.filename, contentType: a.contentType, size: a.size, progress: 0 }]);
      api<UploadInfo>(`/mail/accounts/${ref.accountId}/attachment-to-upload`, {
        method: 'POST',
        body: { folderId: ref.folderId, id: ref.id, attachmentId: a.id },
      })
        .then((u) => {
          if (isEdit && a.inline && a.contentId) {
            // Entwurf: Inline-Bild wieder als Upload-Bild in den Editor
            const src = `/api/uploads/${u.id}?inline=1`;
            setHtml((h) => h.split(`cid:${a.contentId}`).join(src));
            setAttachments((prev) => prev.filter((x) => x.key !== key));
            return;
          }
          const entryAtt: ComposerAttachment = {
            key,
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
            uploadId: u.id,
            inline: a.inline,
            contentId: a.contentId,
          };
          setAttachments((prev) => (prev.some((x) => x.key === key) ? prev.map((x) => (x.key === key ? entryAtt : x)) : [...prev, entryAtt]));
        })
        .catch((err) => {
          setAttachments((prev) =>
            prev.some((x) => x.key === key)
              ? prev.map((x) => (x.key === key ? { ...x, progress: undefined, error: errorMessage(err) } : x))
              : prev,
          );
        });
    }
  }, [init]);

  /* ───────────── Titel ───────────── */
  useEffect(() => setComposerTitle(entry.key, subject || 'Neue Nachricht'), [entry.key, subject]);

  /* ───────────── Nachricht zusammenbauen ───────────── */
  const from: EmailAddress = current
    ? { name: current.identity.name || current.account.name, address: current.identity.address }
    : init.message?.from ?? { address: '' };

  const baseMessage = useMemo<OutgoingMessage>(
    () => ({
      identityId: current?.identity.id,
      from,
      to,
      cc,
      bcc,
      subject,
      html,
      importance,
      requestReadReceipt: readReceipt,
      inReplyTo: init.message?.inReplyTo,
      references: init.message?.references,
      reference: init.message?.reference,
      smime: smimeEnabled && (smime.sign || smime.encrypt) ? smime : undefined,
      sendAt,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current?.key, to, cc, bcc, subject, html, importance, readReceipt, smime, sendAt, smimeEnabled],
  );

  const buildOutgoing = useCallback((): OutgoingMessage => {
    const atts: OutgoingAttachment[] = attachments
      .filter((a) => a.uploadId || a.contentBase64)
      .map(({ filename, contentType, uploadId, contentBase64, inline, contentId }) => ({ filename, contentType, uploadId, contentBase64, inline, contentId }));
    let outHtml: string | undefined;
    let outText: string | undefined;
    if (plainText) {
      const parts = [text];
      if (rawSig) parts.push(htmlToPlain(rawSignatureHtml(rawSig)));
      if (quoteHtml)
        parts.push(
          htmlToPlain(quoteHtml)
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        );
      outText = parts.filter(Boolean).join('\n\n');
    } else {
      const prepared = prepareInlineImages(html);
      atts.push(...prepared.attachments);
      outHtml = wrapBody(prepared.html) + (rawSig ? rawSignatureHtml(rawSig) : '') + (quoteHtml ?? '');
    }
    return { ...baseMessage, html: outHtml, text: outText, attachments: atts };
  }, [attachments, plainText, text, rawSig, quoteHtml, html, baseMessage]);

  const buildRef = useRef(buildOutgoing);
  buildRef.current = buildOutgoing;

  /* ───────────── Entwürfe ───────────── */
  const hasContent = () => !!(to.length || subject.trim() || htmlToPlain(stripSignature(html)).trim() || text.trim() || attachments.length);

  const saveDraft = useCallback(
    async (silent = true) => {
      if (!accountId || !draftsSupported) return;
      const v = version.current;
      setSaving(true);
      try {
        const msg = { ...buildRef.current(), sendAt: undefined };
        const res = await api<{ folderId: string; messageId: string }>(`/mail/accounts/${accountId}/drafts`, {
          method: 'POST',
          body: { message: msg, existing: draftRef },
        });
        setDraftRef(res);
        savedVersion.current = v;
        setSavedAt(new Date());
        void qc.invalidateQueries({ queryKey: mailKeys.lists });
        notifyMailChanged();
      } catch (err) {
        if ((err as { status?: number }).status === 400 || (err as { status?: number }).status === 501) setDraftsSupported(false);
        if (!silent) toast.error(`Entwurf konnte nicht gespeichert werden: ${errorMessage(err)}`);
      } finally {
        setSaving(false);
      }
    },
    [accountId, draftRef, draftsSupported, qc],
  );

  const saveRef = useRef(saveDraft);
  saveRef.current = saveDraft;
  useEffect(() => {
    const t = setInterval(() => {
      if (version.current !== savedVersion.current && !sending) void saveRef.current(true);
    }, AUTOSAVE_MS);
    return () => clearInterval(t);
  }, [sending]);

  // Konto gewechselt → alter Entwurf gehört zum anderen Konto
  const draftAccount = useRef(accountId);
  useEffect(() => {
    if (draftAccount.current && draftAccount.current !== accountId && draftRef) {
      const old = { acc: draftAccount.current, ref: draftRef };
      void api(`/mail/accounts/${old.acc}/delete`, { method: 'POST', body: { folderId: old.ref.folderId, ids: [old.ref.messageId], permanent: true } }).catch(() => undefined);
      setDraftRef(undefined);
    }
    draftAccount.current = accountId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  /* ───────────── Anhänge hochladen ───────────── */
  const addFiles = useCallback((files: File[]) => {
    for (const f of files) {
      const key = akey();
      setAttachments((prev) => [...prev, { key, filename: f.name, contentType: f.type || 'application/octet-stream', size: f.size, progress: 0 }]);
      touch();
      uploadFile(f, f.name, (pct) => setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, progress: pct } : a))))
        .then((u) =>
          setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, uploadId: u.id, contentType: u.contentType, size: u.size, progress: undefined } : a))),
        )
        .catch((err) => setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, progress: undefined, error: errorMessage(err) } : a))));
    }
  }, []);

  const onDrop = (e: DragEvent) => {
    setDragOver(false);
    if (e.defaultPrevented) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  };

  /** Datei aus einer externen Quelle (Cloud, Paperless …) anhängen: sofort mit Fortschritt anzeigen, dann laden */
  const attachExternal = async (file: { filename: string; contentType?: string; size?: number }, load: () => Promise<UploadInfo>) => {
    const key = akey();
    setAttachments((prev) => [...prev, { key, filename: file.filename, size: file.size, contentType: file.contentType, progress: 0 }]);
    touch();
    try {
      const u = await load();
      setAttachments((prev) =>
        prev.map((a) => (a.key === key ? { ...a, filename: u.filename || a.filename, uploadId: u.id, contentType: u.contentType, size: u.size, progress: undefined } : a)),
      );
    } catch (err) {
      setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, progress: undefined, error: errorMessage(err) } : a)));
    }
  };

  /** Link auf eine Datei an der Cursorposition einfügen */
  const insertFileLink = (name: string, url: string, size?: number) => {
    const htmlLink = `<p>📎 <a href="${escapeHtml(url)}">${escapeHtml(name)}</a>${size ? ` (${formatSize(size)})` : ''}</p>`;
    if (plainText) setText((t) => `${t}\n${name}: ${url}\n`);
    else if (editor && !editor.isDestroyed) editor.chain().focus().insertContent(htmlLink).run();
    touch();
  };

  const onCloudPick = async (picked: StoragePickResult[]) => {
    const mode = cloudMode;
    setCloudMode(null);
    for (const p of picked) {
      if (mode === 'attach') {
        await attachExternal({ filename: p.item.name, size: p.item.size, contentType: p.item.contentType }, () =>
          api<UploadInfo>(`/storage/accounts/${p.accountId}/attach`, { method: 'POST', body: { itemId: p.item.id } }),
        );
      } else {
        try {
          const link = await api<ShareLink>(`/storage/accounts/${p.accountId}/share`, { method: 'POST', body: { itemId: p.item.id } });
          insertFileLink(p.item.name, link.url, p.item.size);
        } catch (err) {
          toast.error(`Freigabelink fehlgeschlagen: ${errorMessage(err)}`);
        }
      }
    }
  };

  /* ───────────── S/MIME ───────────── */
  const { data: smimeCerts } = useQuery({
    queryKey: ['smime', 'certs'],
    queryFn: () => api<SmimeCertInfo[]>('/smime/certs'),
    enabled: smimeEnabled,
    staleTime: 5 * 60_000,
  });
  const canSign = !!smimeCerts?.some((c) => c.hasPrivateKey && c.email.toLowerCase() === from.address.toLowerCase());
  const recipientEmails = useMemo(() => [...to, ...cc, ...bcc].map((a) => a.address.toLowerCase()).filter(isValidEmail).sort(), [to, cc, bcc]);
  const { data: recipientCerts } = useQuery({
    queryKey: ['smime', 'recipients', recipientEmails.join(',')],
    queryFn: () => api<Record<string, boolean>>('/smime/recipients', { query: { emails: recipientEmails.join(',') } }),
    enabled: smimeEnabled && smime.encrypt && recipientEmails.length > 0,
    staleTime: 60_000,
  });
  const missingCerts = smime.encrypt && recipientCerts ? recipientEmails.filter((e) => recipientCerts[e] === false) : [];

  /* ───────────── Senden ───────────── */
  const send = async () => {
    if (!accountId || !from.address) return toast.error('Kein Absenderkonto verfügbar');
    const all = [...to, ...cc, ...bcc];
    if (!all.length) return toast.error('Bitte mindestens einen Empfänger angeben');
    const invalid = all.filter((a) => !isValidEmail(a.address));
    if (invalid.length) return toast.error(`Ungültige Adresse: ${invalid.map((a) => a.address).join(', ')}`);
    if (attachments.some((a) => a.progress !== undefined)) return toast.error('Bitte warten, bis alle Anhänge hochgeladen sind');
    if (attachments.some((a) => a.error)) return toast.error('Fehlerhafte Anhänge bitte entfernen');
    if (missingCerts.length) return toast.error(`Verschlüsselung nicht möglich – kein Zertifikat für: ${missingCerts.join(', ')}`);
    if (!subject.trim() && !(await confirm('Die Nachricht hat keinen Betreff. Trotzdem senden?'))) return;
    const bodyText = plainText ? text : htmlToPlain(stripSignature(html));
    const hasRealAttachment = attachments.some((a) => !a.inline);
    if (!hasRealAttachment && ATTACHMENT_KEYWORDS.test(bodyText) && !(await confirm('Im Text wird ein Anhang erwähnt, es ist aber keine Datei angehängt. Trotzdem senden?')))
      return;

    setSending(true);
    try {
      const msg = { ...buildOutgoing(), draftId: draftRef?.messageId, draftFolderId: draftRef?.folderId };
      await sendMessage(accountId, msg, settings.undoSendSeconds);
      closeComposer(entry.key);
      void qc.invalidateQueries({ queryKey: mailKeys.all });
      notifyMailChanged();
    } catch (err) {
      toast.error(`Senden fehlgeschlagen: ${errorMessage(err)}`);
    } finally {
      setSending(false);
    }
  };

  const discard = async () => {
    if (hasContent() && !(await confirm('Diesen Entwurf verwerfen?', { danger: true }))) return;
    if (draftRef) {
      void api(`/mail/accounts/${accountId}/delete`, { method: 'POST', body: { folderId: draftRef.folderId, ids: [draftRef.messageId], permanent: true } })
        .then(() => {
          void qc.invalidateQueries({ queryKey: mailKeys.lists });
          notifyMailChanged();
        })
        .catch(() => undefined);
    }
    closeComposer(entry.key);
  };

  const close = async () => {
    if (version.current !== savedVersion.current && hasContent() && draftsSupported) {
      await saveDraft(false);
      toast.info('Als Entwurf gespeichert');
    }
    closeComposer(entry.key);
  };

  /* ───────────── Eigenes Fenster ───────────── */
  const popOut = () => {
    if (attachments.some((a) => a.progress !== undefined)) return toast.error('Bitte warten, bis alle Anhänge hochgeladen sind');
    const snapshot: ComposerInit = {
      mode: init.mode,
      accountId: accountId || init.accountId,
      identityAddress: current?.identity.address ?? init.identityAddress,
      message: { ...baseMessage, html: plainText ? undefined : html, text: plainText ? text : undefined },
      quoteHtml,
      original: init.original,
      originalRef: init.originalRef,
      attachments: attachments.filter((a) => !a.error),
      draftRef,
      signature: { id: sigId, raw: rawSig, manual: sigManual },
      plainText,
      dirty: version.current !== savedVersion.current,
    };
    if (!openComposeWindow(snapshot)) return toast.error('Eigenes Fenster wurde vom Browser blockiert', { description: 'Bitte Popups für Kuvert erlauben.' });
    closeComposer(entry.key);
  };

  // Im Popup: Fenstertitel = Betreff, Warnung beim Schließen mit ungespeicherten Änderungen
  useEffect(() => {
    if (inWindow) document.title = `${subject || 'Neue Nachricht'} – Kuvert`;
  }, [inWindow, subject]);

  const unsavedRef = useRef<() => boolean>(() => false);
  unsavedRef.current = () => version.current !== savedVersion.current && hasContent();
  useEffect(() => {
    if (!inWindow) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!unsavedRef.current()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [inWindow]);

  /* ───────────── Modus-Wechsel Text/HTML ───────────── */
  const togglePlain = () => {
    if (!plainText) {
      setText(htmlToPlain(html));
      setPlainText(true);
    } else {
      setHtml(textToHtml(text));
      setPlainText(false);
    }
    touch();
  };

  /* ───────────── Erweiterungs-Props ───────────── */
  const draft: ComposeDraft = useMemo(
    () => ({ accountId, message: baseMessage, original: init.original, mode: init.mode }),
    [accountId, baseMessage, init.original, init.mode],
  );

  const updateMessage = useCallback((patch: Partial<OutgoingMessage>) => {
    touch();
    if (patch.subject !== undefined) setSubject(patch.subject);
    if (patch.to) setTo(patch.to);
    if (patch.cc) {
      setCc(patch.cc);
      if (patch.cc.length) setShowCc(true);
    }
    if (patch.bcc) {
      setBcc(patch.bcc);
      if (patch.bcc.length) setShowBcc(true);
    }
    if (patch.html !== undefined) setHtml(patch.html);
    if (patch.text !== undefined) setText(patch.text);
    if (patch.importance) setImportance(patch.importance);
    if (patch.requestReadReceipt !== undefined) setReadReceipt(patch.requestReadReceipt);
    if (patch.sendAt !== undefined) setSendAt(patch.sendAt);
    if (patch.smime) setSmime({ sign: !!patch.smime.sign, encrypt: !!patch.smime.encrypt });
    if (patch.attachments) setAttachments((prev) => [...prev, ...patch.attachments!.map((a) => ({ ...a, key: akey() }))]);
  }, []);

  const extProps: ComposerExtensionProps = useMemo(() => {
    const live = () => (editor && !editor.isDestroyed ? editor : null);
    return {
      editor,
      draft,
      updateMessage,
      insertHtml: (h: string) => {
        touch();
        if (plainText) setText((t) => `${t}${htmlToPlain(h)}`);
        else live()?.chain().focus().insertContent(h).run();
      },
      getSelectedText: () => {
        const ed = live();
        if (!ed || plainText) return '';
        const { from: a, to: b } = ed.state.selection;
        return a === b ? '' : ed.state.doc.textBetween(a, b, '\n');
      },
      getText: () => {
        if (plainText) return text;
        const ed = live();
        return htmlToPlain(stripSignature(ed ? ed.getHTML() : html));
      },
      getHtml: () => {
        if (plainText) return textToHtml(text);
        const ed = live();
        return stripSignature(ed ? ed.getHTML() : html);
      },
      replaceContent: (h: string, onlySelection?: boolean) => {
        touch();
        if (plainText) {
          setText(htmlToPlain(h));
          return;
        }
        const ed = live();
        if (!ed) {
          setHtml((cur) => `${h}${extractSignature(cur) ? `<p></p>${extractSignature(cur)}` : ''}`);
          return;
        }
        const { from: a, to: b } = ed.state.selection;
        if (onlySelection && a !== b) ed.chain().focus().insertContentAt({ from: a, to: b }, h).run();
        else {
          const sig = extractSignature(ed.getHTML());
          ed.commands.setContent(`${h}${sig ? `<p></p>${sig}` : ''}`, { emitUpdate: true });
        }
      },
    };
  }, [editor, draft, updateMessage, plainText, text, html]);

  /* ───────────── Darstellung ───────────── */
  const openPreview = (a: ComposerAttachment) => {
    if (!a.uploadId) return;
    const base = `/api/uploads/${a.uploadId}`;
    setPreview({
      filename: a.filename,
      contentType: a.contentType ?? 'application/octet-stream',
      size: a.size,
      url: base,
      inlineUrl: `${base}?inline=1`,
      message: { api: `/uploads/${a.uploadId}/message`, partUrl: (id, inline) => `${base}/message/attachments/${encodeURIComponent(id)}${inline ? '?inline=1' : ''}` },
    });
  };
  const visibleAttachments = attachments.filter((a) => !a.inline || init.mode === 'forward' || !a.contentId);
  const accountsCount = new Set(identities.map((o) => o.accountId)).size;

  const quoteSrcDoc = useMemo(() => {
    if (!quoteHtml || !quoteOpen) return '';
    const cidMap = new Map<string, string>();
    if (init.originalRef && init.original)
      for (const a of init.original.attachments)
        if (a.contentId) cidMap.set(a.contentId.toLowerCase(), attachmentUrl(init.originalRef, a.id, true));
    return buildMailSrcDoc(quoteHtml, { allowRemote: false, cidMap });
  }, [quoteHtml, quoteOpen, init.original, init.originalRef]);

  const rawSigSrcDoc = useMemo(() => (rawSig ? buildMailSrcDoc(rawSignatureHtml(rawSig), { allowRemote: true }) : ''), [rawSig]);

  const sigItems: MenuItem[] = [
    {
      label: 'Keine Signatur',
      onClick: () => {
        setSigManual(true);
        applySignature(null);
        touch();
      },
    },
    ...signatures.map<MenuItem>((s) => ({
      label: (
        <span className="flex items-center gap-2">
          {s.name}
          {s.mode === 'raw' && <Badge>RAW</Badge>}
          {s.id === sigId && <span className="text-primary">✓</span>}
        </span>
      ),
      onClick: () => {
        setSigManual(true);
        applySignature(s.id);
        touch();
      },
    })),
  ];

  const optionItems: MenuItem[] = [
    { label: `Wichtigkeit: hoch${importance === 'high' ? ' ✓' : ''}`, onClick: () => (setImportance(importance === 'high' ? 'normal' : 'high'), touch()) },
    { label: `Wichtigkeit: niedrig${importance === 'low' ? ' ✓' : ''}`, onClick: () => (setImportance(importance === 'low' ? 'normal' : 'low'), touch()) },
    { label: `Lesebestätigung anfordern${readReceipt ? ' ✓' : ''}`, onClick: () => (setReadReceipt(!readReceipt), touch()) },
    { divider: true, label: '' },
    { label: 'Vorlage einfügen …', icon: <FileText />, onClick: () => setTemplatesOpen(true) },
    { label: plainText ? 'In HTML-Modus wechseln' : 'Nur-Text-Modus', icon: <Type />, onClick: togglePlain },
    { divider: true, label: '' },
    { label: 'Entwurf jetzt speichern', onClick: () => void saveDraft(false), disabled: !draftsSupported },
  ];

  const toolbarExtras = toolbarExt.length ? (
    <>
      {toolbarExt.map((C, i) => (
        <Fragment key={i}>
          <C {...extProps} />
        </Fragment>
      ))}
    </>
  ) : undefined;

  const rect = frame.rect;

  return (
    <div
      ref={rootRef}
      className={cn(
        'flex flex-col overflow-hidden bg-surface',
        inWindow
          ? 'h-full w-full'
          : cn(
              'fixed z-40 border border-border shadow-2xl',
              maximized
                ? 'inset-4 rounded-xl md:inset-8'
                : rect
                  ? 'rounded-xl'
                  : 'bottom-0 right-4 h-[min(680px,92vh)] w-[min(720px,calc(100vw-2rem))] rounded-t-xl',
            ),
        frame.interacting && '[&_iframe]:pointer-events-none',
        entry.minimized && 'hidden',
      )}
      style={rect && !inWindow ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      {frame.handles}

      {/* Kopfzeile (zum Verschieben ziehen, Doppelklick dockt wieder unten rechts an) */}
      <div
        className={cn('flex select-none items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5', frame.enabled && 'cursor-move touch-none')}
        onPointerDown={frame.onDragStart}
        onDoubleClick={(e) => {
          if (frame.enabled && !(e.target as HTMLElement).closest('button')) frame.dock();
        }}
        title={frame.enabled ? 'Ziehen zum Verschieben · Doppelklick: wieder unten rechts andocken' : undefined}
      >
        <PenLine className="h-4 w-4 text-muted" />
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{subject || 'Neue Nachricht'}</div>
        {saving ? (
          <span className="text-xs text-muted">Speichert …</span>
        ) : savedAt ? (
          <span className="text-xs text-muted">Entwurf gespeichert {format(savedAt, 'HH:mm')}</span>
        ) : null}
        {!inWindow && (
          <>
            {!isMobile && (
              <IconButton label="In eigenem Fenster öffnen" size="icon-sm" onClick={popOut}>
                <ExternalLink className="h-4 w-4" />
              </IconButton>
            )}
            <IconButton label="Minimieren" size="icon-sm" onClick={() => setComposerMinimized(entry.key, true)}>
              <Minus className="h-4 w-4" />
            </IconButton>
            <IconButton label={maximized ? 'Verkleinern' : 'Maximieren'} size="icon-sm" onClick={() => setMaximized(!maximized)}>
              {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </IconButton>
          </>
        )}
        <IconButton label="Schließen (als Entwurf speichern)" size="icon-sm" onClick={() => void close()}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>

      {/* Kopffelder */}
      <div className="border-b border-border px-3 text-sm">
        <div className="flex items-center gap-2 border-b border-border/60 py-1">
          <span className="w-12 shrink-0 text-xs text-muted">Von</span>
          <Select
            value={fromKey ?? ''}
            onChange={(e) => {
              setFromKey(e.target.value);
              touch();
            }}
            className="h-8 border-transparent bg-transparent px-1 hover:border-border"
          >
            {identities.map((o) => (
              <option key={o.key} value={o.key}>
                {o.identity.name ? `${o.identity.name} <${o.identity.address}>` : o.identity.address}
                {o.identity.shared ? ' (freigegeben)' : ''}
                {accountsCount > 1 ? ` – ${o.account.name}` : ''}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-start gap-2 border-b border-border/60">
          <span className="w-12 shrink-0 pt-2.5 text-xs text-muted">An</span>
          <AddressInput
            value={to}
            onChange={(v) => {
              setTo(v);
              touch();
            }}
            autoFocus={init.mode === 'new' && !to.length}
            className="min-w-0 flex-1"
          />
          <div className="flex shrink-0 gap-1 pt-2 text-xs text-muted">
            {!showCc && (
              <button type="button" className="hover:text-fg" onClick={() => setShowCc(true)}>
                Cc
              </button>
            )}
            {!showBcc && (
              <button type="button" className="hover:text-fg" onClick={() => setShowBcc(true)}>
                Bcc
              </button>
            )}
          </div>
        </div>
        {showCc && (
          <div className="flex items-start gap-2 border-b border-border/60">
            <span className="w-12 shrink-0 pt-2.5 text-xs text-muted">Cc</span>
            <AddressInput
              value={cc}
              onChange={(v) => {
                setCc(v);
                touch();
              }}
              className="min-w-0 flex-1"
            />
          </div>
        )}
        {showBcc && (
          <div className="flex items-start gap-2 border-b border-border/60">
            <span className="w-12 shrink-0 pt-2.5 text-xs text-muted">Bcc</span>
            <AddressInput
              value={bcc}
              onChange={(v) => {
                setBcc(v);
                touch();
              }}
              className="min-w-0 flex-1"
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-xs text-muted">Betreff</span>
          <input
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              touch();
            }}
            autoFocus={init.mode === 'new' && to.length > 0}
            className="h-9 min-w-0 flex-1 bg-transparent px-1 text-sm outline-none"
            placeholder="Betreff"
          />
          {importance === 'high' && <Badge color="#dc2626">Wichtig</Badge>}
          {importance === 'low' && <Badge>Niedrige Priorität</Badge>}
          {readReceipt && <Badge>Lesebestätigung</Badge>}
        </div>
      </div>

      {/* Inhalt */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {plainText ? (
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              touch();
            }}
            className="min-h-0 flex-1 resize-none bg-surface p-4 font-mono text-sm outline-none"
            placeholder="Nachricht (Nur-Text) …"
          />
        ) : (
          <RichEditor
            value={html}
            onChange={(h) => {
              setHtml(h);
              touch();
            }}
            onEditorReady={setEditor}
            toolbarExtras={toolbarExtras}
            onFilesDropped={addFiles}
            autoFocus={init.mode !== 'new'}
            minHeight={160}
            className="min-h-0 flex-1"
          />
        )}

        {rawSig && (
          <div className="border-t border-dashed border-border px-4 py-2">
            <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted">
              <FileSignature className="h-3 w-3" /> Signatur (RAW, wird unverändert angehängt)
            </div>
            <div className="overflow-hidden rounded border border-border">
              <MailFrame srcDoc={rawSigSrcDoc} minHeight={30} maxHeight={180} title="Signatur" />
            </div>
          </div>
        )}

        {quoteHtml && (
          <div className="border-t border-border px-4 py-2">
            <div className="flex items-center gap-2 text-xs text-muted">
              <Quote className="h-3.5 w-3.5" />
              <button type="button" className="hover:text-fg" onClick={() => setQuoteOpen(!quoteOpen)}>
                {quoteOpen ? 'Zitierten Text ausblenden' : init.mode === 'forward' ? 'Weitergeleitete Nachricht anzeigen' : 'Zitierten Text anzeigen'}
              </button>
              <span className="flex-1" />
              {!plainText && (
                <button
                  type="button"
                  className="hover:text-fg"
                  title="Zitat in den Editor übernehmen, um es zu bearbeiten"
                  onClick={() => {
                    if (editor && !editor.isDestroyed) editor.chain().focus('end').insertContent(quoteHtml).run();
                    else setHtml((h) => h + quoteHtml);
                    setQuoteHtml(undefined);
                    touch();
                  }}
                >
                  Bearbeiten
                </button>
              )}
              <button
                type="button"
                className="hover:text-danger"
                onClick={() => {
                  setQuoteHtml(undefined);
                  touch();
                }}
              >
                Entfernen
              </button>
            </div>
            {quoteOpen && (
              <div className="mt-2 overflow-hidden rounded border border-border">
                <MailFrame srcDoc={quoteSrcDoc} minHeight={40} maxHeight={260} title="Zitat" />
              </div>
            )}
          </div>
        )}

        {visibleAttachments.length > 0 && (
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-auto border-t border-border px-3 py-2">
            {visibleAttachments.map((a) => (
              <span
                key={a.key}
                className={cn(
                  'relative inline-flex max-w-60 items-center gap-1.5 overflow-hidden rounded-md border px-2 py-1 text-xs',
                  a.error ? 'border-danger/50 bg-danger/10 text-danger' : 'border-border bg-surface-2',
                )}
                title={a.error}
              >
                {a.progress !== undefined && <span className="absolute inset-y-0 left-0 bg-primary/15" style={{ width: `${a.progress || 8}%` }} />}
                <button
                  type="button"
                  disabled={!a.uploadId || !!a.error}
                  onClick={() => openPreview(a)}
                  className="relative inline-flex min-w-0 items-center gap-1.5 enabled:hover:underline disabled:cursor-default"
                  title={a.error ? undefined : a.uploadId ? `${a.filename} – Vorschau anzeigen` : a.filename}
                >
                  <Paperclip className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{a.filename}</span>
                  {a.size !== undefined && <span className="shrink-0 text-muted">{formatSize(a.size)}</span>}
                </button>
                <button
                  type="button"
                  className="relative rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
                  onClick={() => {
                    setAttachments((prev) => prev.filter((x) => x.key !== a.key));
                    touch();
                  }}
                  aria-label="Anhang entfernen"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {dragOver && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary-soft/80 text-sm font-medium text-primary">
            <Upload className="mr-2 h-5 w-5" /> Dateien hier ablegen, um sie anzuhängen
          </div>
        )}
      </div>

      {/* S/MIME-Hinweis */}
      {smime.encrypt && missingCerts.length > 0 && (
        <div className="flex items-center gap-2 border-t border-border bg-warning/10 px-3 py-1.5 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5" /> Kein Zertifikat für: {missingCerts.join(', ')}
        </div>
      )}
      {sendAt && (
        <div className="flex items-center gap-2 border-t border-border bg-primary-soft px-3 py-1.5 text-xs text-primary">
          <CalendarClock className="h-3.5 w-3.5" />
          Wird gesendet am {format(new Date(sendAt), "EEEE, d. MMMM 'um' HH:mm", { locale: de })}
          <button type="button" className="ml-auto underline" onClick={() => setSendAt(null)}>
            Sofort senden
          </button>
        </div>
      )}

      {/* Fußzeile */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
        <div className="flex">
          <Button variant="primary" onClick={() => void send()} loading={sending} icon={<Send className="h-4 w-4" />} className="rounded-r-none">
            {sendAt ? 'Planen' : 'Senden'}
          </Button>
          <Dropdown
            side="top"
            trigger={
              <Button variant="primary" className="rounded-l-none border-l border-white/20 px-1.5" aria-label="Weitere Sendeoptionen">
                <ChevronDown className="h-4 w-4" />
              </Button>
            }
            items={[{ label: 'Später senden …', icon: <CalendarClock />, onClick: () => setScheduleOpen(true) }]}
          />
        </div>

        <Dropdown
          side="top"
          trigger={
            <IconButton label="Anhängen">
              <Paperclip className="h-4 w-4" />
            </IconButton>
          }
          items={[
            { label: 'Datei hochladen …', icon: <Upload />, onClick: () => fileInput.current?.click() },
            { label: 'Aus Cloud anhängen …', icon: <Cloud />, onClick: () => setCloudMode('attach') },
            { label: 'Cloud-Link einfügen …', icon: <Link2 />, onClick: () => setCloudMode('link') },
            ...attachSources.map((src) => ({ label: src.label, icon: src.icon, onClick: () => setAttachSource(src.id) })),
          ]}
        />

        <Dropdown
          side="top"
          trigger={
            <IconButton label="Signatur">
              <FileSignature className="h-4 w-4" />
            </IconButton>
          }
          items={sigItems}
        />

        {smimeEnabled && (
          <>
            <button
              type="button"
              disabled={!canSign && !smime.sign}
              title={canSign ? 'Digital signieren (S/MIME)' : 'Kein S/MIME-Zertifikat für diese Absenderadresse'}
              onClick={() => {
                setSmime((s) => ({ ...s, sign: !s.sign }));
                touch();
              }}
              className={cn(
                'inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs disabled:opacity-40',
                smime.sign ? 'bg-success/15 text-success' : 'text-muted hover:bg-hover',
              )}
            >
              <ShieldCheck className="h-4 w-4" /> Signieren
            </button>
            <button
              type="button"
              title="Verschlüsseln (S/MIME)"
              onClick={() => {
                setSmime((s) => ({ ...s, encrypt: !s.encrypt }));
                touch();
              }}
              className={cn('inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs', smime.encrypt ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-hover')}
            >
              <Lock className="h-4 w-4" /> Verschlüsseln
            </button>
          </>
        )}

        {optionExt.map((C, i) => (
          <Fragment key={i}>
            <C {...extProps} />
          </Fragment>
        ))}

        <span className="flex-1" />

        <Dropdown
          align="right"
          side="top"
          trigger={
            <IconButton label="Weitere Optionen">
              <MoreHorizontal className="h-4 w-4" />
            </IconButton>
          }
          items={optionItems}
        />
        <IconButton label="Verwerfen" onClick={() => void discard()}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          addFiles(files);
        }}
      />
      <StoragePickerDialog
        open={cloudMode !== null}
        onClose={() => setCloudMode(null)}
        mode="file"
        multiple
        title={cloudMode === 'link' ? 'Cloud-Link einfügen' : 'Aus Cloud anhängen'}
        onPick={(p) => void onCloudPick(p)}
      />
      {attachSources.map(({ id, dialog: Dialog }) => (
        <Dialog
          key={id}
          open={attachSource === id}
          onClose={() => setAttachSource(null)}
          attach={(file, load) => void attachExternal(file, load)}
          insertLink={insertFileLink}
        />
      ))}
      <ScheduleDialog
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        onPick={(iso) => {
          setSendAt(iso);
          touch();
        }}
      />
      <TemplatesDialog
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        onPick={(t) => {
          if (t.subject && !subject.trim()) setSubject(t.subject);
          extProps.insertHtml(t.html);
        }}
      />
      <AttachmentPreview file={preview} onClose={() => setPreview(null)} />
      {confirmDialog}
    </div>
  );
}
