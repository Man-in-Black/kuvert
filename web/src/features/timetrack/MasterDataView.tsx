/**
 * Kunden, Projekte und Tätigkeiten (für alle Benutzer gemeinsam) in drei Spalten:
 * Kunde wählen → seine Projekte, Projekt wählen → dessen Tätigkeiten plus die allgemeinen.
 * Benutzte Datensätze lassen sich nicht löschen, nur ausblenden.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, Eye, EyeOff, FolderKanban, ListChecks, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { TtActivity, TtActivityInput, TtCustomer, TtCustomerInput, TtProject, TtProjectInput } from '@kuvert/shared';
import { api, errorMessage } from '@/lib/api';
import { Badge, Button, Checkbox, ColorDot, Dropdown, Field, IconButton, Input, Modal, Select, Skeleton, Textarea, useConfirm } from '@/components/ui';
import { cn } from '@/lib/utils';
import { formatMoney, ttk, useMasterData } from './api';

type Kind = 'customers' | 'projects' | 'activities';
type Editing =
  | { kind: 'customers'; item: TtCustomer | null }
  | { kind: 'projects'; item: TtProject | null; customerId?: string }
  | { kind: 'activities'; item: TtActivity | null; projectId?: string | null };

const KIND_LABEL: Record<Kind, string> = { customers: 'Kunde', projects: 'Projekt', activities: 'Tätigkeit' };

function useMasterMutations() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ttk.master });
    void qc.invalidateQueries({ queryKey: ttk.all });
  };
  const save = useMutation({
    mutationFn: ({ kind, id, body }: { kind: Kind; id: string | null; body: TtCustomerInput | TtProjectInput | TtActivityInput }) =>
      api(`/timetrack/${kind}${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body }),
    onSuccess: done,
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: ({ kind, id }: { kind: Kind; id: string }) => api(`/timetrack/${kind}/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, v) => {
      done();
      toast.success(`${KIND_LABEL[v.kind]} gelöscht`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return { save, remove };
}

export function MasterDataView() {
  const { data, isLoading } = useMasterData();
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const { save, remove } = useMasterMutations();
  const { confirm, dialog } = useConfirm();

  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());

  const customers = useMemo(() => (data?.customers ?? []).filter((c) => (showHidden || c.visible) && match(c.name)), [data, showHidden, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const projects = useMemo(
    () => (data?.projects ?? []).filter((p) => (!customerId || p.customerId === customerId) && (showHidden || p.visible) && (customerId || match(p.name))),
    [data, customerId, showHidden, q], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const activities = useMemo(
    () => (data?.activities ?? []).filter((a) => (projectId ? a.projectId === projectId || a.projectId === null : a.projectId === null) && (showHidden || a.visible)),
    [data, projectId, showHidden],
  );
  const customerName = (id: string) => data?.customers.find((c) => c.id === id)?.name ?? '';

  if (isLoading || !data) return <Skeleton className="h-80 w-full rounded-2xl" />;

  /** Der Server übernimmt nur die bekannten Felder; der Rest des Datensatzes wird ignoriert */
  const toggleVisible = (kind: Kind, item: TtCustomer | TtProject | TtActivity) =>
    save.mutate({ kind, id: item.id, body: { ...item, visible: !item.visible } as TtCustomerInput | TtProjectInput | TtActivityInput });

  const del = async (kind: Kind, item: { id: string; name: string }) => {
    if (await confirm(`${KIND_LABEL[kind]} „${item.name}“ löschen?`, { danger: true })) remove.mutate({ kind, id: item.id });
  };

  const menu = (kind: Kind, item: TtCustomer | TtProject | TtActivity, edit: () => void) => (
    <Dropdown
      align="right"
      trigger={
        <IconButton label="Mehr" size="icon-sm" className="opacity-60 group-hover:opacity-100">
          <MoreHorizontal className="h-4 w-4" />
        </IconButton>
      }
      items={[
        { label: 'Bearbeiten', icon: <Pencil />, onClick: edit },
        { label: item.visible ? 'Ausblenden' : 'Wieder einblenden', icon: item.visible ? <EyeOff /> : <Eye />, onClick: () => toggleVisible(kind, item) },
        { divider: true, label: '' },
        { label: 'Löschen', icon: <Trash2 />, danger: true, onClick: () => void del(kind, item) },
      ]}
    />
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-64 max-w-full">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Kunde oder Projekt suchen …" className="h-8 pl-8" />
        </div>
        <Checkbox checked={showHidden} onChange={setShowHidden} label="Ausgeblendete zeigen" />
        <span className="text-xs text-muted">Kunden, Projekte und Tätigkeiten sind für alle Benutzer gemeinsam.</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Column
          icon={<Building2 />}
          title="Kunden"
          count={customers.length}
          onAdd={() => setEditing({ kind: 'customers', item: null })}
          addLabel="Kunde"
        >
          <Row active={!customerId} onClick={() => { setCustomerId(null); setProjectId(null); }}>
            <span className="text-sm text-muted">Alle Kunden</span>
          </Row>
          {customers.map((c) => (
            <Row
              key={c.id}
              active={customerId === c.id}
              hidden={!c.visible}
              onClick={() => {
                setCustomerId(c.id);
                setProjectId(null);
              }}
              menu={menu('customers', c, () => setEditing({ kind: 'customers', item: c }))}
            >
              <ColorDot color={c.color ?? undefined} />
              <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
              {c.number && <span className="text-xs text-muted">{c.number}</span>}
            </Row>
          ))}
        </Column>

        <Column
          icon={<FolderKanban />}
          title="Projekte"
          count={projects.length}
          onAdd={() => setEditing({ kind: 'projects', item: null, customerId: customerId ?? undefined })}
          addLabel="Projekt"
          addDisabled={!data.customers.length}
        >
          {projects.length === 0 && <p className="px-3 py-4 text-center text-xs text-muted">{data.customers.length ? 'Keine Projekte' : 'Zuerst einen Kunden anlegen'}</p>}
          {projects.map((p) => (
            <Row
              key={p.id}
              active={projectId === p.id}
              hidden={!p.visible}
              onClick={() => setProjectId(projectId === p.id ? null : p.id)}
              menu={menu('projects', p, () => setEditing({ kind: 'projects', item: p }))}
            >
              <ColorDot color={p.color ?? undefined} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{p.name}</div>
                {!customerId && <div className="truncate text-xs text-muted">{customerName(p.customerId)}</div>}
              </div>
              {!p.billable && <Badge tone="neutral">intern</Badge>}
            </Row>
          ))}
        </Column>

        <Column
          icon={<ListChecks />}
          title={projectId ? 'Tätigkeiten des Projekts' : 'Allgemeine Tätigkeiten'}
          count={activities.length}
          onAdd={() => setEditing({ kind: 'activities', item: null, projectId })}
          addLabel="Tätigkeit"
        >
          {activities.length === 0 && <p className="px-3 py-4 text-center text-xs text-muted">Keine Tätigkeiten</p>}
          {activities.map((a) => (
            <Row key={a.id} hidden={!a.visible} menu={menu('activities', a, () => setEditing({ kind: 'activities', item: a }))} onClick={() => setEditing({ kind: 'activities', item: a })}>
              <ColorDot color={a.color ?? undefined} />
              <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
              {a.projectId ? <Badge tone="primary">Projekt</Badge> : <Badge tone="neutral">allgemein</Badge>}
            </Row>
          ))}
        </Column>
      </div>

      {editing && <MasterEditor editing={editing} onClose={() => setEditing(null)} />}
      {dialog}
    </div>
  );
}

