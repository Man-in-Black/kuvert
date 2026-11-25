/**
 * Rendert ein Formular aus FieldDef[] (vom Server pro Kontotyp geliefert):
 * Gruppen-Überschriften, Pflichtfelder, Hilfetexte, bedingte Felder (showIf).
 */
import { Fragment } from 'react';
import type { FieldDef } from '@kuvert/shared';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui';

export type FormValues = Record<string, unknown>;

/** Startwerte aus Defaults und (optional) vorhandenen Werten */
export function initialValues(fields: FieldDef[] | undefined, existing?: Record<string, unknown>): FormValues {
  const v: FormValues = {};
  for (const f of fields ?? []) {
    if (f.secret) {
      v[f.key] = '';
      continue;
    }
    const cur = existing?.[f.key];
    if (cur !== undefined && cur !== null) v[f.key] = cur;
    else if (f.default !== undefined) v[f.key] = f.default;
    else v[f.key] = f.type === 'checkbox' ? false : '';
  }
  return v;
}

export function isVisible(f: FieldDef, values: FormValues): boolean {
  if (!f.showIf) return true;
  const v = values[f.showIf.key];
  return v === f.showIf.equals || String(v ?? '') === String(f.showIf.equals);
}

/** Werte für den Versand aufbereiten (Zahlen konvertieren, unsichtbare Felder weglassen) */
export function normalizeValues(fields: FieldDef[] | undefined, values: FormValues): FormValues {
  const out: FormValues = {};
  for (const f of fields ?? []) {
    if (!isVisible(f, values)) continue;
    let v = values[f.key];
    if (f.type === 'number' && v !== '' && v !== undefined && v !== null) v = Number(v);
    if (f.type === 'checkbox') v = !!v;
    out[f.key] = v;
  }
  return out;
}

export function DynamicForm({
  fields,
  values,
  onChange,
  editMode,
  disabled,
}: {
  fields: FieldDef[];
  values: FormValues;
  onChange: (values: FormValues) => void;
  /** Bearbeiten bestehender Zugangsdaten: Secret-Felder optional (leer = unverändert) */
  editMode?: boolean;
  disabled?: boolean;
}) {
  const set = (key: string, v: unknown) => onChange({ ...values, [key]: v });
  let lastGroup: string | undefined;

  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
      {fields.map((f) => {
        if (!isVisible(f, values)) return null;
        const groupHeader = f.group && f.group !== lastGroup ? f.group : undefined;
        lastGroup = f.group ?? lastGroup;
        const required = f.required && !(editMode && f.secret);
        const wide = f.type === 'textarea' || f.type === 'checkbox' || f.type === 'url';
        const v = values[f.key];
        let control: React.ReactNode;
        switch (f.type) {
          case 'checkbox':
            control = <Checkbox checked={!!v} onChange={(c) => set(f.key, c)} label={f.label} disabled={disabled} />;
            break;
          case 'select':
            control = (
              <Select value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)} required={required} disabled={disabled}>
                {!required && <option value="">–</option>}
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            );
            break;
          case 'textarea':
            control = (
              <Textarea value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} required={required} disabled={disabled} />
            );
            break;
          default:
            control = (
              <Input
                type={f.type === 'url' ? 'url' : f.type}
                value={v === undefined || v === null ? '' : String(v)}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder={editMode && f.secret ? 'Unverändert lassen' : f.placeholder}
                required={required}
                disabled={disabled}
                autoComplete={f.type === 'password' ? 'new-password' : 'off'}
              />
            );
        }
        return (
          <Fragment key={f.key}>
            {groupHeader && (
              <div className="col-span-full mt-2 border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted">{groupHeader}</div>
            )}
            {f.type === 'checkbox' ? (
              <div className="col-span-full flex flex-col gap-1">
                {control}
                {f.help && <span className="pl-6 text-xs text-muted">{f.help}</span>}
              </div>
            ) : (
              <Field
                className={wide ? 'col-span-full' : undefined}
                label={
                  <>
                    {f.label}
                    {required && <span className="text-danger"> *</span>}
                  </>
                }
                hint={f.help}
              >
                {control}
              </Field>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
