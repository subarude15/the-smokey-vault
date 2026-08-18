export type Item = Record<string, string | number | null> & { id: number };

let adminToken = sessionStorage.getItem("smokey-token") ?? "";

export function setToken(token: string) {
  adminToken = token;
  sessionStorage.setItem("smokey-token", token);
}

export function clearToken() {
  adminToken = "";
  sessionStorage.removeItem("smokey-token");
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
      ...options.headers
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? "Request failed");
  }
  return response.status === 204 ? undefined as T : response.json();
}

export async function downloadExport(format: "db" | "json" | "csv", table?: string) {
  const response = await fetch(`/api/export?format=${format}${table ? `&table=${table}` : ""}`, {
    headers: adminToken ? { authorization: `Bearer ${adminToken}` } : {}
  });
  if (!response.ok) throw new Error("Export failed");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = format === "db" ? "smokeyvault.db" : `smokeyvault.${format}`;
  link.click();
  URL.revokeObjectURL(url);
}

export const tokenExists = () => Boolean(adminToken);