function Column({ icon, title, count, onAdd, addLabel, addDisabled, children }: { icon: ReactNode; title: string; count: number; onAdd: () => void; addLabel: string; addDisabled?: boolean; children: ReactNode }) {
  return (
    <section className="flex max-h-[70vh] min-h-64 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-primary [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
        <span className="flex-1 text-sm font-semibold">
          {title} <span className="font-normal text-muted">({count})</span>
        </span>
        <Button size="sm" variant="soft" icon={<Plus className="h-3.5 w-3.5" />} onClick={onAdd} disabled={addDisabled}>
          {addLabel}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{children}</div>
    </section>
  );
}

function Row({ active, hidden, onClick, menu, children }: { active?: boolean; hidden?: boolean; onClick?: () => void; menu?: ReactNode; children: ReactNode }) {
  return (
    <div className={cn('group flex items-center gap-1 rounded-lg', active ? 'bg-primary-soft' : 'hover:bg-hover', hidden && 'opacity-55')}>
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left">
        {children}
        {hidden && <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted" />}
      </button>
      {menu && <div className="pr-1">{menu}</div>}
    </div>
  );
}

/* ═════════════════════════════ Bearbeiten ═════════════════════════════ */

const COLORS = ['#2563eb', '#0891b2', '#059669', '#65a30d', '#ca8a04', '#ea580c', '#dc2626', '#db2777', '#9333ea', '#64748b'];

function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" onClick={() => onChange('')} className={cn('h-6 rounded-full border border-border px-2 text-xs text-muted', !value && 'ring-2 ring-primary')}>
        keine
      </button>
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={c}
          onClick={() => onChange(c)}
          className={cn('h-6 w-6 rounded-full ring-offset-2 ring-offset-surface', value.toLowerCase() === c && 'ring-2 ring-primary')}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}

