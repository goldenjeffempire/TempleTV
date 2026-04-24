import { useState, useMemo } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useListAdminUsers, getListAdminUsersQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Search,
  Users,
  ChevronLeft,
  ChevronRight,
  UserCheck,
  UserX,
  Download,
  Loader2,
} from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { adminGet } from "@/services/adminApi";
import { useToast } from "@/hooks/use-toast";

// Local view of an admin user row. The shared client package's barrel doesn't
// re-export the AdminUser interface (only value exports from api.ts flow
// through), so we mirror the small set of fields we actually render here.
type AdminUser = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  emailVerified: boolean;
  createdAt: string | Date;
};

function formatDate(dateStr: string | Date) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function initialsFor(name: string) {
  const safe = (name ?? "").trim();
  return (
    safe
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => n[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

function avatarBg(name: string) {
  // Deterministic colour per user so the same person always gets the same tile.
  const palette = [
    "bg-violet-500",
    "bg-sky-500",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-rose-500",
    "bg-indigo-500",
  ];
  const code = (name ?? "").length > 0 ? name.charCodeAt(0) : 0;
  return palette[code % palette.length];
}

function csvEscape(v: unknown) {
  if (v == null) return "";
  let s = String(v);
  // CSV/spreadsheet formula-injection guard: a cell whose first non-whitespace
  // character is =, +, -, @, TAB, or CR can be interpreted as a formula by
  // Excel / Google Sheets / Numbers when the file is opened. Prefix with a
  // single quote so the value is always rendered as text. See OWASP "CSV
  // Injection" / CWE-1236.
  if (/^\s*[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadBlob(filename: string, content: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

type VerifiedFilter = "all" | "verified" | "unverified";

export default function UsersPage() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [verifiedFilter, setVerifiedFilter] = useState<VerifiedFilter>("all");
  const [exporting, setExporting] = useState(false);
  const debouncedSearch = useDebounce(search, 350);
  const { toast } = useToast();

  const params = { search: debouncedSearch || undefined, page, limit: 20 };
  const { data, isLoading } = useListAdminUsers(params, {
    query: { placeholderData: keepPreviousData, queryKey: getListAdminUsersQueryKey(params) },
  });

  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  // Client-side filter: the /admin/users API doesn't accept a verified flag, so
  // we filter the current page after fetch. We surface the limitation in the UI
  // (the "showing X of Y" line) so it isn't misleading when paginated.
  const visibleUsers: AdminUser[] = useMemo(() => {
    const all = Array.isArray(data?.users) ? data!.users! : [];
    if (verifiedFilter === "verified") return all.filter((u) => u.emailVerified);
    if (verifiedFilter === "unverified") return all.filter((u) => !u.emailVerified);
    return all;
  }, [data, verifiedFilter]);

  // Page through the API in 100-user chunks (server's hard cap) and download
  // the result as CSV. Honors the current search and verified filters.
  const exportCsv = async () => {
    setExporting(true);
    try {
      const searchQ = debouncedSearch ? `&search=${encodeURIComponent(debouncedSearch)}` : "";
      const all: AdminUser[] = [];
      const HARD_PAGE_CAP = 200; // safety: 200 * 100 = 20k users max per export
      let truncated = false;
      let p = 1;
      while (true) {
        if (p > HARD_PAGE_CAP) {
          truncated = true;
          break;
        }
        const chunk = await adminGet<{ users: AdminUser[]; total: number }>(
          `/admin/users?page=${p}&limit=100${searchQ}`,
        );
        if (!Array.isArray(chunk.users) || chunk.users.length === 0) break;
        all.push(...chunk.users);
        if (chunk.users.length < 100) break; // reached final page
        p++;
      }
      const filtered =
        verifiedFilter === "all"
          ? all
          : all.filter((u) =>
              verifiedFilter === "verified" ? u.emailVerified : !u.emailVerified,
            );
      const header = ["name", "email", "verified", "joined", "user_id"].join(",");
      const rows = filtered.map((u) =>
        [
          u.displayName,
          u.email,
          u.emailVerified ? "yes" : "no",
          new Date(u.createdAt).toISOString(),
          u.id,
        ]
          .map(csvEscape)
          .join(","),
      );
      const csv = [header, ...rows].join("\r\n");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      downloadBlob(`temple-tv-users-${stamp}.csv`, csv);
      if (truncated) {
        toast({
          title: `Export capped at ${all.length.toLocaleString()} rows`,
          description:
            "The user list exceeded 20,000 rows. Refine the search to narrow results before exporting again.",
          variant: "destructive",
        });
      } else {
        toast({
          title: `Exported ${filtered.length.toLocaleString()} user${filtered.length === 1 ? "" : "s"}`,
          description:
            verifiedFilter === "all" && !debouncedSearch
              ? "Full registered-user list downloaded as CSV."
              : `Filtered by ${verifiedFilter !== "all" ? verifiedFilter : "search"}. CSV downloaded.`,
        });
      }
    } catch (e) {
      toast({
        title: "Export failed",
        description: e instanceof Error ? e.message : "Could not download CSV.",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Registered Users</h1>
          <p className="text-muted-foreground mt-1">
            App members who have signed up for a Temple TV account.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {data && (
            <div className="flex items-center gap-2 bg-primary/10 text-primary px-4 py-2 rounded-lg border border-primary/20">
              <Users className="w-4 h-4" />
              <span className="font-semibold">{(data.total ?? 0).toLocaleString()}</span>
              <span className="text-sm opacity-80">total</span>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={exporting || isLoading}
          >
            {exporting ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Download className="w-4 h-4 mr-2" />
            )}
            Export CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[14rem] max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or email…"
                value={search}
                onChange={(e) => handleSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              value={verifiedFilter}
              onValueChange={(v: VerifiedFilter) => setVerifiedFilter(v)}
            >
              <SelectTrigger className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All members</SelectItem>
                <SelectItem value="verified">Verified only</SelectItem>
                <SelectItem value="unverified">Unverified only</SelectItem>
              </SelectContent>
            </Select>
            {verifiedFilter !== "all" && (
              <span className="text-xs text-muted-foreground">
                Filtering this page · use Export CSV to apply across all pages
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="divide-y">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-6 py-4">
                  <Skeleton className="w-9 h-9 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-56" />
                  </div>
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-4 w-28" />
                </div>
              ))}
            </div>
          ) : visibleUsers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
              <Users className="w-10 h-10 opacity-40" />
              <p className="text-sm">
                {search
                  ? "No users match your search."
                  : verifiedFilter !== "all"
                    ? `No ${verifiedFilter} users on this page.`
                    : "No registered users yet."}
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {visibleUsers.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center gap-4 px-6 py-4 hover:bg-muted/40 transition-colors"
                >
                  <Avatar className="w-9 h-9 shrink-0">
                    {user.avatarUrl ? (
                      <AvatarImage src={user.avatarUrl} alt={user.displayName} />
                    ) : null}
                    <AvatarFallback
                      className={`${avatarBg(user.displayName)} text-white text-sm font-semibold`}
                    >
                      {initialsFor(user.displayName)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{user.displayName}</p>
                    <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                  </div>
                  <Badge
                    variant={user.emailVerified ? "default" : "secondary"}
                    className="shrink-0 gap-1"
                  >
                    {user.emailVerified ? (
                      <UserCheck className="w-3 h-3" />
                    ) : (
                      <UserX className="w-3 h-3" />
                    )}
                    {user.emailVerified ? "Verified" : "Unverified"}
                  </Badge>
                  <p className="text-xs text-muted-foreground shrink-0 hidden sm:block">
                    Joined {formatDate(user.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {data.page} of {data.totalPages} — {data.total.toLocaleString()} users
            {verifiedFilter !== "all" && (
              <>
                {" "}
                · showing {visibleUsers.length} {verifiedFilter} on this page
              </>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="w-4 h-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
