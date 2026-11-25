import type { AccountTypeInfo, ModuleInfo } from '@kuvert/shared';
import type { AccountTypeDefinition, ServerModule } from './module.js';

/** Hält alle geladenen Module und deren Kontotypen. */
export class Registry {
  readonly modules: ServerModule[] = [];
  private accountTypes = new Map<string, AccountTypeDefinition>();

  add(mod: ServerModule) {
    if (this.modules.some((m) => m.id === mod.id)) throw new Error(`Modul doppelt registriert: ${mod.id}`);
    this.modules.push(mod);
    for (const t of mod.accountTypes ?? []) {
      if (this.accountTypes.has(t.type)) throw new Error(`Kontotyp doppelt registriert: ${t.type}`);
      this.accountTypes.set(t.type, t);
    }
  }

  getAccountType(type: string): AccountTypeDefinition | undefined {
    return this.accountTypes.get(type);
  }

  listAccountTypes(): AccountTypeInfo[] {
    return [...this.accountTypes.values()].map((t) => ({
      type: t.type,
      label: t.label,
      description: t.description,
      icon: t.icon,
      capabilities: t.capabilities,
      auth: t.auth,
      configured: t.isConfigured ? t.isConfigured() : true,
      fields: t.fields,
      settingsFields: t.settingsFields,
    }));
  }

  listModules(): ModuleInfo[] {
    return this.modules.map((m) => ({ id: m.id, name: m.name, description: m.description, features: m.features }));
  }

  features(): Record<string, boolean> {
    const f: Record<string, boolean> = {};
    for (const m of this.modules) for (const feat of m.features ?? []) f[feat] = true;
    return f;
  }
}