const parseRate = (s: string): number | null => {
  const v = s.trim().replace(',', '.');
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

function MasterEditor({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const { data } = useMasterData();
  const { save } = useMasterMutations();
  const item = editing.item;
  const [name, setName] = useState(item?.name ?? '');
  const [color, setColor] = useState(item?.color ?? '');
  const [comment, setComment] = useState(item?.comment ?? '');
  const [rate, setRate] = useState(item?.hourlyRate != null ? String(item.hourlyRate).replace('.', ',') : '');
  const [visible, setVisible] = useState(item?.visible ?? true);
  // Kunde
  const cust = editing.kind === 'customers' ? editing.item : null;
  const [number, setNumber] = useState((editing.kind === 'customers' ? cust?.number : editing.kind === 'projects' ? editing.item?.number : null) ?? '');
  const [currency, setCurrency] = useState(cust?.currency ?? 'EUR');
  // Projekt
  const proj = editing.kind === 'projects' ? editing.item : null;
  const [customerId, setCustomerId] = useState(proj?.customerId ?? (editing.kind === 'projects' ? (editing.customerId ?? '') : ''));
  const [orderNumber, setOrderNumber] = useState(proj?.orderNumber ?? '');
  // Projekt/Tätigkeit
  const [billable, setBillable] = useState(editing.kind === 'customers' ? true : (editing.item?.billable ?? true));
  const act = editing.kind === 'activities' ? editing.item : null;
  const [projectId, setProjectId] = useState(act ? (act.projectId ?? '') : editing.kind === 'activities' ? (editing.projectId ?? '') : '');

  const rateValid = !rate.trim() || parseRate(rate) !== null;
  const valid = !!name.trim() && rateValid && (editing.kind !== 'projects' || !!customerId) && (editing.kind !== 'customers' || /^[A-Za-z]{3}$/.test(currency));

  const submit = () => {
    if (!valid) return;
    const common = { name: name.trim(), color: color || null, comment: comment.trim() || null, hourlyRate: parseRate(rate), visible };
    const body =
      editing.kind === 'customers'
        ? ({ ...common, number: number.trim() || null, currency: currency.toUpperCase() } satisfies TtCustomerInput)
        : editing.kind === 'projects'
          ? ({ ...common, customerId, number: number.trim() || null, orderNumber: orderNumber.trim() || null, billable } satisfies TtProjectInput)
          : ({ ...common, projectId: projectId || null, billable } satisfies TtActivityInput);
    save.mutate({ kind: editing.kind, id: item?.id ?? null, body }, { onSuccess: onClose });
  };

  const label = KIND_LABEL[editing.kind];
  return (
    <Modal
      open
      onClose={onClose}
      title={item ? `${label} bearbeiten` : `${label} anlegen`}
      description={item?.imported ? 'Aus Kimai übernommen – ein erneuter Import überschreibt Name, Farbe und Sichtbarkeit.' : undefined}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={submit} loading={save.isPending} disabled={!valid}>
            Speichern
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {editing.kind === 'projects' && (
          <Field label="Kunde">
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Kunde wählen …</option>
              {(data?.customers ?? [])
                .filter((c) => c.visible || c.id === customerId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        {editing.kind === 'activities' && (
          <Field label="Gilt für" hint="Allgemeine Tätigkeiten stehen in allen Projekten zur Auswahl.">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Alle Projekte (allgemein)</option>
              {(data?.customers ?? []).map((c) => {
                const list = (data?.projects ?? []).filter((p) => p.customerId === c.id && (p.visible || p.id === projectId));
                return list.length ? (
                  <optgroup key={c.id} label={c.name}>
                    {list.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </Select>
          </Field>
        )}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} />
        </Field>
        {(editing.kind === 'customers' || editing.kind === 'projects') && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={editing.kind === 'customers' ? 'Kundennummer' : 'Projektnummer'}>
              <Input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={100} />
            </Field>
            {editing.kind === 'customers' ? (
              <Field label="Währung">
                <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} className="uppercase" />
              </Field>
            ) : (
              <Field label="Auftragsnummer">
                <Input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} maxLength={100} />
              </Field>
            )}
          </div>
        )}
        <Field
          label="Stundensatz"
          hint={
            editing.kind === 'customers'
              ? 'Gilt, wenn Projekt und Tätigkeit keinen eigenen haben.'
              : editing.kind === 'projects'
                ? 'Leer = Stundensatz des Kunden.'
                : 'Leer = Stundensatz des Projekts bzw. Kunden.'
          }
          error={rateValid ? undefined : 'Bitte eine Zahl angeben'}
        >
          <Input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" placeholder={editing.kind === 'customers' ? `z. B. ${formatMoney(95, currency || 'EUR')}` : ''} />
        </Field>
        <Field label="Farbe">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <Field label="Kommentar">
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
        </Field>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {editing.kind !== 'customers' && <Checkbox checked={billable} onChange={setBillable} label="Abrechenbar" />}
          <Checkbox checked={visible} onChange={setVisible} label="Sichtbar (in der Auswahl anbieten)" />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
