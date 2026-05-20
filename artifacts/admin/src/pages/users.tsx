import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
import { useAuth } from "@/contexts/use-auth";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Users, Search, MoreVertical, Shield, RefreshCw, AlertCircle, Trash2, Ban } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface AdminUser {
  id: string;
  email: string;
  role: string;
  displayName?: string;
  createdAt: string;
  lastSeen?: string;
}

const ROLE_COLORS: Record<string, string> = {
  system: "destructive", admin: "destructive", editor: "secondary",
  moderator: "outline", user: "outline",
};

export default function UsersPage() {
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [deletingUser, setDeletingUser] = useState<AdminUser | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["users", roleFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (roleFilter !== "all") params.set("role", roleFilter);
      return api.get<{ items: AdminUser[]; total: number }>(`/admin/users?${params}`);
    },
    enabled: isAdmin,
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) =>
      api.patch(`/admin/users/${id}/role`, { role }),
    onSuccess: (_, { role }) => {
      toast.success(`Role updated to ${role}`);
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to update role"),
  });

  const banChatMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/ban`, {}),
    onSuccess: () => { toast.success("User banned from chat"); },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to ban user"),
  });

  const deleteUserMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/${id}`),
    onSuccess: () => {
      toast.success("User deleted permanently");
      void qc.invalidateQueries({ queryKey: ["users"] });
      setDeletingUser(null);
    },
    onError: (e) => {
      toast.error(e instanceof HttpError ? e.message : "Failed to delete user");
      setDeletingUser(null);
    },
  });

  const users = data?.items ?? [];
  const filtered = users.filter(u =>
    !search || u.email.toLowerCase().includes(search.toLowerCase()) ||
    (u.displayName ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  if (!isAdmin) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[60vh] gap-3">
        <AlertCircle size={32} className="text-muted-foreground/30" />
        <p className="font-medium">Admin access required</p>
        <p className="text-sm text-muted-foreground">You don&apos;t have permission to manage users.</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Users"
        description={`${data?.total ?? 0} registered users`}
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
            <RefreshCw size={13} /> Refresh
          </Button>
        }
      />

      {error && (
        <ErrorAlert
          message={(error as Error).message}
          onRetry={() => void refetch()}
          transient={isTransientError(error)}
        />
      )}

      {/* Filters */}
      <div className="flex gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search users…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="h-8 text-sm w-36">
            <SelectValue placeholder="Filter by role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="editor">Editor</SelectItem>
            <SelectItem value="moderator">Moderator</SelectItem>
            <SelectItem value="user">User</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="divide-y">
              {[1,2,3,4,5].map(i => (
                <div key={i} className="flex items-center gap-3 p-3">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                  <Skeleton className="h-5 w-16" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <Users size={28} className="text-muted-foreground/30" />
              <p className="font-medium text-sm">{search ? "No users found" : "No users yet"}</p>
            </div>
          ) : (
            <div className="divide-y">
              {filtered.map(user => (
                <div key={user.id} className="flex items-center gap-3 px-4 py-3">
                  <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarFallback className="text-xs">
                      {(user.displayName ?? user.email).slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{user.displayName ?? user.email}</p>
                    {user.displayName && (
                      <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Joined {formatDistanceToNow(new Date(user.createdAt), { addSuffix: true })}
                    </p>
                  </div>
                  <Badge
                    variant={(ROLE_COLORS[user.role] ?? "outline") as "destructive" | "secondary" | "outline" | "default"}
                    className="capitalize flex-shrink-0 text-[11px]"
                  >
                    {user.role}
                  </Badge>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-7 w-7 flex-shrink-0">
                        <MoreVertical size={14} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Set Role
                      </p>
                      {["editor", "moderator", "user"].map(role => (
                        <DropdownMenuItem
                          key={role}
                          disabled={user.role === role || updateRoleMutation.isPending}
                          onClick={() => updateRoleMutation.mutate({ id: user.id, role })}
                          className="capitalize"
                        >
                          <Shield size={13} className="mr-2" /> Set as {role}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => banChatMutation.mutate(user.id)}
                        disabled={banChatMutation.isPending}
                        className="text-amber-600 focus:text-amber-600"
                      >
                        <Ban size={13} className="mr-2" /> Ban from chat
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setDeletingUser(user)}
                        className="text-destructive focus:text-destructive"
                        disabled={user.role === "system" || user.role === "admin"}
                      >
                        <Trash2 size={13} className="mr-2" /> Delete user…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deletingUser} onOpenChange={(open) => { if (!open) setDeletingUser(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete{" "}
              <strong>{deletingUser?.displayName ?? deletingUser?.email}</strong> and all their
              associated data (favorites, watch history). This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deletingUser && deleteUserMutation.mutate(deletingUser.id)}
              disabled={deleteUserMutation.isPending}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
