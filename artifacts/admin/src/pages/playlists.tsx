import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { ListMusic, Plus, MoreVertical, Pencil, Trash2, Play } from "lucide-react";

interface Playlist {
  id: string;
  name: string;
  description?: string;
  videoCount?: number;
  isActive?: boolean;
  createdAt: string;
}

export default function PlaylistsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Playlist | null>(null);
  const [deleting, setDeleting] = useState<Playlist | null>(null);
  const [form, setForm] = useState({ name: "", description: "" });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["playlists"],
    queryFn: () => api.get<{ playlists: Playlist[] }>("/playlists"),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (body: typeof form) => api.post("/playlists", body),
    onSuccess: () => {
      toast.success("Playlist created");
      void qc.invalidateQueries({ queryKey: ["playlists"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      setOpen(false);
      setForm({ name: "", description: "" });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to create"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & typeof form) => api.patch(`/playlists/${id}`, body),
    onSuccess: () => {
      toast.success("Playlist updated");
      void qc.invalidateQueries({ queryKey: ["playlists"] });
      // The schedule page may reference this playlist by name — refresh so
      // a rename is reflected immediately without a manual page reload.
      void qc.invalidateQueries({ queryKey: ["schedule"] });
      // The broadcast queue may show this playlist's title — refresh so a
      // rename is visible to the operator in Master Control without a reload.
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      setEditing(null);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to update"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/playlists/${id}`),
    onSuccess: () => {
      toast.success("Playlist deleted");
      void qc.invalidateQueries({ queryKey: ["playlists"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      // A deleted playlist may appear as a schedule entry contentId — refresh
      // the schedule so operators see that the referenced content is gone.
      void qc.invalidateQueries({ queryKey: ["schedule"] });
      setDeleting(null);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to delete"),
  });

  const openEdit = (p: Playlist) => { setForm({ name: p.name, description: p.description ?? "" }); setEditing(p); };

  const playlists = data?.playlists ?? [];

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Playlists"
        description={`${playlists.length} playlists`}
        actions={
          <Button size="sm" onClick={() => { setForm({ name: "", description: "" }); setOpen(true); }} className="gap-1.5">
            <Plus size={14} /> New Playlist
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

      {isLoading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1,2,3,4,5,6].map(i => <Skeleton key={i} className="h-32" />)}
        </div>
      ) : playlists.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <ListMusic size={36} className="text-muted-foreground/20" />
          <p className="font-medium">No playlists yet</p>
          <p className="text-sm text-muted-foreground">Create your first playlist to organise content.</p>
          <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5 mt-1"><Plus size={13} /> New Playlist</Button>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {playlists.map(p => (
            <Card key={p.id} className="flex flex-col">
              <CardHeader className="pb-2 flex-row items-start justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <ListMusic size={16} className="text-primary flex-shrink-0" />
                  <CardTitle className="text-sm truncate">{p.name}</CardTitle>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7 flex-shrink-0 -mt-0.5">
                      <MoreVertical size={14} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => openEdit(p)}><Pencil size={13} className="mr-2" /> Edit</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-red-600" onClick={() => setDeleting(p)}><Trash2 size={13} className="mr-2" /> Delete</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardHeader>
              <CardContent className="pb-3 flex-1">
                {p.description && <p className="text-xs text-muted-foreground line-clamp-2">{p.description}</p>}
                <div className="flex items-center gap-2 mt-2">
                  <Badge variant="outline" className="text-[11px]">
                    <Play size={9} className="mr-1" />{p.videoCount ?? 0} videos
                  </Badge>
                  {p.isActive !== undefined && (
                    <Badge variant={p.isActive ? "default" : "secondary"} className="text-[11px]">
                      {p.isActive ? "Active" : "Inactive"}
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={open || !!editing} onOpenChange={(o) => { if (!o) { setOpen(false); setEditing(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Playlist" : "New Playlist"}</DialogTitle>
            <DialogDescription className="sr-only">{editing ? "Edit playlist details" : "Create a new playlist to organise content"}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="playlist-title">Title *</Label>
              <Input id="playlist-title" placeholder="Playlist name" value={form.name ?? ""} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="playlist-description">Description</Label>
              <Textarea id="playlist-description" rows={3} placeholder="Optional description" value={form.description ?? ""} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setOpen(false); setEditing(null); }}>Cancel</Button>
            <Button
              onClick={() => editing ? updateMutation.mutate({ id: editing.id, ...form }) : createMutation.mutate(form)}
              disabled={(editing ? updateMutation.isPending : createMutation.isPending) || !form.name.trim()}
            >
              {(editing ? updateMutation.isPending : createMutation.isPending) ? "Saving…" : editing ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete playlist?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{deleting?.name}&quot; will be permanently deleted. Videos inside will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && deleteMutation.mutate(deleting.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
