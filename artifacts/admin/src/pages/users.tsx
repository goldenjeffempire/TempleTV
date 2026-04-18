import { useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useListAdminUsers, getListAdminUsersQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Search, Users, ChevronLeft, ChevronRight, UserCheck, UserX } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";

function formatDate(dateStr: string | Date) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function UserAvatar({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const colours = [
    "bg-violet-500",
    "bg-sky-500",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-rose-500",
    "bg-indigo-500",
  ];
  const colour = colours[name.charCodeAt(0) % colours.length];
  return (
    <div
      className={`w-9 h-9 rounded-full ${colour} flex items-center justify-center text-white text-sm font-semibold shrink-0`}
    >
      {initials}
    </div>
  );
}

export default function UsersPage() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(search, 350);

  const params = { search: debouncedSearch || undefined, page, limit: 20 };
  const { data, isLoading } = useListAdminUsers(params, {
    query: { placeholderData: keepPreviousData, queryKey: getListAdminUsersQueryKey(params) },
  });

  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Registered Users</h1>
          <p className="text-muted-foreground mt-1">
            App members who have signed up for a Temple TV account.
          </p>
        </div>
        {data && (
          <div className="flex items-center gap-2 bg-primary/10 text-primary px-4 py-2 rounded-lg border border-primary/20">
            <Users className="w-4 h-4" />
            <span className="font-semibold">{data.total.toLocaleString()}</span>
            <span className="text-sm opacity-80">total</span>
          </div>
        )}
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or email…"
                value={search}
                onChange={(e) => handleSearch(e.target.value)}
                className="pl-9"
              />
            </div>
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
          ) : !data || data.users.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
              <Users className="w-10 h-10 opacity-40" />
              <p className="text-sm">
                {search ? "No users match your search." : "No registered users yet."}
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {data.users.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center gap-4 px-6 py-4 hover:bg-muted/40 transition-colors"
                >
                  <UserAvatar name={user.displayName} />
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
            Page {data.page} of {data.totalPages} &mdash; {data.total} users
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
