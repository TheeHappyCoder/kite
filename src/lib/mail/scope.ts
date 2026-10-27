/**
 * Which accounts a view shows: "all", one account id, or several ids joined with "," (the same
 * string travels as `?account=`). Account ids never contain a comma.
 */
export type AccountScope = string;

export const ALL_ACCOUNTS: AccountScope = "all";

/** The ids in a scope, or null for every account. */
export function scopeIds(scope: AccountScope): string[] | null {
  return scope === ALL_ACCOUNTS ? null : scope.split(",").filter(Boolean);
}

export const inScope = (scope: AccountScope, accountId: string) => scope === ALL_ACCOUNTS || scopeIds(scope)!.includes(accountId);

/** The one account a scope shows, or null when it shows several. */
export function singleAccount(scope: AccountScope, accounts: { id: string }[] = []): string | null {
  const ids = scopeIds(scope) ?? accounts.map((a) => a.id);
  return ids.length === 1 ? ids[0] : null;
}

/** A scope for these ids, in the accounts' own order: every account (or none) is "all". */
export function makeScope(ids: string[], accounts: { id: string }[]): AccountScope {
  const chosen = accounts.filter((a) => ids.includes(a.id)).map((a) => a.id);
  return !chosen.length || chosen.length === accounts.length ? ALL_ACCOUNTS : chosen.join(",");
}

/** A scope without accounts that no longer exist. */
export const pruneScope = (scope: AccountScope, accounts: { id: string }[]) =>
  scope === ALL_ACCOUNTS ? scope : makeScope(scopeIds(scope)!, accounts);

/** A SQL filter on an account column: `1 = 1` for every account. */
export function scopeSql(scope: AccountScope, column: string): { sql: string; args: string[] } {
  const ids = scopeIds(scope);
  return ids ? { sql: `${column} IN (${ids.map(() => "?").join(", ") || "NULL"})`, args: ids } : { sql: "1 = 1", args: [] };
}
