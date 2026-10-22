// Stand-in for next/headers cookies(): an in-memory jar per test, so the real
// encrypted-session code (src/backend/config/session.ts) seals / unseals it.
type Opts = Record<string, unknown>;
export const jar = new Map<string, { value: string; opts?: Opts }>();

export async function cookies() {
  return {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    getAll: () => [...jar.entries()].map(([name, v]) => ({ name, value: v.value })),
    has: (name: string) => jar.has(name),
    set: (name: string | { name: string; value: string }, value?: string, opts?: Opts) => {
      if (typeof name === "object") jar.set(name.name, { value: name.value });
      else jar.set(name, { value: value ?? "", opts });
    },
    delete: (name: string | { name: string }) => {
      jar.delete(typeof name === "string" ? name : name.name);
    },
  };
}

export async function headers() {
  return new Headers();
}
